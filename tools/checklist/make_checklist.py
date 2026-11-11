#!/usr/bin/env python3
"""
Studio Practice - Production Checklist generator.

Pulls work order data from Innergy, generates the three shop-floor labor QR
codes, and fills the fillable production checklist PDF.

Usage:
    python make_checklist.py P-26-1007-011p
    python make_checklist.py P-26-1007-011p --intake intake.json
    python make_checklist.py P-26-1007-011p --out "C:/path/to/04_PRODUCTION"

Settings come from sp-tools: the repo's .env (INNERGY_API_KEY, SP_CONFIG_DIR) and SP's
$SP_CONFIG_DIR/checklist/ (settings.json, PRODUCTION_CHECKLIST_TEMPLATE.pdf). See sp_config.py.

The --intake JSON holds the fields Innergy does not carry (materials, blanks,
hardware, tools, drawn-by, VIF). See INTAKE_TEMPLATE below for the shape.
"""

import argparse
import io
import json
import os
import re
import sys
from datetime import datetime

import pymupdf
import qrcode
import requests

import sp_config
import estimate as estimating

try:
    import recset as recset_parser
except ImportError:
    recset_parser = None

HERE = os.path.dirname(os.path.abspath(__file__))
DEFAULT_TEMPLATE = sp_config.checklist_path("PRODUCTION_CHECKLIST_TEMPLATE.pdf")
SETTINGS = sp_config.settings()

# ---------------------------------------------------------------------------
# Innergy labor item GUIDs.
# Verified 2026-08-17 against the Innergy-generated work order sheet for
# P-26-1007-011p -- all five QR payloads matched /api/labors byte-for-byte.
# These are global labor categories, not per-work-order, so they are stable.
# ---------------------------------------------------------------------------
LABOR_CNC = "002 - CNC"
LABOR_FAB = "003 - FABRICATION: Wood Shop"
LABOR_FIN = "004 - Finishing"

# Which labor item's QR goes on which page of the checklist.
# Page 1 (General Info) carries the work-order-level QR instead.
PAGE_QR = {
    0: ("workorder", None),
    1: ("labor", LABOR_CNC),   # page 2 - CNC
    2: ("labor", LABOR_FAB),   # page 3 - Shop
    3: ("labor", LABOR_FIN),   # page 4 - Finish Department
}

# AcroForm field names, mapped from the template. Header fields share names
# across all four pages, so setting them once populates every page.
F_PROJECT = "102"      # Project (multiline: project name / WO number - WO name)
F_PM = "103"           # PM
F_VIF = "text01"       # VIF
F_DUE = "104"          # Due Date
F_DRAWN_BY = "105"     # Drawn By
F_ENG_SIGNOFF = "106"  # Engineering Sign Off

F_EST_CNC = "Text46"   # p1 Estimated CNC Time
F_EST_FAB = "Text45"   # p1 Estimated Fabrication Time
F_EST_FIN = "Text47"   # p1 Estimated Finishing Time

# p2 CNC
F_CNC_BLANKS = "Text30"
F_CNC_MATERIAL = ["Text31", "Text32", "Text33"]
F_CNC_TOOLS = ["Text34", "Text35", "Text36"]

# p3 Shop
F_SHOP_MATERIALS = ["Text211", "Text212", "Text213", "Text214"]
F_SHOP_HARDWARE = ["Text215", "Text216", "Text217", "Text218"]
F_SHOP_TOOLS = ["Text219", "Text2111"]
# Notes block under the Shop hours table - for substitutions, exclusions, and
# anything the shop needs told that is not a material or a piece of hardware.
F_SHOP_NOTES = ["Text2112", "Text2113", "Text2114", "Text2115", "Text2116"]

# p4 Finish Department
F_FIN_COLOR_SAMPLE = "Text21122"
F_FIN_CONTROL_SAMPLE = "Text21012"
F_FIN_INTERIOR = "Text213256"
F_FIN_EDGES = "Text2165489"
F_FIN_EXTERIOR = "65102"
F_FIN_MATERIALS = ["Text2111956235198561", "Text21459846511254"]

# House style for every person field (PM, VIF, Drawn By, Engineering Sign Off)
# is "First L." Initials get normalised through this map wherever they appear,
# so the RECSET title block and hand-typed intake values both come out right.
PEOPLE = SETTINGS["people"]   # initials -> "First L.", from SP's checklist/settings.json
DRAFTER_NAMES = PEOPLE  # kept for readability at the call site

PERSON_FIELDS = ("drawn_by", "vif", "eng_signoff")


def normalize_person(value):
    """JT -> Jeffrey T. Leaves anything already spelled out untouched."""
    if not value:
        return value
    return PEOPLE.get(value.strip().upper().rstrip("."), value)


