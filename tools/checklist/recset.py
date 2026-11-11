#!/usr/bin/env python3
"""
Parse a Studio Practice RECSET shop drawing for the checklist fields Innergy
does not carry: drafter initials, materials, hardware schedule, and finishes.

CAD text extraction is unordered, so everything here works off text position
rather than reading order.

What this CAN read reliably:
  - DRAWN BY initials from the title block
  - HATCH KEY material list
  - material / finish callouts on the drawing body
  - the HARDWARE SCHEDULE table

What it CANNOT read:
  - CNC blank cut sizes. Those come from dimension strings attached to
    geometry, not from callout text. They stay a manual entry.
"""

import re

import pymupdf

MATERIAL_WORDS = re.compile(
    r"(?i)\b(pluma\s*ply|shop\s*ply|solid\s*poplar|poplar|maple|medex|mdf|plywood|"
    r"walnut|oak|corian|veneer|melamine)\b"
)
FINISH_WORDS = re.compile(r"(?i)\b(primed|prefinished|painted|lacquer|unlacquered|stain|shop\s*primed)\b")
NOISE = re.compile(r"^[\d\s./\-]*$")

# Title-block labels we pull the neighbouring value from.
TITLE_LABELS = {
    "drawn_by": "DRAWN BY:",
    "scale": "SCALE:",
}

HARDWARE_HEADERS = {"DESCRIPTION", "MODEL", "COLOR/FINISH", "QTY", "CLIENT APPROVAL",
                    "NOTES", "ITEM", "MANUFACTURER", "HARDWARE SCHEDULE"}


def _words(page):
    """[(x0, y0, x1, y1, text)] for every word on the page."""
    return page.get_text("words")


def _lines(page):
    """Group words into visual lines -> [(y, x0, text)]."""
    out = []
    for block in page.get_text("dict")["blocks"]:
        for line in block.get("lines", []):
            text = "".join(s["text"] for s in line["spans"]).strip()
            if not text:
                continue
            x0, y0, x1, y1 = line["bbox"]
            out.append((y0, x0, x1, y1, text))
    return out


# The "DRAWN BY:" caption in the title block is outlined vector text, not
# extractable characters, so the initials cannot be found by label. They do sit
# in a stable spot on every Studio Practice RECSET though: bottom-right corner,
# on the row directly above SCALE. Verified on FX101A (NT), FX111A (NT) and
# FX111B (JH).
INITIALS = re.compile(r"^[A-Z]{1,4}$")
DRAWN_BY_BAND = (0.93, 0.98, 0.94)  # y_min%, y_max%, x_min%


def _drawn_by(doc):
    for page in doc:
        r = page.rect
        ymin, ymax, xmin = DRAWN_BY_BAND
        for ly0, lx0, lx1, ly1, text in _lines(page):
            t = text.strip()
            if not INITIALS.match(t):
                continue
            if ymin <= ly0 / r.y1 <= ymax and lx0 / r.x1 >= xmin:
                return t
    return None


def _value_right_of(lines, label, max_dy=14, max_dx=900):
    """Find a label and return the nearest text to its right on the same row."""
    label_norm = label.rstrip(":").upper()
    anchors = [l for l in lines if l[4].strip().rstrip(":").upper() == label_norm]
    if not anchors:
        return None
    y0, x0, x1, y1, _ = anchors[0]
    cy = (y0 + y1) / 2
    best, best_dx = None, None
    for ly0, lx0, lx1, ly1, text in lines:
        if text.strip().rstrip(":").upper() == label_norm:
            continue
        lcy = (ly0 + ly1) / 2
        if abs(lcy - cy) > max_dy:
            continue
        dx = lx0 - x1
        if dx < -5 or dx > max_dx:
            continue
        if best_dx is None or dx < best_dx:
            best, best_dx = text.strip(), dx
    return best


def _section_below(doc, header, max_rows=12, max_dx=260, max_gap=300):
    """Collect the text rows sitting under a header label, in reading order.

    Scoped to the single page the header appears on. Pooling lines across pages
    interleaves y-values from different sheets and silently truncates the
    section - on a 6-page RECSET that read a 5-row HATCH KEY as 2 rows.

    Rows are also cut off at `max_gap` below the header, so the next legend
    block further down the sheet is not swallowed.
    """
    for page in doc:
        lines = _lines(page)
        anchors = [l for l in lines if l[4].strip().upper() == header.upper()]
        if not anchors:
            continue
        hy0, hx0, hx1, hy1, _ = anchors[0]
        rows = []
        for ly0, lx0, lx1, ly1, text in lines:
            if ly0 <= hy1 or ly0 - hy1 > max_gap:
                continue
            if abs(lx0 - hx0) > max_dx:
                continue
            rows.append((ly0, text.strip()))
        rows.sort()
        out = []
        for _, text in rows:
            if not text or NOISE.match(text):
                continue
            if text.upper() in HARDWARE_HEADERS:
                break
            out.append(text)
            if len(out) >= max_rows:
                break
        return out
    return []


