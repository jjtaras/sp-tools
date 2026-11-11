#!/usr/bin/env python3
"""
How well does the RECSET pre-fill match the checklists PMs actually issued?

For each finished production checklist under a jobs folder, find the RECSET for the same
fixture in the same job, run the generator's RECSET pre-fill on it (make_checklist.intake_from_recset),
and compare field by field with what's on the issued sheet. The issued sheet is the reference,
not ground truth: hand-made sheets have errors of their own, so read the disagreements.

    py check_recset.py "<Dropbox>/SP PROJECTS/ACTIVE JOBS" --out report.json

Pairing is by job folder plus fixture: an FX number or WO room number when both names carry one,
otherwise the overlap of name words. Approved / record-set RECSETs beat archive and redline copies.
Pairs below --min-score are listed as unpaired, not guessed.
"""

import argparse
import glob
import json
import os
import re
import sys
from collections import defaultdict

import pymupdf

import make_checklist as mc

FIELDS = {
    "drawn_by": [mc.F_DRAWN_BY],
    "shop_materials": mc.F_SHOP_MATERIALS,
    "cnc_material": mc.F_CNC_MATERIAL,
    "shop_hardware": mc.F_SHOP_HARDWARE,
    "finish_interior": [mc.F_FIN_INTERIOR],
    "finish_edges": [mc.F_FIN_EDGES],
    "finish_exterior": [mc.F_FIN_EXTERIOR],
}

FOLDER_RANK = [  # higher wins
    (re.compile(r"ARCHIVE", re.I), 0),
    (re.compile(r"REDLINE|INCOMING", re.I), 1),
    (re.compile(r"INTERNAL REVIEW", re.I), 2),
    (re.compile(r"APPROVED", re.I), 4),
    (re.compile(r"RECORD SET|04_PRODUCTION", re.I), 5),
]

RECSET_NAME = re.compile(r"REC ?SET", re.I)

STOP = set("""PRODUCTION CHECKLIST CHECKLISTS RECSET REC SET PDF ZONE THE AND W WITH OF FX MW P THINK NAINOA COSBIE
REIS OMALAT LAOBRA STUDIO NAPAL PARK CHARLES ST HARRISON APPROVED CLIENT SIGNED NOTES""".split())


def words(name):
    name = re.sub(r"\.pdf$", "", name, flags=re.I)
    name = re.sub(r"P-\d{2}-\d{4}-\d{3}[a-z]?", " ", name)
    toks = re.findall(r"[A-Za-z]+|\d+", name.upper())
    return {t for t in toks if t not in STOP and not re.fullmatch(r"2[56]\d{4}|\d{4}", t) and len(t) > 1}


def fixture_codes(name):
    """FX104, FX10401, [104_...], MW_704 -> {'104', '704'} (the first three digits name the room)."""
    codes = set()
    for m in re.finditer(r"(?:FX|MW[_ ]?|\[)(\d{3})", name.upper()):
        codes.add(m.group(1))
    return codes


def folder_rank(path):
    rank = 3
    for rx, r in FOLDER_RANK:
        if rx.search(path):
            rank = r
    return rank


def pair(checklist, recsets):
    cn = os.path.basename(checklist)
    cw, cc = words(cn), fixture_codes(cn)
    best = None
    for r in recsets:
        rn = os.path.basename(r)
        rw, rc = words(rn), fixture_codes(rn)
        if cc and rc and not (cc & rc):
            continue
        score = (2.0 if cc & rc else 0.0) + len(cw & rw) / max(1, len(cw))
        key = (score, folder_rank(r), os.path.getmtime(r))
        if best is None or key > best[0]:
            best = (key, r)
    return (best[1], best[0][0]) if best else (None, 0.0)


def issued(path):
    vals = {}
    with pymupdf.open(path) as doc:
        for page in doc:
            for w in page.widgets() or []:
                vals[w.field_name] = (w.field_value or "").strip()
    return {k: [vals.get(f, "") for f in fs] for k, fs in FIELDS.items()}, len(vals)