def short_name(full):
    """Jeffrey Taras -> Jeffrey T. (house convention: First L. everywhere)."""
    parts = (full or "").split()
    if len(parts) < 2:
        return full or ""
    return f"{parts[0]} {parts[-1][0].upper()}."

# House conventions, from Jeffrey's corrections to the first generated checklists (2026-08-17).
DEFAULT_THICKNESS = '3/4"'   # every checklist to date uses 3/4" sheet stock
FINISH_DEFAULT = "SHOP PRIMED"
# One word for "nothing here", everywhere. Jeffrey's call 2026-08-17 - the
# older files mix NONE / N/A / NA and that inconsistency is what we're killing.
NONE_VALUE = "NONE"
NO_BLANKS = NONE_VALUE
NO_TOOLS = NONE_VALUE
NO_HARDWARE = NONE_VALUE

# The Material line takes sheet goods; solid lumber belongs on the Blanks line
# with cut sizes, which cannot be read off the drawing.
SHEET_GOODS = re.compile(r"(?i)\b(pluma\s*ply|shop\s*ply|plywood|mdf|medex|melamine)\b")
SOLID_LUMBER = re.compile(r"(?i)\b(solid\s*poplar|poplar|maple|walnut|oak|ash|cherry)\b")

INTAKE_TEMPLATE = {
    "due": "",
    "drawn_by": "",
    "vif": "",
    "eng_signoff": "",
    "cnc_blanks": "",
    "cnc_material": [],
    "cnc_tools": [],
    "shop_materials": [],
    "shop_hardware": [],
    "shop_tools": [],
    "shop_notes": [],
    "finish_color_sample": "",
    "finish_control_sample": "",
    "finish_interior": "",
    "finish_edges": "",
    "finish_exterior": "",
    "finish_materials": [],
}


# ---------------------------------------------------------------------------
# Innergy API
# ---------------------------------------------------------------------------
class Innergy:
    def __init__(self):
        base, key = sp_config.innergy()
        self.base = base.rstrip("/")
        self.session = requests.Session()
        self.session.headers.update({"api-key": key, "Accept": "application/json"})

    def _get(self, path, **params):
        resp = self.session.get(self.base + path, params=params, timeout=90)
        resp.raise_for_status()
        return resp.json()

    def work_order(self, number):
        """Look up a work order by its number, e.g. P-26-1007-011p."""
        data = self._get("/api/projectWorkOrders")
        for item in data.get("Items", []):
            if item.get("Number", "").lower() == number.lower():
                return item
        raise SystemExit(f"Work order {number} not found in Innergy.")

    def labor_catalog(self):
        """Global labor item catalog -> {name: LaborId}."""
        data = self._get("/api/labors")
        items = data.get("Items", data) if isinstance(data, dict) else data
        return {i["Name"]: i["LaborId"] for i in items}

    def planned_hours(self, project_number, wo_number):
        """Planned hours per labor item for one work order -> {name: hours}."""
        data = self._get("/api/workOrders/jobCosting")
        projects = data.get("Items", data) if isinstance(data, dict) else data
        for proj in projects:
            if proj.get("ProjectNumber") != project_number:
                continue
            for wo in proj.get("WorkOrders", []):
                if wo.get("Number") != wo_number:
                    continue
                out = {}
                for li in wo.get("LaborItems", []):
                    out[li["Name"]] = _duration_to_hours(li.get("PlannedHours"))
                return out
        return {}


def _duration_to_hours(value):
    """Innergy returns '05:00:00' or '1.02:27:00' (d.hh:mm:ss). -> float hours."""
    if not value:
        return 0.0
    days = 0
    if "." in value.split(":")[0]:
        days_part, value = value.split(".", 1)
        days = int(days_part)
    parts = [int(p) for p in value.split(":")]
    while len(parts) < 3:
        parts.append(0)
    h, m, s = parts[:3]
    return days * 24 + h + m / 60 + s / 3600


# ---------------------------------------------------------------------------
# QR generation
# ---------------------------------------------------------------------------
def qr_png(payload, px=600):
    """Innergy scan token -> PNG bytes."""
    qr = qrcode.QRCode(
        error_correction=qrcode.constants.ERROR_CORRECT_M, box_size=10, border=2
    )
    qr.add_data(payload)
    qr.make(fit=True)
    img = qr.make_image(fill_color="black", back_color="white").convert("RGB")
    img = img.resize((px, px), 0)  # NEAREST - keep module edges crisp
    buf = io.BytesIO()
    img.save(buf, "PNG")
    return buf.getvalue()


def labor_payload(labor_id, wo_id):
    return f"`#laborItem;{labor_id};projectWorkOrder;{wo_id}`"


