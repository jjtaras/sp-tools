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
from collections import defaultdict

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


FINISH_CODE = re.compile(r"^([A-Z]{1,3}\d{1,2}[A-Z]?)\b\s*(.*)$")
# The client/shop approval stamp. Not bare "approved": legends and notes say "TO MATCH APPROVED SAMPLE".
STAMP = re.compile(r"(?i)approved by|approved as|foreman|reject|revise and|signature|print name|company")


def _finish_entries(doc):
    """The FINISHES legend -> [{'code': 'PT01', 'description': 'BM 1636 PROVIDENCE BLUE SATIN'}, ...].

    Layout on SP's title block: the codes sit in a narrow column at the left of the legend and the
    descriptions to their right, each code centred on its description (which may run two lines,
    'RIFT CUT SOLID OAK:' / 'TO MATCH APPROVED SAMPLE'). Some drawings put code and description in
    one text line ('WD02 GREY STAINED OAK WOOD VENEER'). Description lines join the nearest code.
    The legend ends at the shop-foreman approval stamp; text further left is room tags, not finishes.
    """
    for page in doc:
        lines = _lines(page)
        anchors = [l for l in lines if l[4].strip().upper() == "FINISHES"]
        if not anchors:
            continue
        hy0, hx0, hx1, hy1, _ = anchors[0]
        stops = [l[0] for l in lines if l[0] > hy1 and abs(l[1] - hx0) < 260 and STAMP.search(l[4])]
        bottom = min(stops) if stops else hy1 + 240
        codes, descs = [], []
        for ly0, lx0, lx1, ly1, text in lines:
            t = text.strip()
            if not t or ly0 <= hy1 or ly0 >= bottom or not (hx0 - 90 <= lx0 <= hx0 + 260):
                continue
            yc = (ly0 + ly1) / 2
            m = FINISH_CODE.match(t)
            if m and lx0 < hx0 - 20:  # in the code column
                codes.append({"y": yc, "code": m.group(1), "parts": [m.group(2)] if m.group(2) else []})
            elif not NOISE.match(t):
                descs.append((yc, t))
        if not codes and not descs:
            continue
        if not codes:  # a legend without codes: keep the descriptions
            return [{"code": "", "description": t} for _, t in sorted(descs)]
        for yc, t in sorted(descs):
            nearest = min(codes, key=lambda c: abs(c["y"] - yc))
            nearest["parts"].append(t)
        return [
            {"code": c["code"], "description": re.sub(r"\s+", " ", " ".join(c["parts"])).strip(" :")}
            for c in sorted(codes, key=lambda c: c["y"])
        ]
    return []


def _finishes_legend(doc):
    """{code: description} from the FINISHES legend (kept for older callers)."""
    return {e["code"] or e["description"]: e["description"] if e["code"] else "" for e in _finish_entries(doc)}


# --- The finish map ------------------------------------------------------------------------------
# Newer RECSETs carry a page that shows which surface gets which finish: elevations coloured by
# finish, a swatch key ('PT01 - BM 1636 PROVIDENCE BLUE' beside a coloured square), and often
# callouts that say it in words ('ALL INTERIORS AND FRONT EDGES TO BE PAINTED BY SP, PT01').
# Callouts are the authority; where a page has none (1516 Library), where each colour falls says
# which views carry that finish, but not which surfaces.
KEY_LABEL = re.compile(r"^([A-Z]{1,3})-?(\d{1,2}[A-Z]?)\s*[-–]\s*(.+)$")
CODE_IN_TEXT = re.compile(r"\b([A-Z]{1,3})-?(\d{2}[A-Z]?)\b")
VIEW_LABEL = re.compile(r"(?i)\b(elevation|section|plan|view|detail)\b")
SURFACES = {
    "interior": re.compile(r"(?i)\binteriors?\b"),
    "edges": re.compile(r"(?i)\bedges?\b"),
    "exterior": re.compile(r"(?i)\bexteriors?\b|\bexposed\b"),
    "faces": re.compile(r"(?i)\b(drawers?|doors?)\s+faces?\b"),  # drawer/door fronts, named apart from the case
}
CALLOUT_FINISH = re.compile(r"(?i)paint|prime|stain|lacquer|finish|clear coat|seal")


