#!/usr/bin/env python3
"""
Measure one fixture's cabinet area from its Rhino model, after removing the
duplicated copy that these models carry.

Some models hold the cabinetry twice: the design copy and a second
copy translated a fixed distance along X. Both copies are in assembled orientation at identical Z, so they are
not a design/nest pair - they are two working copies, one of which has been
edited. Summing the model raw double-counts the job.

The duplicate is found by shape matching rather than by assuming a gap: index
every part by (layer, y, z, dimensions), then look for the X offset that lines
up the most parts. If one offset accounts for a large share of the model, the
parts are split at the midpoint between the two copies and only one side is
kept - the side with more area, which is the more complete copy.

Reports single-face area. No doubling for two faces, no edge banding.
"""

import argparse
import collections
import json
import re

import rhino3dm

MATERIAL = re.compile(
    r'(?i)(medex|maple|ply|mdf|poplar|oak|walnut|melamine|veneer|corian|lumber)'
)
EXCLUDE = re.compile(
    r'(?i)edge\s*tape|edgetape|grain|hardware|stone|counter|appliance|'
    r'dishwasher|fridge|refriger|freezer|ice\s*maker|steel|mirror|site|'
    r'annotation|drawing|dimension|text|^op$|^0$|default|overlay|glass'
)

# A candidate offset has to line up at least this share of the smaller side
# before the model is treated as carrying a duplicate.
DUP_SUPPORT = 0.35
MIN_OFFSET = 100.0   # inches; below this it is cabinet repetition, not a copy


def read(path):
    model = rhino3dm.File3dm.Read(path)
    if model is None:
        raise SystemExit(f"could not read {path}")
    layers = {l.Index: l.FullPath for l in model.Layers}
    out = []
    for obj in model.Objects:
        leaf = layers.get(obj.Attributes.LayerIndex, "").split("::")[-1]
        if EXCLUDE.search(leaf) or not MATERIAL.search(leaf):
            continue
        b = obj.Geometry.GetBoundingBox()
        if b is None:
            continue
        dims = sorted([b.Max.X - b.Min.X, b.Max.Y - b.Min.Y, b.Max.Z - b.Min.Z])
        if dims[1] <= 0.01:
            continue
        out.append({
            "layer": leaf,
            "x": (b.Max.X + b.Min.X) / 2,
            "y": (b.Max.Y + b.Min.Y) / 2,
            "z": (b.Max.Z + b.Min.Z) / 2,
            "thk": dims[0], "w": dims[1], "l": dims[2],
            "sqft": dims[1] * dims[2] / 144.0,
        })
    return out, str(model.Settings.ModelUnitSystem)


def _shape(p):
    return (p["layer"], round(p["y"], 1), round(p["z"], 1),
            round(p["thk"], 2), round(p["w"], 1), round(p["l"], 1))


def find_duplicate_offset(parts):
    """-> (offset, support_count) for the best rigid X translation, or None."""
    idx = collections.defaultdict(list)
    for p in parts:
        idx[_shape(p)].append(p["x"])
    votes = collections.Counter()
    for p in parts:
        for ax in idx.get(_shape(p), []):
            dx = round(p["x"] - ax, 1)
            if dx >= MIN_OFFSET:
                votes[dx] += 1
    if not votes:
        return None
    dx, n = votes.most_common(1)[0]
    return dx, n


def dedupe(parts):
    """Drop the duplicated copy. -> (kept_parts, note)."""
    found = find_duplicate_offset(parts)
    if not found:
        return parts, "single copy"
    dx, n = found
    if n < DUP_SUPPORT * len(parts) / 2:
        return parts, f"no duplicate (best offset {dx}\" supports only {n} parts)"
    xs = sorted(p["x"] for p in parts)
    # Split at the widest gap that is plausibly the divide between the copies.
    gaps = sorted(((xs[i + 1] - xs[i], xs[i]) for i in range(len(xs) - 1)),
                  reverse=True)
    split = gaps[0][1] + gaps[0][0] / 2
    left = [p for p in parts if p["x"] < split]
    right = [p for p in parts if p["x"] >= split]
    if not left or not right:
        return parts, f"offset {dx}\" found but no clean split"
    la = sum(p["sqft"] for p in left)
    ra = sum(p["sqft"] for p in right)
    keep, drop = (left, right) if la >= ra else (right, left)
    return keep, (f"duplicate at {dx}\"; kept {len(keep)} parts / "
                  f"{max(la, ra):.0f} sq ft, dropped {len(drop)} / {min(la, ra):.0f}")


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("model")
    ap.add_argument("--label", default=None)
    args = ap.parse_args()

    parts, units = read(args.model)
    kept, note = dedupe(parts)

    by_layer = collections.defaultdict(lambda: [0, 0.0])
    for p in kept:
        by_layer[p["layer"]][0] += 1
        by_layer[p["layer"]][1] += p["sqft"]

    area = sum(p["sqft"] for p in kept)
    # Parts smaller than a square foot are rails, stiles, cleats, drawer sides -
    # the pieces that make a job slow relative to its size.
    small = sum(1 for p in kept if p["sqft"] < 1.0)

    print(json.dumps({
        "label": args.label or args.model,
        "model": args.model,
        "units": units,
        "raw_parts": len(parts),
        "note": note,
        "parts": len(kept),
        "sqft": round(area, 1),
        "parts_per_100sqft": round(100.0 * len(kept) / area, 1) if area else None,
        "small_parts": small,
        "small_share": round(small / len(kept), 3) if kept else None,
        "materials": len(by_layer),
        "by_layer": {k: {"parts": v[0], "sqft": round(v[1], 1)}
                     for k, v in sorted(by_layer.items(), key=lambda x: -x[1][1])},
    }))


if __name__ == "__main__":
    main()
