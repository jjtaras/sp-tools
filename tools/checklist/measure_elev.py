#!/usr/bin/env python3
"""
Measure a fixture's elevation off its shop drawing.

Elevations here are open-ended - the run often dies into a wall with no
vertical drawn - so looking for a closed rectangle finds nothing. What is
always drawn is the floor line: one long horizontal under the whole run.
Its length is the elevation width. Height comes from the tallest vertical
sitting within that span, which is a case side or end panel running the
full height of the fixture.

Validated against the dimensions printed on the sheets:
    Kitchen NW   measured 277.1"   printed 276"
    Kitchen NE   measured 328.2"   printed 326"

Scale is read from the title block, never assumed. These sets mix 1:6, 1:8,
1:10 and 1:12 across pages of the same job.
"""

import argparse
import collections
import re

import pymupdf

# printed scale -> points per real inch, on a 36x24 sheet at 72 pt/in
SCALES = {
    '1":1\'':   6.0,
    '1":12"':   6.0,
    '11/2":1\'': 9.0,
    '1":8"':    9.0,
    '1":10"':   7.2,
    '1":6"':   12.0,
    '1":4"':   18.0,
    '1":2"':   36.0,
}


def read_scale(page):
    """-> (pt_per_inch or None, raw string). Title block, bottom right."""
    R = page.rect
    words = [w for w in page.get_text("words")
             if w[0] > R.x1 * 0.87 and w[1] > R.y1 * 0.90]
    words.sort(key=lambda w: (round(w[1] / 8), w[0]))
    raw = " ".join(w[4] for w in words)
    squashed = raw.replace(" ", "").upper()
    for key, val in SCALES.items():
        if key.replace(" ", "").upper() in squashed:
            return val, raw
    return None, raw


def floor_line(page, gap=40.0):
    """Longest horizontal run in the drawing area -> (length_pt, y, x0, x1)."""
    R = page.rect
    segs = []
    for item in page.get_drawings():
        r = item["rect"]
        if r.x0 < -1 or r.x1 > R.x1 * 0.87 or r.y0 < 0 or r.y1 > R.y1:
            continue
        if r.height <= 4 and r.width >= 60:
            segs.append((round(((r.y0 + r.y1) / 2) / 5), r.x0, r.x1))
    by = collections.defaultdict(list)
    for k, a, b in segs:
        by[k].append((a, b))
    best = (0.0, None)
    for k, runs in by.items():
        runs.sort()
        ca, cb = runs[0]
        for a, b in runs[1:]:
            if a <= cb + gap:
                cb = max(cb, b)
            else:
                if cb - ca > best[0]:
                    best = (cb - ca, (k * 5, ca, cb))
                ca, cb = a, b
        if cb - ca > best[0]:
            best = (cb - ca, (k * 5, ca, cb))
    return best


def height_in(page, x0, x1, y_floor):
    """Tallest vertical standing inside the run - a case side or end panel."""
    R = page.rect
    tall = 0.0
    for item in page.get_drawings():
        r = item["rect"]
        if r.width > 4 or r.height < 40:
            continue
        cx = (r.x0 + r.x1) / 2
        if cx < x0 - 5 or cx > x1 + 5:
            continue
        # must reach down to within a toe-kick of the floor line
        if r.y1 < y_floor - 60 or r.y1 > y_floor + 20:
            continue
        tall = max(tall, r.y1 - r.y0)
    return tall


def measure(path, page_no, scale=None):
    doc = pymupdf.open(path)
    page = doc[page_no - 1]
    sc, raw = read_scale(page)
    if scale:
        sc = scale
    length, info = floor_line(page)
    if not info or not sc:
        return {"page": page_no, "scale_raw": raw, "pt_per_in": sc,
                "width_in": None, "height_in": None, "sqft": None}
    y, x0, x1 = info
    h = height_in(page, x0, x1, y)
    w_in, h_in = length / sc, h / sc
    return {"page": page_no, "scale_raw": raw.strip(), "pt_per_in": sc,
            "width_in": round(w_in, 1), "height_in": round(h_in, 1),
            "sqft": round(w_in * h_in / 144.0, 1)}


if __name__ == "__main__":
    ap = argparse.ArgumentParser()
    ap.add_argument("pdf")
    ap.add_argument("--page", type=int)
    ap.add_argument("--scale", type=float)
    a = ap.parse_args()
    doc = pymupdf.open(a.pdf)
    pages = [a.page] if a.page else range(1, doc.page_count + 1)
    for p in pages:
        r = measure(a.pdf, p, a.scale)
        print(f"p{r['page']:>2}  {str(r['pt_per_in']):>5} pt/in  "
              f"w {str(r['width_in']):>7}\"  h {str(r['height_in']):>6}\"  "
              f"{str(r['sqft']):>7} sqft   [{r['scale_raw'][:40]}]")