def workorder_payload(wo_id):
    return f"`#projectWorkOrder;{wo_id}`"


# ---------------------------------------------------------------------------
# PDF filling
# ---------------------------------------------------------------------------
FONT_FLOOR = 6.0     # below this the shop cannot read it
FIELD_PADDING = 6.0  # widget border + inset

# Groups of fields that read as a single block on the page. Every line in a
# group is set to the same font size so the block looks like one list.
FIELD_GROUPS = [
    F_CNC_MATERIAL,
    F_CNC_TOOLS,
    F_SHOP_MATERIALS,
    F_SHOP_HARDWARE,
    F_SHOP_TOOLS,
    F_SHOP_NOTES,
    F_FIN_MATERIALS,
]


def _fit_fontsize(text, widget):
    """Shrink the font until the value fits the widget, or return None.

    Character count is a bad proxy - Helvetica is proportional, so a MEDEX line
    of 84 narrow characters fits a 538pt field while an 82-character hardware
    line at 555pt overflows and gets silently clipped. Measure instead.
    """
    if "\n" in text:
        return None
    size = widget.text_fontsize or 12.0
    usable = widget.rect.width - FIELD_PADDING
    if pymupdf.get_text_length(text, fontname="helv", fontsize=size) <= usable:
        return None
    while size > FONT_FLOOR:
        size -= 0.5
        if pymupdf.get_text_length(text, fontname="helv", fontsize=size) <= usable:
            return size
    return FONT_FLOOR


def _flatten_single_kid_text_fields(doc):
    """Make each one-widget text field a plain field, so a font size set on it reaches the page.

    In the template, Text211 (Materials row 1), Text2116 (a shop-notes row) and Text36 (a CNC tools
    row) are a parent field holding the name and the 12 pt font, with one widget under it.
    pymupdf can't change the size of such a widget (setting it, or copying the parent's DA onto
    it, still drew 12 pt), so the first Materials row clipped while the rows under it shrank.
    Moving the parent's keys onto the widget fixes it. Fields shown on every page (project, PM,
    due date...) have several widgets and are left alone; so are non-text fields such as the QR
    image buttons, whose names the QR placement depends on. Done in memory: the template on
    SP's Drive is untouched.
    """
    cat = doc.pdf_catalog()
    flattened = []
    for page in doc:
        for w in page.widgets():
            kind, parent = doc.xref_get_key(w.xref, "Parent")
            if kind != "xref":
                continue
            px = int(parent.split()[0])
            if doc.xref_get_key(px, "FT")[1] != "/Tx":
                continue
            if len(re.findall(r"\d+ 0 R", doc.xref_get_key(px, "Kids")[1])) != 1:
                continue
            for key in ("T", "FT", "DA", "Q", "V", "DV", "Ff", "MaxLen"):
                k, v = doc.xref_get_key(px, key)
                if k != "null" and doc.xref_get_key(w.xref, key)[0] == "null":
                    doc.xref_set_key(w.xref, key, pymupdf.get_pdf_str(v) if k == "string" else v)
            doc.xref_set_key(w.xref, "Parent", "null")
            flattened.append((px, w.xref))
    if flattened:
        kind, fields = doc.xref_get_key(cat, "AcroForm/Fields")
        for px, kx in flattened:
            fields = re.sub(rf"\b{px} 0 R", f"{kx} 0 R", fields)
        doc.xref_set_key(cat, "AcroForm/Fields", fields)
    return flattened


def fill_checklist(template, out_path, values, qr_payloads):
    doc = pymupdf.open(template)

    _flatten_single_kid_text_fields(doc)

    # Pass 1: work out the size each populated field needs on its own.
    fitted = {}
    for page in doc:
        for widget in page.widgets():
            name = widget.field_name
            if name in values and values[name] not in (None, ""):
                size = _fit_fontsize(str(values[name]), widget)
                fitted[name] = size if size is not None else (widget.text_fontsize or 12.0)

    # A block of lines that reads as one list should look like one list, so
    # every line in a group drops to the smallest size any line in it needs.
    # Sizing line by line left the Hardware block at 12 / 11.5 / 9 / 8.5.
    for group in FIELD_GROUPS:
        sizes = [fitted[f] for f in group if f in fitted]
        if len(sizes) > 1:
            uniform = min(sizes)
            for f in group:
                if f in fitted:
                    fitted[f] = uniform

    # Pass 2: write the values at the agreed sizes.
    filled = set()
    overflow = []
    for page in doc:
        for widget in page.widgets():
            name = widget.field_name
            if name in values and values[name] not in (None, ""):
                text = str(values[name])
                if name in fitted:
                    widget.text_fontsize = fitted[name]
                    if fitted[name] <= FONT_FLOOR:
                        overflow.append((name, text))
                widget.field_value = text
                widget.update()
                filled.add(name)

    # Replace the placeholder image-button widgets with the real QR codes.
    for pno, page in enumerate(doc):
        payload = qr_payloads.get(pno)
        if not payload:
            continue
        target = None
        for widget in page.widgets():
            if widget.field_name and widget.field_name.startswith("Image1_af_image"):
                target = widget
                break
        if target is None:
            continue
        rect = target.rect
        # The widget box is taller than it is wide; keep the QR square and centred.
        side = min(rect.width, rect.height)
        cx, cy = (rect.x0 + rect.x1) / 2, (rect.y0 + rect.y1) / 2
        box = pymupdf.Rect(cx - side / 2, cy - side / 2, cx + side / 2, cy + side / 2)
        # Drop the placeholder widget so no empty grey box shows through.
        try:
            page.delete_widget(target)
        except Exception:
            pass
        page.insert_image(box, stream=qr_png(payload))

    doc.save(out_path, garbage=3, deflate=True)
    doc.close()
    return filled, overflow


