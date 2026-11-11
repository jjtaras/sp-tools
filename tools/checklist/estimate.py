#!/usr/bin/env python3
"""
Shop-hours estimating for the production checklist: build-type recommendation, hours from
take-off quantities, and the estimate record that lets finished work orders recalibrate the rates.

Rates come from SP's assumptions.yaml (estimating.*): the same signed-off numbers for every PM.

Take-off (the intake's "takeoff" block):

    {
      "elevations": [                      # fab: sq ft of elevation by build type
        {"name": "North run", "sq_ft": 58.4, "build_type": "cased_cnc"},
        {"name": "Glass cabinet + wine", "sq_ft": 27.4, "build_type": "cased_cnc", "showpiece": true},
        {"name": "Island", "sq_ft": 40.0}  # no build_type: the recommendation is used and flagged
      ],
      "fab_allowance_hours": 8,            # optional, with "fab_allowance_note"
      "part_count": 275,                   # CNC: deduplicated parts
      "primed_sq_ft": 1570,                # finishing: primed area measured by finish scope
      "finish_scope": "closet"             # "kitchen" (faces/fillers/edges/ends) or "closet" (nearly everything)
    }

Standalone:
    python estimate.py --takeoff takeoff.json [--model model.3dm] [--name "WO name"] [--recset RECSET.pdf] [--intake intake.json]

--model fills part_count from the Rhino working model (measure.py: solids on sheet-goods layers,
duplicate copy removed). No trimmed MATERIAL CALC copy is needed.
"""

import argparse
import datetime
import hashlib
import json
import os
import re
import subprocess

import yaml

import sp_config

BUILD_TYPES = ["cased_cnc", "cased_hand", "dressing_shelving", "dressing_drawers", "shelf_tower", "rod_and_liner", "door_panel"]


# ---------------------------------------------------------------------------
# Rates
# ---------------------------------------------------------------------------
def load_rates():
    """The signed-off estimating rates and the assumptions version they came from."""
    path = os.path.join(sp_config.config_dir(), "assumptions.yaml")
    with open(path, "rb") as fh:
        raw = fh.read()
    doc = yaml.safe_load(raw.decode("utf-8"))
    a = doc["assumptions"]
    need = ["estimating.fab_rates", "estimating.showpiece_multiplier", "estimating.cnc_formula", "estimating.finish_primer_rate"]
    missing = [k for k in need if k not in a]
    if missing:
        raise SystemExit("assumptions.yaml is missing " + ", ".join(missing))
    return {
        "fab": a["estimating.fab_rates"]["value"],
        "showpiece": a["estimating.showpiece_multiplier"]["value"],
        "cnc": a["estimating.cnc_formula"]["value"],
        "primer": a["estimating.finish_primer_rate"]["value"],
        "assumptions_hash": hashlib.sha256(raw).hexdigest()[:12],
    }


# ---------------------------------------------------------------------------
# Build-type recommendation
# ---------------------------------------------------------------------------
def _has(text, *words):
    return any(re.search(r"\b" + w, text) for w in words)


