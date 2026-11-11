#!/usr/bin/env python3
"""
Nest CNC parts from a Studio Practice Rhino model and report a sheet count.

Reads a .3dm, groups parts by material layer, takes each part's flat footprint
(the two largest bounding-box dimensions), and packs them onto standard sheets
with a first-fit-decreasing shelf algorithm.

    python nest.py "model.3dm"
    python nest.py "model.3dm" --sheet 48x96 --kerf 0.5 --grain

Layer convention (drafting SOP): parts live under
`002_MODEL SPACE::002_MATERIAL::<name> - <thickness>`. Solid lumber is reported
separately - it is not sheet stock and does not belong in a sheet count.

Caveat on yield: this is a shelf packer, not a true nester. It gives a safe
upper bound on sheet count for rectangular parts. A real nester (or the CNC
operator's own software) will usually match it or beat it by a sheet on
irregular part mixes. It does NOT account for defects, offcut reuse across
jobs, or parts that need oversizing beyond what the model shows.
"""

import argparse
import collections
import math
import re

import rhino3dm

MATERIAL_LAYER = "002_MATERIAL"
SOLID_LUMBER = re.compile(r"(?i)solid\s*wood|poplar|maple|walnut|oak|lumber")

# Standard sheet sizes in inches, used when the layer name carries no size.
DEFAULT_SHEET = (48.0, 96.0)


EPS = 1e-6


class Sheet:
    """One sheet packed with MaxRects.

    Keeps a list of maximal free rectangles. Placing a part splits every free
    rect it overlaps, then dominated rects are pruned. This is what lets a
    leftover strip above a run of tall parts get reused by short ones - the
    thing a shelf packer structurally cannot do.
    """

    def __init__(self, width, length, kerf):
        self.width, self.length, self.kerf = width, length, kerf
        self.free = [(0.0, 0.0, width, length)]
        self.placed = []           # [(x, y, w, l, label)]

    def _find(self, w, l, allow_rotation):
        """Best short-side fit across free rects and both orientations."""
        best = None
        for x, y, fw, fl in self.free:
            for pw, pl in ({(w, l), (l, w)} if allow_rotation else {(w, l)}):
                if pw <= fw + EPS and pl <= fl + EPS:
                    leftover = min(fw - pw, fl - pl)
                    score = (leftover, max(fw - pw, fl - pl))
                    if best is None or score < best[0]:
                        best = (score, x, y, pw, pl)
        return best

    def place(self, w, l, label, allow_rotation=True):
        # Parts are padded by the kerf so saw/router clearance is real.
        k = self.kerf
        found = self._find(w + k, l + k, allow_rotation)
        if found is None:
            return False
        _, x, y, pw, pl = found
        self.placed.append((x, y, pw - k, pl - k, label))
        self._split(x, y, pw, pl)
        return True

    def _split(self, px, py, pw, pl):
        new = []
        for fx, fy, fw, fl in self.free:
            # No overlap: keep as is.
            if px >= fx + fw - EPS or px + pw <= fx + EPS or \
               py >= fy + fl - EPS or py + pl <= fy + EPS:
                new.append((fx, fy, fw, fl))
                continue
            # Split into up to four maximal remainders.
            if px > fx + EPS:
                new.append((fx, fy, px - fx, fl))
            if px + pw < fx + fw - EPS:
                new.append((px + pw, fy, fx + fw - (px + pw), fl))
            if py > fy + EPS:
                new.append((fx, fy, fw, py - fy))
            if py + pl < fy + fl - EPS:
                new.append((fx, py + pl, fw, fy + fl - (py + pl)))
        self.free = self._prune(new)

    @staticmethod
    def _prune(rects):
        out = []
        for i, a in enumerate(rects):
            if a[2] <= EPS or a[3] <= EPS:
                continue
            contained = False
            for j, b in enumerate(rects):
                if i == j or b[2] <= EPS or b[3] <= EPS:
                    continue
                if (a[0] >= b[0] - EPS and a[1] >= b[1] - EPS
                        and a[0] + a[2] <= b[0] + b[2] + EPS
                        and a[1] + a[3] <= b[1] + b[3] + EPS):
                    # Identical rects would otherwise delete each other.
                    if a == b and j > i:
                        continue
                    contained = True
                    break
            if not contained:
                out.append(a)
        return out

    @property
    def part_count(self):
        return len(self.placed)

    @property
    def used_area(self):
        return sum(w * l for _, _, w, l, _ in self.placed)


def _pack_once(parts, sheet_w, sheet_l, kerf, allow_rotation, order):
    ordered = sorted(parts, key=order)
    sheets, unplaced = [], []
    for w, l, label in ordered:
        if not any(s.place(w, l, label, allow_rotation) for s in sheets):
            sheet = Sheet(sheet_w, sheet_l, kerf)
            if sheet.place(w, l, label, allow_rotation):
                sheets.append(sheet)
            else:
                unplaced.append((w, l, label))
    return sheets, unplaced