# ---------------------------------------------------------------------------
# Assembly
# ---------------------------------------------------------------------------
def _fmt_date(iso):
    if not iso:
        return ""
    d = datetime.strptime(iso[:10], "%Y-%m-%d")
    return f"{d.month}/{d.day}/{d.strftime('%y')}"


def _fmt_hours(h):
    if h is None or h == "":
        return ""
    return f"{h:g} hrs"


def _spread(field_names, lines):
    """Map a list of strings onto a list of field names.

    The template has a fixed number of rows per block, so handing in more
    lines than there are fields silently loses the extras - a note about
    hardware that never reaches the floor. Fail loudly instead.
    """
    lines = lines or []
    if len(lines) > len(field_names):
        raise SystemExit(
            f"{len(lines)} lines given for a {len(field_names)}-row block; "
            f"the template cannot hold them. Dropped: {lines[len(field_names):]}"
        )
    return dict(zip(field_names, lines))


def safe_filename(text):
    return re.sub(r'[<>:"/\\|?*]', "_", text).strip()


def _title(text):
    """PLUMA PLY CLOSET LINER -> Pluma Ply Closet Liner, but keep (5), 3/4"."""
    out = []
    for word in text.split():
        if re.search(r"\d", word) or len(word) <= 2:
            out.append(word)
        else:
            out.append(word.capitalize())
    return " ".join(out)


PACK_FONT = 9.0   # try to fit a packed block at this size first; _fit_fontsize can still shrink to FONT_FLOOR
_field_widths = {}


def _usable_width(field_names):
    """Narrowest usable width (pt) of a block of template fields, measured off the template."""
    if not _field_widths:
        with pymupdf.open(DEFAULT_TEMPLATE) as doc:
            for page in doc:
                for w in page.widgets() or []:
                    _field_widths[w.field_name] = w.rect.width - FIELD_PADDING
    return min(_field_widths.get(f, 400.0) for f in field_names)


def _text_width(text, size):
    return pymupdf.get_text_length(text, fontname="helv", fontsize=size)


def _wrap(groups, width, size):
    """Lay [(header, [part, ...])] onto rows: parts of a group joined with ', ', groups with '; '.

    A group too long for one row carries on to the next with its header repeated, so a long
    HAFELE list splits between parts instead of overflowing. Returns rows, or None when a single
    part is wider than a row even on its own.
    """
    rows = []
    for head, parts in groups:
        prefix = f"{head}: " if head else ""
        open_group = False
        for part in parts:
            if open_group and _text_width(rows[-1] + ", " + part, size) <= width:
                rows[-1] += ", " + part
                continue
            piece = prefix + part
            if rows and not open_group and _text_width(rows[-1] + "; " + piece, size) <= width:
                rows[-1] += "; " + piece
            else:
                if _text_width(piece, size) > width:
                    return None
                rows.append(piece)
            open_group = True
    return rows