def recommend(wo_name="", recset=None, intake=None):
    """
    Recommend a build type for a work order from its name, the RECSET (hardware, materials,
    callouts) and the intake (hardware, materials, CNC lines). Returns
    {"build_type", "showpiece", "confidence", "reasons"}. The PM confirms it on the take-off.
    """
    recset = recset or {}
    intake = intake or {}
    parts = [wo_name]
    for key in ("hardware", "materials_callouts", "hatch_key", "finish_terms"):
        parts += [str(x) for x in recset.get(key) or []]
    for key in ("shop_hardware", "shop_materials", "shop_notes", "cnc_material"):
        parts += [str(x) for x in intake.get(key) or []]
    # Innergy and RECSET names join words with underscores ("MW_704_DRESSING ROOM"): read them as spaces.
    text = " ".join(parts).upper().replace("_", " ")
    name = (wo_name or "").upper().replace("_", " ")
    cnc = bool(intake.get("cnc_material")) and str(intake.get("cnc_blanks", "")).upper() != "HAND CUT"

    hinges = _has(text, "HINGE")
    drawers = _has(text, "SLIDE", "DRAWER", "DIALOCK", "LOCK")
    doors = hinges or _has(text, "DOOR SKIN", "DOOR CORE", "DOOR STRAIGHTENER")
    rods = _has(text, "CLOSET ROD", "ROD")
    shelves = _has(text, "SHELF PIN", "SHELF", "SHELVES")
    showpiece = _has(text, "GLASS", "MUNTIN", "WINE", "MILLED TRIM")
    panel_name = _has(name, "PANEL", "CLADDING") or bool(re.search(r"\bDOOR\b", name))

    reasons = []
    if _has(name, "DRESSING", "WALK-IN", "WALK IN"):
        if drawers or doors:
            reasons.append("dressing room with " + ("drawers/locks" if drawers else "doors"))
            return {"build_type": "dressing_drawers", "showpiece": showpiece, "confidence": "medium", "reasons": reasons}
        reasons.append("dressing room, shelving and rods only")
        return {"build_type": "dressing_shelving", "showpiece": showpiece, "confidence": "medium", "reasons": reasons}
    if panel_name and not drawers and not shelves:
        reasons.append("work order is panels/doors/cladding")
        return {"build_type": "door_panel", "showpiece": False, "confidence": "medium", "reasons": reasons}
    if hinges or drawers:
        bt = "cased_cnc" if cnc else "cased_hand"
        reasons.append(("hinges" if hinges else "drawer hardware") + (", CNC cut" if cnc else ", no CNC material listed (hand cut)"))
        if showpiece:
            reasons.append("glass/muntins/wine/milled trim: split that elevation out as showpiece")
        return {"build_type": bt, "showpiece": showpiece, "confidence": "high" if cnc else "medium", "reasons": reasons}
    if rods and not shelves:
        reasons.append("closet rods, no doors or drawers")
        return {"build_type": "rod_and_liner", "showpiece": False, "confidence": "medium", "reasons": reasons}
    if shelves:
        reasons.append("shelving, no doors or drawers" + (" (rods too: split rod walls out as rod_and_liner)" if rods else ""))
        return {"build_type": "shelf_tower", "showpiece": False, "confidence": "medium", "reasons": reasons}
    reasons.append("no hardware signals found; defaulting to cased")
    return {"build_type": "cased_cnc" if cnc else "cased_hand", "showpiece": showpiece, "confidence": "low", "reasons": reasons}


# ---------------------------------------------------------------------------
# Hours
# ---------------------------------------------------------------------------
def estimate(takeoff, rates, recommendation=None):
    """Hours from take-off quantities. Returns hours (unrounded), per-line detail and warnings."""
    warnings, lines = [], []
    fab = 0.0
    for e in takeoff.get("elevations") or []:
        bt = e.get("build_type")
        recommended = False
        if not bt:
            if not recommendation:
                raise SystemExit(f"Elevation {e.get('name')!r} has no build_type and there's no recommendation")
            bt, recommended = recommendation["build_type"], True
            warnings.append(f"{e.get('name')}: build type not given; used the recommendation ({bt}). Confirm it.")
        if bt not in rates["fab"]:
            raise SystemExit(f"Unknown build type {bt!r}. Use one of: {', '.join(rates['fab'])}")
        sq = float(e["sq_ft"])
        rate = rates["fab"][bt] * (rates["showpiece"] if e.get("showpiece") else 1)
        h = sq * rate
        fab += h
        lines.append({"name": e.get("name"), "sq_ft": sq, "build_type": bt, "showpiece": bool(e.get("showpiece")),
                      "rate": rate, "hours": h, "recommended": recommended})
    allowance = float(takeoff.get("fab_allowance_hours") or 0)
    fab += allowance
    cnc = None
    if takeoff.get("part_count") is not None:
        cnc = rates["cnc"]["base"] + rates["cnc"]["per_part"] * float(takeoff["part_count"])
    else:
        warnings.append("No part count: CNC hours not estimated.")
    fin = None
    if takeoff.get("primed_sq_ft") is not None:
        fin = rates["primer"] * float(takeoff["primed_sq_ft"])
    else:
        warnings.append("No primed area: finishing hours not estimated.")
    if not lines:
        warnings.append("No elevations: fabrication hours not estimated.")
    return {"hours": {"cnc": cnc, "fab": fab if lines else None, "fin": fin}, "lines": lines,
            "fab_allowance_hours": allowance, "warnings": warnings}


def basis_line(est):
    """One line for the checklist: how the hours were reached."""
    by = {}
    for l in est["lines"]:
        k = l["build_type"] + (" showpiece" if l["showpiece"] else "")
        by[k] = by.get(k, 0) + l["sq_ft"]
    parts = [f"{v:g} SF {k.replace('_', ' ')}" for k, v in by.items()]
    if est["fab_allowance_hours"]:
        parts.append(f"+{est['fab_allowance_hours']:g} H ALLOW")
    return "BASIS: " + ", ".join(parts).upper() if parts else ""