def norm_tokens(lines):
    text = " ".join(l for l in lines if l and l.upper() not in ("NONE", "OFF"))
    return set(re.findall(r"[A-Z0-9/]+", text.upper().replace('"', " ")))


def compare(got, want):
    g, w = norm_tokens(got), norm_tokens(want)
    if not g and not w:
        return "both empty", 1.0
    if not w:
        return "sheet empty", None
    if not g:
        return "missed", 0.0
    j = len(g & w) / len(g | w)
    return ("match" if j >= 0.8 else "partial" if j >= 0.3 else "wrong"), round(j, 2)


def _person(v):
    v = mc.normalize_person((v or "").strip()) or ""
    parts = v.replace(".", "").split()
    return (parts[0].upper(), parts[1][0].upper() if len(parts) > 1 else "") if parts else None


def compare_person(got, want):
    g, w = _person(got[0] if got else ""), _person(want[0] if want else "")
    if not w:
        return "sheet empty", None
    if not g:
        return "missed", 0.0
    if g == w or (g[0] == w[0] and "" in (g[1], w[1])):
        return "match", 1.0
    return "wrong", 0.0


def main():
    ap = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    ap.add_argument("jobs", help="the ACTIVE JOBS folder in SP's Dropbox")
    ap.add_argument("--out", required=True, help="where to write the JSON report (keep it out of the repo)")
    ap.add_argument("--min-score", type=float, default=0.5)
    args = ap.parse_args()

    rows, unpaired = [], []
    for job in sorted(d for d in glob.glob(os.path.join(args.jobs, "*")) if os.path.isdir(d)):
        pdfs = glob.glob(os.path.join(job, "**", "*.pdf"), recursive=True)
        checklists = [p for p in pdfs if "production checklist" in os.path.basename(p).lower()]
        recsets = [p for p in pdfs if RECSET_NAME.search(os.path.basename(p))]
        for c in sorted(checklists):
            rel = os.path.relpath(c, args.jobs)
            r, score = pair(c, recsets)
            if not r or score < args.min_score:
                unpaired.append({"checklist": rel, "reason": "no RECSET in the job" if not recsets else f"no confident match (best {score:.2f})"})
                continue
            want, nfields = issued(c)
            row = {"checklist": rel, "recset": os.path.relpath(r, args.jobs), "pair_score": round(score, 2), "fields": {}}
            if nfields < 80:
                row["note"] = f"older template ({nfields} fields); field ids may not line up"
            try:
                got = mc.intake_from_recset(r)
            except Exception as e:
                row["error"] = f"{type(e).__name__}: {e}"
                rows.append(row)
                continue
            for k in FIELDS:
                g = got.get(k)
                g = [g] if isinstance(g, str) else list(g or [])
                if k == "drawn_by":
                    verdict, j = compare_person(g, want[k])
                else:
                    verdict, j = compare(g, want[k])
                row["fields"][k] = {"verdict": verdict, "jaccard": j, "recset": g, "sheet": want[k]}
            rows.append(row)
            print(f"{score:4.2f}  {rel[:70]:70s} <- {os.path.basename(r)[:60]}", file=sys.stderr)

    summary = defaultdict(lambda: defaultdict(int))
    for row in rows:
        for k, f in row.get("fields", {}).items():
            summary[k][f["verdict"]] += 1
    report = {
        "checklists_paired": len(rows),
        "errors": sum(1 for r in rows if "error" in r),
        "unpaired": unpaired,
        "summary": {k: dict(v) for k, v in summary.items()},
        "rows": rows,
    }
    with open(args.out, "w", encoding="utf-8") as fh:
        json.dump(report, fh, indent=2, ensure_ascii=False)
    print(json.dumps({k: report[k] for k in ("checklists_paired", "errors", "summary")}, indent=2))
    print(f"unpaired: {len(unpaired)}  ->  full report: {args.out}")


if __name__ == "__main__":
    main()