def pack_lines(entries, field_names, label, compact=None):
    """Fit a list of entries onto a block of template rows without dropping any.

    One entry per row when they fit. Otherwise the PMs' grouped shorthand (`compact`: one header
    per manufacturer or material, as [(header, [part, ...])]) is tried first, then the full entries
    joined with '; ', at PACK_FONT and then smaller down to FONT_FLOOR. If nothing holds them, the
    last row says how many more there are and where to find them, and a warning goes out: the
    sheet points at the drawing rather than silently losing a line.
    """
    entries = [e for e in entries if e]
    n = len(field_names)
    if len(entries) <= n:
        return entries, []
    width = _usable_width(field_names)
    forms = ([compact] if compact else []) + [[("", [e]) for e in entries]]
    size = PACK_FONT
    while size >= FONT_FLOOR:
        for form in forms:
            rows = _wrap(form, width, size)
            if rows is not None and len(rows) <= n:
                return rows, []
        size -= 0.5
    # Nothing fits: fill n-1 rows at the smallest size, then point at the drawing.
    parts = [(h, p) for h, ps in forms[0] for p in ps]
    kept = 0
    for k in range(len(parts), 0, -1):
        groups = {}
        for h, p in parts[:k]:
            groups.setdefault(h, []).append(p)
        rows = _wrap(list(groups.items()), width, FONT_FLOOR)
        if rows is not None and len(rows) <= n - 1:
            kept = k
            break
    more = len(parts) - kept
    rows = rows if kept else []
    rows.append(f"+ {more} MORE - SEE RECSET SCHEDULE")
    return rows, [f"{label}: too many to fit {n} rows; {more} left on the RECSET, and the sheet says so. Check before issuing."]


def _is_sheet_good(item):
    return bool(re.search(r"(?i)sheet\s*good", item.get("description", "") + " " + item.get("item", "")))


def _qty_text(qty):
    q = re.sub(r"(?i)\s*pairs?\b", " PR", (qty or "").strip()).strip()
    return f"({q})" if q else ""


def _sheet_good_text(item):
    """LUMBER | SHEET GOOD | PLUMA PLY 3/4" [4x8] | 5  ->  (5) PLUMA PLY 3/4" [4x8]"""
    text = " ".join(p for p in (_qty_text(item.get("qty")), item.get("model", "").upper()) if p)
    return text + " (CHECK RECSET)" if item.get("conflict") else text


THICKNESS = re.compile(r'\d+(?:-\d+)?(?:/\d+)?"')
SHEET_SIZE = re.compile(r"\[[^\]]+\]")


def _groups(pairs):
    """[(header, part)] -> [(header, [part, ...])], keeping first-seen order."""
    out = {}
    for head, part in pairs:
        out.setdefault(head, []).append(part)
    return list(out.items())


def _sheet_goods_compact(items):
    """(5) PLUMA PLY 3/4" [4x8], (4) PLUMA PLY 3/4" [4x10]  ->  PLUMA PLY: (5) 3/4" [4x8], (4) 3/4" [4x10]"""
    pairs = []
    for i in items:
        if i.get("conflict"):  # two values printed over each other: keep it whole and flagged
            pairs.append(("", _sheet_good_text(i)))
            continue
        model = i.get("model", "").upper()
        spec = " ".join(THICKNESS.findall(model) + SHEET_SIZE.findall(model))
        name = re.sub(r"\s+", " ", SHEET_SIZE.sub("", THICKNESS.sub("", model))).strip(" -")
        pairs.append((name, " ".join(p for p in (_qty_text(i.get("qty")), spec) if p)))
    return _groups(pairs)


def _hardware_compact(items):
    """Group by manufacturer, model + description only; a finish shared by the whole group goes once at the end."""
    by = {}
    for i in items:
        by.setdefault(i.get("manufacturer", "").upper(), []).append(i)
    out = []
    for maker, rows in by.items():
        finishes = {r.get("finish", "").upper() for r in rows} - {"", "N/A", "NA"}
        parts = []
        for r in rows:
            # The description carries the size ("15\" TANDEM BLUMOTION"), so it's preferred; a long one
            # ("FURNITURE TERMINAL FOR CONTROLLING EFL LOCK") gives way to the short item name.
            desc, name = r.get("description", ""), r.get("item", "")
            if not desc or (name and len(desc) > 28 and len(name) < len(desc)):
                desc = name
            parts.append(re.sub(r"\s+", " ", " ".join(p for p in (_qty_text(r.get("qty")), r.get("model", ""), desc) if p).upper()))
        if len(finishes) == 1:
            parts[-1] += f" - {finishes.pop()}"
        out.append((maker, parts))
    return out


def _hardware_text(item):
    """One schedule row the way PMs write it: (2 PR) ACCURIDE 3832-C16EC 16" EASY CLOSE SIDE MOUNT DRAWER SLIDE - NICKEL PLATED"""
    desc = item.get("description", "")
    name = item.get("item", "")
    # Skip the item name when the description already says it (SHELF PINS / 5MM NICKEL SHELF PINS).
    if name and not set(name.upper().split()) <= set(desc.upper().split()):
        desc = f"{desc} {name}".strip()
    parts = [_qty_text(item.get("qty")), item.get("manufacturer", ""), item.get("model", ""), desc]
    text = " ".join(p for p in parts if p).upper()
    finish = item.get("finish", "")
    if finish and not re.fullmatch(r"(?i)n/?a", finish):
        text += f" - {finish.upper()}"
    note = item.get("notes", "")
    if note:
        text += f" ({note.upper()})"
    return re.sub(r"\s+", " ", text)


