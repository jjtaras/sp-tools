#!/usr/bin/env python3
"""
Elevation take-off from the Rhino working model: no drawing scale involved.

Sheet scales can't be trusted (every view on a sheet can have its own), but the model is in real
inches. The cabinet parts (measure.read: solids on sheet-goods layers) are laid onto a 1" plan grid;
anything at least 6" deep in plan is cabinet, thinner strips are wall panelling or trim. Each
connected cabinet area is a run, measured the way the checklists always have been: run length x
height to the top of the cabinet, one face.

Checked on 104 Scullery: West 109 x 101.5 = 76.8 sf, East 105 x 101.5 = 74.0 sf, total 150.8 sf
against 147.6 sf taken off the RECSET by hand.

What it does not do yet: split an L or U run into its legs, or tell an island from a deep run.
Any area deeper than 36" is reported with `needs_review` and left out of the total; measure it by
hand. Build types are not guessed here (estimate.recommend does that).

    python elevations.py model.3dm
"""

import argparse
import json

import rhino3dm

import measure

CELL = 1.0          # inches
CORE = 6            # cells: an area must hold a CORE x CORE square to count as cabinet
MAX_DEPTH = 36.0    # inches: deeper than this is an L/U run or an island
STRAY = 300.0       # inches from the median part: parts this far away are stray copies, ignored


def _boxes(path):
    model = rhino3dm.File3dm.Read(path)
    if model is None:
        raise SystemExit(f"could not read {path}")
    layers = {l.Index: l.FullPath for l in model.Layers}
    out = []
    for obj in model.Objects:
        full = layers.get(obj.Attributes.LayerIndex, "")
        leaf = full.split("::")[-1]
        if measure.EXCLUDE.search(leaf) or not measure.MATERIAL.search(leaf) or measure.LAYOUT.search(full):
            continue
        if not isinstance(obj.Geometry, measure.SOLIDS):
            continue
        b = obj.Geometry.GetBoundingBox()
        out.append((b.Min.X, b.Max.X, b.Min.Y, b.Max.Y, b.Min.Z, b.Max.Z))
    if not out:
        return out
    mx = sorted(b[0] for b in out)[len(out) // 2]
    my = sorted(b[2] for b in out)[len(out) // 2]
    return [b for b in out if abs(b[0] - mx) < STRAY and abs(b[2] - my) < STRAY]


def runs(path):
    boxes = _boxes(path)
    if not boxes:
        return {"model": path, "runs": [], "total_sq_ft": 0.0, "warnings": ["No cabinet parts found."]}
    x0 = min(b[0] for b in boxes)
    y0 = min(b[2] for b in boxes)
    occ = set()
    for b in boxes:
        for i in range(int((b[0] - x0) / CELL), int((b[1] - x0) / CELL) + 1):
            for j in range(int((b[2] - y0) / CELL), int((b[3] - y0) / CELL) + 1):
                occ.add((i, j))
    core = set()
    for (i, j) in occ:
        if all((i + a, j + c) in occ for a in range(CORE) for c in range(CORE)):
            core.update((i + a, j + c) for a in range(CORE) for c in range(CORE))
    seen, comps = set(), []
    for c in core:
        if c in seen:
            continue
        stack, comp = [c], []
        seen.add(c)
        while stack:
            p = stack.pop()
            comp.append(p)
            for q in ((p[0] + 1, p[1]), (p[0] - 1, p[1]), (p[0], p[1] + 1), (p[0], p[1] - 1)):
                if q in core and q not in seen:
                    seen.add(q)
                    stack.append(q)
        comps.append(comp)

    out, warnings = [], []
    for comp in comps:
        xs = [p[0] for p in comp]
        ys = [p[1] for p in comp]
        bx0, bx1 = min(xs) * CELL + x0, (max(xs) + 1) * CELL + x0
        by0, by1 = min(ys) * CELL + y0, (max(ys) + 1) * CELL + y0
        inside = [b for b in boxes if bx0 <= (b[0] + b[1]) / 2 <= bx1 and by0 <= (b[2] + b[3]) / 2 <= by1]
        if not inside:
            continue
        z0, z1 = min(b[4] for b in inside), max(b[5] for b in inside)
        length, depth = max(bx1 - bx0, by1 - by0), min(bx1 - bx0, by1 - by0)
        r = {"parts": len(inside), "length_in": round(length, 1), "depth_in": round(depth, 1),
             "height_in": round(z1 - z0, 1), "sq_ft": round(length * (z1 - z0) / 144, 1),
             "axis": "Y" if by1 - by0 > bx1 - bx0 else "X"}
        if depth > MAX_DEPTH:
            r["needs_review"] = f"{depth:.0f}\" deep: an L/U run or an island. Measure by hand."
            warnings.append(f"Run of {len(inside)} parts, {length:.0f}\" x {depth:.0f}\": {r['needs_review']}")
        out.append(r)
    out.sort(key=lambda r: -r["sq_ft"])
    total = sum(r["sq_ft"] for r in out if "needs_review" not in r)
    return {"model": path, "runs": out, "total_sq_ft": round(total, 1), "warnings": warnings}


def main():
    ap = argparse.ArgumentParser(description="Elevation sq ft per cabinet run, from the Rhino model.")
    ap.add_argument("model")
    print(json.dumps(runs(ap.parse_args().model), indent=2))


if __name__ == "__main__":
    main()