def _swatches(page, lines):
    """Key swatches -> [{'code', 'description', 'color', 'rect'}]: a filled square with a code label to its right."""
    out = []
    for dr in page.get_drawings():
        fill, r = dr.get("fill"), dr["rect"]
        if not fill or not (12 <= r.width <= 70) or abs(r.width - r.height) > 3:
            continue
        beside = [l for l in lines if 0 <= l[1] - r.x1 <= 45 and r.y0 - 6 <= (l[0] + l[3]) / 2 <= r.y1 + 6]
        if not beside:
            continue
        beside.sort(key=lambda l: l[0])
        m = KEY_LABEL.match(beside[0][4].strip())
        if not m:
            continue
        # A label can wrap: 'WD01 - RIFT WHITE OAK W/ CUSTOM' / 'STAIN MATCH CLIENT REFERENCE'.
        desc = " ".join([m.group(3)] + [l[4].strip() for l in beside[1:] if not KEY_LABEL.match(l[4].strip())])
        out.append({"code": m.group(1) + m.group(2), "description": re.sub(r"\s+", " ", desc).strip(),
                    "color": tuple(int(round(c * 255)) for c in fill[:3]), "rect": r})
    return out


def _callout_blocks(lines, exclude_x):
    """Join the drawing's text lines into callout blocks (left- or right-aligned, stacked closely)."""
    body = sorted((l for l in lines if l[1] < exclude_x and len(l[4].strip()) > 1), key=lambda l: (l[0], l[1]))
    blocks = []
    for l in body:
        h = max(l[3] - l[0], 4)
        for b in blocks:
            last = b[-1]
            aligned = abs(l[1] - last[1]) < 6 or abs(l[2] - last[2]) < 6
            if aligned and 0 <= l[0] - last[3] < h * 0.9:
                b.append(l)
                break
        else:
            blocks.append([l])
    return [" ".join(x[4].strip() for x in b) for b in blocks]


def _color_views(page, swatches, lines, exclude_x, dpi=36):
    """{code: [view labels]} for each coloured (non-grey) swatch, from where its tint shows on the page."""
    keyed = [s for s in swatches if max(s["color"]) - min(s["color"]) > 20]  # greys look like linework
    if not keyed:
        return {}
    views = [l for l in lines if VIEW_LABEL.search(l[4]) and l[1] < exclude_x and len(l[4]) < 40]
    pix = page.get_pixmap(dpi=dpi)
    scale = 72 / dpi
    samples = pix.samples
    n = pix.n
    counts = {}
    for py in range(pix.height):
        y = py * scale
        row = py * pix.stride
        for px in range(pix.width):
            x = px * scale
            if x >= exclude_x:
                break
            o = row + px * n
            e = (255 - samples[o], 255 - samples[o + 1], 255 - samples[o + 2])
            if max(e) - min(e) < 6 or max(e) > 200:  # grey/white/black: linework, not a fill
                continue
            if any(s["rect"].x0 - 2 <= x <= s["rect"].x1 + 2 and s["rect"].y0 - 2 <= y <= s["rect"].y1 + 2 for s in keyed):
                continue
            best, score = None, 0.93
            for s in keyed:
                d = tuple(255 - c for c in s["color"])
                dot = sum(a * b for a, b in zip(e, d))
                norm = (sum(a * a for a in e) * sum(b * b for b in d)) ** 0.5
                if norm and dot / norm > score:
                    best, score = s, dot / norm
            if not best:
                continue
            # The view a fill belongs to: the label below it whose left edge is nearest on its left.
            below = [v for v in views if v[0] > y and v[1] - 60 <= x]
            if not below:
                continue
            col = max(v[1] for v in below)
            view = min((v for v in below if abs(v[1] - col) < 120), key=lambda v: v[0] - y)
            key = (best["code"], view[4].strip().upper())
            counts[key] = counts.get(key, 0) + 1
    out = {}
    for (code, view), c in sorted(counts.items()):
        if c >= 25:
            out.setdefault(code, []).append(view)
    return out