def intake_from_recset(path, drafter_names=None):
    """Pre-fill the intake from a RECSET shop drawing.

    Fills drafter, materials, hardware and finishes. Deliberately does NOT
    fill CNC blank sizes - those come off dimensioned geometry, not callouts.
    """
    if recset_parser is None:
        raise SystemExit("recset.py not found next to make_checklist.py")
    data = recset_parser.parse(path)
    drafter_names = drafter_names or {}

    initials = data.get("drawn_by")
    drawn_by = normalize_person(initials) if initials else ""

    # The HATCH KEY is the authoritative material list on a Studio Practice
    # RECSET. Split it: sheet goods go on the Material line (with thickness,
    # uppercase); solid lumber implies blanks, which need cut sizes we can't read.
    hatch = [h.upper() for h in data["hatch_key"]]
    lumber = [h for h in hatch if SOLID_LUMBER.search(h) and not SHEET_GOODS.search(h)]
    warnings = []

    # Newer RECSETs list the sheet goods inside the hardware schedule (LUMBER | SHEET GOOD |
    # <material> | <qty>): that's the ordering authority, with counts and sizes. Older ones only
    # have the HATCH KEY, which names the materials but not how many sheets.
    items = data.get("hardware_items", [])
    for i in items:
        if i.get("conflict"):
            warnings.append(f"RECSET hardware schedule: {i['conflict']}. Check the drawing; the sheet shows both.")
    sheet_rows = [i for i in items if _is_sheet_good(i)]
    hardware_rows = [i for i in items if not _is_sheet_good(i)]

    compact_materials = None
    if sheet_rows:
        materials = [_sheet_good_text(i) for i in sheet_rows]
        compact_materials = _sheet_goods_compact(sheet_rows)
    else:
        materials = [f"{DEFAULT_THICKNESS} {h}" for h in hatch if SHEET_GOODS.search(h)]
        if materials:
            warnings.append("Materials come from the HATCH KEY (no sheet-goods rows in the schedule): no sheet counts, thickness assumed 3/4\".")
    shop_materials, w = pack_lines(materials, F_SHOP_MATERIALS, "materials", compact_materials)
    warnings += w
    cnc_material, w = pack_lines(materials, F_CNC_MATERIAL, "CNC materials", compact_materials)
    warnings += w
    hardware, w = pack_lines([_hardware_text(i) for i in hardware_rows], F_SHOP_HARDWARE, "hardware",
                             _hardware_compact(hardware_rows))
    warnings += w

    finishes = data["finish_terms"]
    primary = FINISH_DEFAULT if "PRIMED" in finishes else (finishes[0] if finishes else "")

    return {
        "drawn_by": drawn_by,
        "shop_materials": shop_materials,
        "shop_hardware": hardware or [NO_HARDWARE],
        "cnc_material": cnc_material,
        # Jeffrey's call (2026-08-17): always default to NONE rather than leaving
        # it empty. _needs_blank_sizes still flags when the drawing shows solid
        # lumber, so it can be surfaced for review before the file goes out.
        "cnc_blanks": NO_BLANKS,
        "cnc_tools": [NO_TOOLS],
        "finish_interior": primary,
        "finish_edges": primary,
        "finish_exterior": primary,
        "_needs_blank_sizes": lumber,
        "_warnings": warnings,
        "_source": os.path.basename(path),
        "_raw": data,
    }