def _finishes_legend(doc):
    """The FINISHES legend, when the drawing carries one.

    Some sheets code finishes rather than calling them out on the geometry:
    `PT01  PRIMER` / `PF01  PREFINISHED MAPLE`. Returns {code: description}.
    """
    out = {}
    for page in doc:
        lines = _lines(page)
        anchors = [l for l in lines if l[4].strip().upper() == "FINISHES"]
        if not anchors:
            continue
        hy0, hx0, hx1, hy1, _ = anchors[0]
        rows = {}
        for ly0, lx0, lx1, ly1, text in lines:
            if ly0 <= hy1 or ly0 - hy1 > 300:
                continue
            if abs(lx0 - hx0) > 260:
                continue
            t = text.strip()
            if not t or NOISE.match(t):
                continue
            # The client-approval stamp sits in the same column on some sheets.
            if re.search(r"(?i)approv|reject|revise|signature|print name|company|foreman", t):
                continue
            rows.setdefault(round(ly0 / 8), []).append((lx0, t))
        for key in sorted(rows):
            cells = [t for _, t in sorted(rows[key])]
            if len(cells) >= 2:
                out[cells[0]] = " ".join(cells[1:])
            elif cells:
                out.setdefault(cells[0], "")
        if out:
            return out
    return out


def _callouts(doc):
    """Multi-line material/finish callouts from the drawing body."""
    found = []
    for page in doc:
        for ly0, lx0, lx1, ly1, text in _lines(page):
            t = text.strip()
            if len(t) < 4 or NOISE.match(t):
                continue
            if MATERIAL_WORDS.search(t) or FINISH_WORDS.search(t):
                found.append((page.number, round(ly0), round(lx0), t))
    # Stitch callouts that are stacked directly on top of each other.
    found.sort()
    merged, buf, last = [], [], None
    for pno, y, x, t in found:
        if last and pno == last[0] and abs(x - last[2]) < 12 and 0 < y - last[1] < 26:
            buf.append(t)
        else:
            if buf:
                merged.append(" ".join(buf))
            buf = [t]
        last = (pno, y, x)
    if buf:
        merged.append(" ".join(buf))
    # De-duplicate, keep order.
    seen, out = set(), []
    for m in merged:
        k = re.sub(r"\s+", " ", m).upper()
        if k not in seen:
            seen.add(k)
            out.append(re.sub(r"\s+", " ", m))
    return out


def _hardware(doc):
    """Rows of the HARDWARE SCHEDULE table -> ['(20) PINS - 1-5MM-ATQ-S, ...']."""
    for page in doc:
        lines = _lines(page)
        if not any(l[4].strip().upper() == "HARDWARE SCHEDULE" for l in lines):
            continue
        cols = {}
        for key in ("DESCRIPTION", "MODEL", "COLOR/FINISH", "QTY", "MANUFACTURER", "ITEM"):
            hits = [l for l in lines if l[4].strip().upper() == key]
            if hits:
                cols[key] = hits[0]
        if "DESCRIPTION" not in cols:
            continue
        header_y = cols["DESCRIPTION"][3]
        # Every row sits below the header band; bucket text by row centre.
        rows = {}
        for ly0, lx0, lx1, ly1, text in lines:
            if ly0 <= header_y + 2:
                continue
            t = text.strip()
            if not t or t.upper() in HARDWARE_HEADERS:
                continue
            # NOISE would eat the QTY column, so let short integers through.
            if NOISE.match(t) and not re.fullmatch(r"\d{1,4}", t):
                continue
            key = round(ly0 / 10)
            rows.setdefault(key, []).append((lx0, t))
        out = []
        for key in sorted(rows):
            cells = [t for _, t in sorted(rows[key])]
            if len(cells) < 2:
                continue
            joined = " | ".join(cells)
            if re.search(
                r"(?i)approv|reject|revise|signature|print name|company|date"
                r"|^sub\s*\d|recset|in review|hatch|finishes",
                joined,
            ):
                continue
            out.append(joined)
        if out:
            return out
    return []


def parse(path):
    doc = pymupdf.open(path)
    all_lines = [l for page in doc for l in _lines(page)]

    drawn_by = _drawn_by(doc) or _value_right_of(all_lines, TITLE_LABELS["drawn_by"])
    hatch = _section_below(doc, "HATCH KEY", max_rows=8, max_dx=200)
    finishes_legend = _finishes_legend(doc)
    callouts = _callouts(doc)

    materials = [c for c in callouts if MATERIAL_WORDS.search(c)]
    finishes = sorted({m.group(0).upper() for c in callouts for m in FINISH_WORDS.finditer(c)})

    result = {
        "drawn_by": drawn_by,
        "hatch_key": list(dict.fromkeys(h for h in hatch if MATERIAL_WORDS.search(h))),
        # Rows the hatch key lists that are not recognised materials - e.g. a
        # bare "PLY", or "HARDWARE / MOULDING". Surfaced so they are not lost.
        "hatch_key_other": [h for h in hatch if not MATERIAL_WORDS.search(h)],
        "materials_callouts": materials,
        "finish_terms": finishes,
        "finishes_legend": finishes_legend,
        "hardware": _hardware(doc),
    }
    doc.close()
    return result


if __name__ == "__main__":
    import json
    import sys

    for p in sys.argv[1:]:
        print("=" * 70)
        print(p)
        print(json.dumps(parse(p), indent=2))