def pack(parts, sheet_w, sheet_l, kerf, allow_rotation):
    """Try several part orderings and keep whichever uses fewest sheets.

    MaxRects is sensitive to the order parts arrive in, and the passes are
    cheap, so run them all and take the best.
    """
    orders = [
        lambda p: -(p[0] * p[1]),                 # biggest area first
        lambda p: -max(p[0], p[1]),               # longest first
        lambda p: -min(p[0], p[1]),               # widest-short-side first
        lambda p: (-max(p[0], p[1]), -min(p[0], p[1])),
        lambda p: (-min(p[0], p[1]), -max(p[0], p[1])),
    ]
    best = None
    for order in orders:
        sheets, unplaced = _pack_once(
            parts, sheet_w, sheet_l, kerf, allow_rotation, order
        )
        score = (len(unplaced), len(sheets))
        if best is None or score < best[0]:
            best = (score, sheets, unplaced)
    return best[1], best[2]


def read_parts(path):
    """-> {material_layer: [(thickness, w, l), ...]}"""
    model = rhino3dm.File3dm.Read(path)
    if model is None:
        raise SystemExit(f"Could not read {path}")
    layers = {l.Index: l.FullPath for l in model.Layers}
    out = collections.defaultdict(list)
    for obj in model.Objects:
        full = layers.get(obj.Attributes.LayerIndex, "")
        if MATERIAL_LAYER not in full:
            continue
        box = obj.Geometry.GetBoundingBox()
        if box is None:
            continue
        dims = sorted(
            [box.Max.X - box.Min.X, box.Max.Y - box.Min.Y, box.Max.Z - box.Min.Z]
        )
        thickness, w, l = dims
        if w <= 0 or l <= 0:
            continue
        out[full.split("::")[-1]].append((round(thickness, 3), round(w, 3), round(l, 3)))
    return out, str(model.Settings.ModelUnitSystem)


def main():
    ap = argparse.ArgumentParser(description=__doc__)
    ap.add_argument("model")
    ap.add_argument("--sheet", default="48x96", help='Sheet size in inches, e.g. "48x96"')
    ap.add_argument("--kerf", type=float, default=0.5, help="Spacing between parts")
    ap.add_argument(
        "--grain",
        action="store_true",
        help="Lock part orientation (grain runs the long way). Default allows rotation.",
    )
    args = ap.parse_args()

    sw, sl = (float(x) for x in args.sheet.lower().split("x"))
    by_material, units = read_parts(args.model)

    print(f"Model: {args.model}")
    print(f"Units: {units}   Sheet: {sw:g}\" x {sl:g}\"   Kerf: {args.kerf}\"   "
          f"Grain locked: {'yes' if args.grain else 'no'}")

    total_sheets = 0
    for material in sorted(by_material):
        parts = by_material[material]
        counts = collections.Counter(parts)
        footprint = sum(w * l for _, w, l in parts) / 144.0

        if SOLID_LUMBER.search(material):
            lineal = sum(l for _, w, l in parts) / 12.0
            print(f"\n{material}  -  SOLID LUMBER, not sheet stock")
            print(f"  {len(parts)} pieces, {lineal:.1f} lineal ft, {footprint:.1f} sq ft face")
            for (t, w, l), n in sorted(counts.items(), key=lambda x: -x[0][2]):
                print(f'    {n:3} x  {w:7.3f}" x {l:8.3f}"  (thk {t}")')
            continue

        flat = [(w, l, f'{w}x{l}') for _, w, l in parts]
        sheets, unplaced = pack(flat, sw, sl, args.kerf, allow_rotation=not args.grain)
        n = len(sheets)
        total_sheets += n
        yield_pct = 100.0 * footprint / (n * sw * sl / 144.0) if n else 0.0

        print(f"\n{material}")
        print(f"  {len(parts)} parts, {footprint:.1f} sq ft  ->  "
              f"{n} sheet{'s' if n != 1 else ''}   ({yield_pct:.0f}% yield)")
        for (t, w, l), c in sorted(counts.items(), key=lambda x: -x[0][1] * x[0][2]):
            print(f'    {c:3} x  {w:7.3f}" x {l:8.3f}"  (thk {t}")')
        for i, sheet in enumerate(sheets, 1):
            print(f"    sheet {i}: {sheet.part_count} parts, "
                  f"{100.0 * sheet.used_area / (sw * sl):.0f}% used")
        if unplaced:
            print(f"    !! {len(unplaced)} part(s) do not fit on a "
                  f'{sw:g}x{sl:g} sheet:')
            for w, l, _ in unplaced:
                print(f'       {w}" x {l}"')

    print(f"\nTOTAL SHEET GOODS: {total_sheets} sheets")


if __name__ == "__main__":
    main()