def _finish_map(doc):
    """The finish-map page(s) -> {'page', 'swatches', 'callouts', 'views', 'all_views'} or None."""
    for i, page in enumerate(doc):
        lines = _lines(page)
        swatches = _swatches(page, lines)
        if len(swatches) < 2:
            continue
        # The title block (hatch key, legend, stamp) is at the right; keep the drawing body only.
        tb = [l[1] for l in lines if l[4].strip().upper() in ("HATCH KEY", "FINISHES", "PROJECT")]
        exclude_x = min(tb) - 40 if tb else page.rect.width
        callouts = []
        for text in _callout_blocks(lines, exclude_x):
            t = re.sub(r"\s+", " ", text).strip()
            if KEY_LABEL.match(t):
                continue
            codes = [a + b for a, b in CODE_IN_TEXT.findall(t)]
            surfaces = [k for k, rx in SURFACES.items() if rx.search(t)]
            if codes and (surfaces or CALLOUT_FINISH.search(t)):
                callouts.append({"text": t, "codes": codes, "surfaces": surfaces})
        all_views = sorted({l[4].strip().upper() for l in lines if VIEW_LABEL.search(l[4]) and l[1] < exclude_x and len(l[4]) < 40})
        return {
            "page": i + 1,
            "swatches": [{k: s[k] for k in ("code", "description", "color")} for s in swatches],
            "callouts": callouts,
            # Colour is the slow pass (a raster scan); only needed when no callout names a surface.
            "views": {} if any(c["surfaces"] for c in callouts) else _color_views(page, swatches, lines, exclude_x),
            "all_views": all_views,
        }
    return None


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


# Hardware schedule columns, by header text (spaces squeezed out: "COLOR / FINISH" -> "COLOR/FINISH").
HW_COLUMNS = {
    "ITEM": "item",
    "MANUFACTURER": "manufacturer",
    "DESCRIPTION": "description",
    "MODEL": "model",
    "COLOR/FINISH": "finish",
    "FINISH": "finish",
    "QTY": "qty",
    "QUANTITY": "qty",
    "CLIENTAPPROVAL": "approval",
    "NOTES": "notes",
}
HW_TITLE = re.compile(r"(?i)^HARDWARE\s+SCHEDULE\b")
# Another table further down the same sheet ends the hardware schedule.
NEXT_TABLE = re.compile(r"(?i)^(APPLIANCE|LIGHTING|PLUMBING|EQUIPMENT|ELECTRICAL)\s+SCHEDULE\b|^HATCH KEY$|^FINISHES$")
EMPTY_CELL = re.compile(r"^(-+|N/?A|Y\s*/\s*N)$", re.I)