def build(wo_number, intake, template, out_dir):
    api = Innergy()
    wo = api.work_order(wo_number)
    catalog = api.labor_catalog()
    warnings = list(intake.get("_recset_warnings") or [])

    # --- Hours: from the take-off at the signed-off rates; never Innergy planned hours ----------
    recommendation = estimating.recommend(wo.get("Name", ""), intake.get("_recset"), intake)
    est, rates = None, None
    takeoff = intake.get("takeoff")
    if takeoff:
        rates = estimating.load_rates()
        est = estimating.estimate(takeoff, rates, recommendation)
        warnings += est["warnings"]
        for key, k in (("est_cnc", "cnc"), ("est_fab", "fab"), ("est_fin", "fin")):
            computed = estimating.round_hours(est["hours"][k])
            if intake.get(key) is None:
                intake[key] = computed
            elif computed is not None and intake[key] != computed:
                warnings.append(f"{key}: intake says {intake[key]}, take-off says {computed}. The intake value is on the sheet.")
        basis = estimating.basis_line(est)
        notes = list(intake.get("shop_notes") or [])
        if basis and not any(str(n).startswith("BASIS:") for n in notes):
            if len(notes) < len(F_SHOP_NOTES):
                notes.append(basis)
                intake["shop_notes"] = notes
            else:
                warnings.append("Shop notes are full; the basis line is only in the estimate record: " + basis)
    for key in ("est_cnc", "est_fab", "est_fin"):
        if intake.get(key) is None:
            warnings.append(f"No {key}: left blank on the sheet (Innergy planned hours are never used). Add a take-off or an estimate.")

    wo_id = wo["Id"]

    # --- QR payloads, one per page -----------------------------------------
    qr_payloads = {}
    missing = []
    for pno, (kind, labor_name) in PAGE_QR.items():
        if kind == "workorder":
            qr_payloads[pno] = workorder_payload(wo_id)
        else:
            labor_id = catalog.get(labor_name)
            if not labor_id:
                missing.append(labor_name)
                continue
            qr_payloads[pno] = labor_payload(labor_id, wo_id)
    if missing:
        raise SystemExit(
            "Labor item(s) not found in Innergy catalog: " + ", ".join(missing)
        )

    # --- Field values -------------------------------------------------------
    project_line = f"{wo['ProjectName']}\n{wo['Number']} - {wo['Name']}"
    values = {
        F_PROJECT: project_line,
        F_PM: short_name((wo.get("ProjectManager") or {}).get("FullName", "")),
        # Innergy's PlannedEndDate goes stale like its hours do; an intake
        # "due" (YYYY-MM-DD) wins when given.
        F_DUE: _fmt_date(intake.get("due") or wo.get("PlannedEndDate")),
        # Hours come from the take-off (or a PM's explicit estimate). Innergy's planned hours are
        # never printed: they're made up (owner decision 2026-11-10).
        F_EST_CNC: _fmt_hours(intake.get("est_cnc")),
        F_EST_FAB: _fmt_hours(intake.get("est_fab")),
        F_EST_FIN: _fmt_hours(intake.get("est_fin")),
        # Innergy does not carry these - they come from the intake.
        F_DRAWN_BY: intake.get("drawn_by", ""),
        F_VIF: intake.get("vif", ""),
        F_ENG_SIGNOFF: intake.get("eng_signoff", ""),
        F_CNC_BLANKS: intake.get("cnc_blanks", ""),
        F_FIN_COLOR_SAMPLE: intake.get("finish_color_sample", ""),
        F_FIN_CONTROL_SAMPLE: intake.get("finish_control_sample", ""),
        F_FIN_INTERIOR: intake.get("finish_interior", ""),
        F_FIN_EDGES: intake.get("finish_edges", ""),
        F_FIN_EXTERIOR: intake.get("finish_exterior", ""),
    }
    values.update(_spread(F_CNC_MATERIAL, intake.get("cnc_material")))
    values.update(_spread(F_CNC_TOOLS, intake.get("cnc_tools")))
    values.update(_spread(F_SHOP_MATERIALS, intake.get("shop_materials")))
    values.update(_spread(F_SHOP_HARDWARE, intake.get("shop_hardware")))
    values.update(_spread(F_SHOP_TOOLS, intake.get("shop_tools")))
    values.update(_spread(F_SHOP_NOTES, intake.get("shop_notes")))
    values.update(_spread(F_FIN_MATERIALS, intake.get("finish_materials")))

    # --- Output name --------------------------------------------------------
    fname = safe_filename(
        f"{wo['ProjectName']} - {wo['Name']} - {wo['Number']} - Production Checklist.pdf"
    )
    out_path = os.path.join(out_dir, fname)
    os.makedirs(out_dir, exist_ok=True)

    filled, overflow = fill_checklist(template, out_path, values, qr_payloads)
    qr_check = verify_qr(out_path, qr_payloads)
    if not qr_check["ok"]:
        warnings.insert(0, "QR SCAN-BACK FAILED - do not issue this sheet: " + "; ".join(qr_check["problems"]))

    record_paths = []
    if est:
        issued = {"cnc": intake.get("est_cnc"), "fab": intake.get("est_fab"), "fin": intake.get("est_fin")}
        record = estimating.make_record(wo, takeoff, est, rates, recommendation, issued)
        record["estimated_by"] = values[F_PM]
        record_paths = estimating.write_record(record, beside_pdf=out_path)

    return {
        "path": out_path,
        "work_order": wo["Number"],
        "wo_id": wo_id,
        "project": wo["ProjectName"],
        "name": wo["Name"],
        "pm": values[F_PM],
        "due": values[F_DUE],
        "step": wo.get("Step"),
        "hours": {"cnc": intake.get("est_cnc"), "fab": intake.get("est_fab"), "fin": intake.get("est_fin")},
        "build_type_recommendation": recommendation,
        "estimate_record": record_paths,
        "warnings": warnings,
        "qr": qr_payloads,
        "qr_verified": qr_check["ok"],
        "filled_fields": sorted(filled),
        # Values still too wide at the minimum readable font - shorten these.
        "overflowing_fields": [n for n, _ in overflow],
    }