def round_hours(h):
    return None if h is None else int(round(h))


# ---------------------------------------------------------------------------
# Estimate record
# ---------------------------------------------------------------------------
def _commit():
    try:
        return subprocess.run(["git", "rev-parse", "--short", "HEAD"], cwd=sp_config.REPO_ROOT,
                              capture_output=True, text=True, check=True).stdout.strip()
    except Exception:
        return None


def make_record(wo, takeoff, est, rates, recommendation, issued_hours, source="make_checklist"):
    """
    The estimate record: the quantities, the rates version, and the hours that went on the sheet.
    Completed work orders are compared against these to recalibrate the rates.
    """
    return {
        "record_version": 1,
        "work_order": wo["Number"],
        "project": wo.get("ProjectName"),
        "project_number": wo.get("ProjectNumber"),
        "name": wo.get("Name"),
        "created_at": datetime.datetime.now().astimezone().isoformat(timespec="seconds"),
        "source": source,
        "tool_commit": _commit(),
        "assumptions_hash": rates["assumptions_hash"],
        "recommendation": recommendation,
        "takeoff": takeoff,
        "estimate": {"hours": est["hours"], "lines": est["lines"], "warnings": est["warnings"]},
        "issued_hours": issued_hours,   # what the checklist says (may differ if a PM overrode)
        "estimated_by": None,           # set by the caller (the PM on the work order)
        "exclude": {},                  # e.g. {"cnc": "hours logged to another WO"}; set during review
    }


def write_record(record, beside_pdf=None):
    """Next to the checklist (if given) and in SP's estimating/records/<WO>.json."""
    paths = []
    if beside_pdf:
        p = os.path.splitext(beside_pdf)[0].replace(" - Production Checklist", "") + " - Estimate.json"
        paths.append(p)
    rec_dir = os.path.join(sp_config.config_dir(), "estimating", "records")
    os.makedirs(rec_dir, exist_ok=True)
    paths.append(os.path.join(rec_dir, record["work_order"] + ".json"))
    for p in paths:
        with open(p, "w", encoding="utf-8") as fh:
            json.dump(record, fh, indent=2)
            fh.write("\n")
    return paths


def main():
    ap = argparse.ArgumentParser(description="Estimate shop hours from a take-off (prints; writes nothing).")
    ap.add_argument("--takeoff", help="JSON file: a take-off block, or an intake with a 'takeoff' key")
    ap.add_argument("--name", default="", help="Work order name, for the build-type recommendation")
    ap.add_argument("--recset", help="RECSET PDF, for the build-type recommendation")
    ap.add_argument("--intake", help="Intake JSON, for the build-type recommendation")
    ap.add_argument("--model", help="Rhino working model (.3dm): fills the take-off's part count")
    args = ap.parse_args()
    intake = {}
    if args.intake:
        with open(args.intake, encoding="utf-8") as fh:
            intake = json.load(fh)
    recset = None
    if args.recset:
        import recset as recset_parser
        recset = recset_parser.parse(args.recset)
    rec = recommend(args.name, recset, intake)
    print("Recommended build type:", rec["build_type"], ("+ showpiece portion" if rec["showpiece"] else ""), f"({rec['confidence']})")
    for r in rec["reasons"]:
        print("  -", r)
    if args.takeoff or args.model:
        t = {}
        if args.takeoff:
            with open(args.takeoff, encoding="utf-8") as fh:
                t = json.load(fh)
            t = t.get("takeoff", t)
        if args.model:
            from make_checklist import apply_model
            t = apply_model(t, args.model)
        rates = load_rates()
        est = estimate(t, rates, rec)
        h = est["hours"]
        print(f"\nHours (assumptions {rates['assumptions_hash']}): CNC {round_hours(h['cnc'])}  FAB {round_hours(h['fab'])}  FIN {round_hours(h['fin'])}")
        for l in est["lines"]:
            print(f"  {l['name']}: {l['sq_ft']:g} SF {l['build_type']}{' showpiece' if l['showpiece'] else ''} x {l['rate']:.3g} = {l['hours']:.1f} h{'  (recommended; confirm)' if l['recommended'] else ''}")
        print(" ", basis_line(est))
        for w in est["warnings"]:
            print("  !", w)


if __name__ == "__main__":
    main()