def _hardware_tables(doc):
    """Every HARDWARE SCHEDULE table -> [{'item', 'manufacturer', 'description', 'model', 'finish', 'qty', 'notes'}].

    Read column by column. Header labels are centred over their columns while the values are
    left-aligned, so each value goes to the header whose centre is nearest its own centre. Rows are
    anchored on the ITEM column; a description that wraps onto a second line sits just above or
    below the row's centre line and joins the nearest row.
    """
    items = []
    for page in doc:
        lines = _lines(page)
        titles = [l for l in lines if HW_TITLE.match(l[4].strip())]
        for title in titles:
            ty1 = title[3]
            # Header row: the first band of column labels below the title.
            labels = []
            for l in lines:
                key = re.sub(r"\s+", "", l[4].strip().upper())
                if key in HW_COLUMNS and 0 < l[0] - ty1 < 80:
                    labels.append((l, HW_COLUMNS[key]))
            if not any(c == "description" for _, c in labels):
                continue
            hy1 = max(l[3] for l, _ in labels)
            centres = [((l[1] + l[2]) / 2, c) for l, c in labels]
            left = min(l[1] for l, _ in labels) - 120
            right = max(l[2] for l, _ in labels) + 120
            # The table ends at the next table title below it in the same columns (legends at the
            # far side of the sheet, like the HATCH KEY, sit level with the rows and don't count).
            stops = [
                l[0] for l in lines
                if l[0] > hy1 and left <= l[1] <= right
                and (NEXT_TABLE.match(l[4].strip()) or HW_TITLE.match(l[4].strip()))
            ]
            bottom = min(stops) if stops else float("inf")

            cells = []
            for ly0, lx0, lx1, ly1, text in lines:
                t = text.strip()
                if ly0 <= hy1 + 1 or ly0 >= bottom or lx1 < left or lx0 > right or not t:
                    continue
                if STAMP.search(t):
                    continue
                cx = (lx0 + lx1) / 2
                col = min(centres, key=lambda c: abs(c[0] - cx))[1]
                cells.append(((ly0 + ly1) / 2, lx0, col, t))

            anchors = sorted(y for y, _, col, t in cells if col == "item")
            qty_ys = [y for y, _, col, t in cells if col == "qty"]
            # A two-line item name: the second line has no quantity of its own, so it joins the row
            # above. Rows packed tightly together each carry a quantity and stay separate.
            merged = []
            for y in anchors:
                if merged and y - merged[-1] < 14 and not any(abs(q - y) < 4 for q in qty_ys):
                    continue
                merged.append(y)
            if not merged:
                continue
            # Drawings sometimes carry the same text twice at the same spot (a copied block); keep one.
            cells = list(dict.fromkeys((round(y), round(x), col, t) for y, x, col, t in cells))
            rows = [defaultdict(list) for _ in merged]
            for y, x, col, t in sorted(cells):
                if col == "approval" or EMPTY_CELL.match(t):
                    continue
                i = min(range(len(merged)), key=lambda k: abs(merged[k] - y))
                if abs(merged[i] - y) > 30:
                    continue
                rows[i][col].append((y, t))
            for r in rows:
                item, conflicts = {}, []
                for col, parts in r.items():
                    # Two different values printed on top of each other is a drawing error, not a
                    # wrapped line: flag it rather than pick one.
                    for (y1, t1), (y2, t2) in zip(parts, parts[1:]):
                        if abs(y1 - y2) < 3 and t1 != t2:
                            conflicts.append(f"{col}: {t1!r} and {t2!r} overprint each other")
                    item[col] = " ".join(t for _, t in parts)
                if item.get("item") or item.get("description"):
                    out = {k: item.get(k, "") for k in ("item", "manufacturer", "description", "model", "finish", "qty", "notes")}
                    if conflicts:
                        out["conflict"] = "; ".join(conflicts)
                    items.append(out)
    return items


def _hardware(doc):
    """Rows of the HARDWARE SCHEDULE table as 'cell | cell | ...' strings (kept for older callers)."""
    return [
        " | ".join(v for v in (i["item"], i["manufacturer"], i["description"], i["model"], i["finish"], i["qty"], i["notes"]) if v)
        for i in _hardware_tables(doc)
    ]


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
        "finish_entries": _finish_entries(doc),
        "finish_map": _finish_map(doc),
        "hardware_items": _hardware_tables(doc),
    }
    result["hardware"] = [
        " | ".join(v for v in (i["item"], i["manufacturer"], i["description"], i["model"], i["finish"], i["qty"], i["notes"]) if v)
        for i in result["hardware_items"]
    ]
    doc.close()
    return result


if __name__ == "__main__":
    import json
    import sys

    for p in sys.argv[1:]:
        print("=" * 70)
        print(p)
        print(json.dumps(parse(p), indent=2))