def verify_qr(pdf_path, qr_payloads, dpi=200):
    """Scan every page's QR code back off the finished PDF and compare it with what was meant.

    Hand-built sheets carried duplicated codes for years, so hours landed on the wrong labor line.
    Each page must hold exactly one code, and it must decode to that page's payload. The check
    reads the rendered page, so it catches a code placed on the wrong page or not placed at all.
    """
    from pyzbar import pyzbar  # optional dependency; without it the sheet can't be verified
    from PIL import Image

    problems = []
    with pymupdf.open(pdf_path) as doc:
        for pno in range(len(doc)):
            want = qr_payloads.get(pno)
            pix = doc[pno].get_pixmap(dpi=dpi)
            img = Image.frombytes("RGB" if pix.n < 4 else "RGBA", (pix.width, pix.height), pix.samples)
            got = [c.data.decode("utf-8") for c in pyzbar.decode(img) if c.type == "QRCODE"]
            if want is None and not got:
                continue
            if len(got) != 1:
                problems.append(f"page {pno + 1}: {len(got)} QR codes found, expected 1")
            elif got[0] != want:
                problems.append(f"page {pno + 1}: QR reads {got[0]!r}, expected {want!r}")
    return {"ok": not problems, "problems": problems}


def apply_model(takeoff, model_path):
    """Fill the take-off's part count from the model. A count already in the intake wins, with a warning."""
    import measure  # rhino3dm is only needed when a model is given
    m = measure.summarize(model_path, os.path.basename(model_path))
    takeoff["model"] = {"file": os.path.basename(model_path), "parts": m["parts"], "sqft": m["sqft"],
                        "note": m["note"], "by_layer": m["by_layer"]}
    if takeoff.get("part_count") is None:
        takeoff["part_count"] = m["parts"]
    elif int(takeoff["part_count"]) != m["parts"]:
        print(f"WARNING: intake part_count {takeoff['part_count']} vs model {m['parts']}. The intake value is used.")
    print(f"Model: {m['parts']} parts, {m['sqft']} sq ft on {m['materials']} sheet-goods layers ({m['note']}).")
    return takeoff


def main():
    ap = argparse.ArgumentParser(description=__doc__)
    ap.add_argument("wo", help="Work order number, e.g. P-26-1007-011p")
    ap.add_argument("--intake", help="JSON file with the manual fields")
    ap.add_argument("--recset", help="RECSET shop drawing PDF to pre-fill from")
    ap.add_argument("--model", help="Rhino working model (.3dm): part count for the CNC estimate")
    ap.add_argument("--template", default=DEFAULT_TEMPLATE)
    ap.add_argument(
        "--out",
        default=".",
        help="Output directory - normally the job's 04_PRODUCTION folder",
    )
    ap.add_argument("--write-intake-template", action="store_true")
    args = ap.parse_args()

    if args.write_intake_template:
        with open("intake.json", "w") as fh:
            json.dump(INTAKE_TEMPLATE, fh, indent=2)
        print("Wrote intake.json")
        return

    intake = dict(INTAKE_TEMPLATE)
    if args.recset:
        derived = intake_from_recset(args.recset, DRAFTER_NAMES)
        intake["_recset"] = derived.get("_raw")
        intake["_recset_warnings"] = derived.get("_warnings", [])
        for key in ("_raw", "_source", "_needs_blank_sizes", "_warnings"):
            derived.pop(key, None)
        intake.update({k: v for k, v in derived.items() if v})
    # An explicit intake file always wins over anything read off the drawing.
    if args.intake:
        with open(args.intake) as fh:
            intake.update({k: v for k, v in json.load(fh).items() if v not in (None, "", [])})
    # CNC take-off from the working model: every solid on a sheet-goods layer, duplicate copy removed.
    # No trimmed MATERIAL CALC copy needed: on 104/105 the untrimmed count landed within ~15% of actual.
    if args.model:
        intake["takeoff"] = apply_model(dict(intake.get("takeoff") or {}), args.model)
    # Unset people fields take SP's defaults (checklist/settings.json).
    for field, value in SETTINGS.get("defaults", {}).items():
        if not intake.get(field):
            intake[field] = value
    for field in PERSON_FIELDS:
        intake[field] = normalize_person(intake.get(field))

    result = build(args.wo, intake, args.template, args.out)
    print(json.dumps(result, indent=2))


if __name__ == "__main__":
    main()
