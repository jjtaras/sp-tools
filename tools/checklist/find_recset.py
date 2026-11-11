#!/usr/bin/env python3
"""
Find a work order's RECSET and its job's 04_PRODUCTION folder, from the WO number alone.

SP's RECSET naming (drafting SOP, 2026-11-11):

    [WO number]_{job#}_{job name}_FX{room}{fixture}_{fixture name}_{rev}_RECSET.pdf
    [P-26-1007-016p]_1517_THINK 1165 PARK_FX11601_HIS DRESSING_05_RECSET.pdf

Innergy gives the job (ProjectName starts with the job number, '1517_THINK_1165 PARK') and the
room (WO names start with it, '[116_HIS DRESSING ROOM]'). The search, inside the job's folder:

  1. a RECSET whose name carries the WO number         (the convention)
  2. else one whose FX code is the WO's room           (older files: FX11601, FX206)
  3. else one sharing words with the WO name           (files with neither)

It takes a file on its own only when one clearly wins: it has every word of the WO name and fits
it better than the rest (KITCHEN ISLAND over KITCHEN HINGE JIGS), or sits in a better folder.

Archive and redline folders are skipped. Copies of the same drawing are collapsed to the best one:
04_PRODUCTION / record set over approved over internal review, then the higher revision, then the
newest file. If more than one drawing is left (105: FX10501 and FX10504 are both room 105), the
PM picks, and the pick is remembered for that WO in ~/.sp-tools/recset_picks.json.

    py find_recset.py P-26-1007-016p                       prints what it found
    py find_recset.py P-26-1007-016p <recset file> <out file>  for run_checklist.bat
"""

import json
import os
import re
import sys

import sp_config

RECSET_NAME = re.compile(r"REC[ _]?SET", re.I)
SKIP_DIR = re.compile(r"ARCHIVE|REDLINE|INCOMING|SUPERSEDED|\bOLD\b", re.I)
FOLDER_RANK = [  # later, higher wins
    (re.compile(r"INTERNAL REVIEW", re.I), 1),
    (re.compile(r"APPROVED", re.I), 3),
    (re.compile(r"RECORD SET|04_PRODUCTION", re.I), 4),
]
FX = re.compile(r"FX(\d{3})([A-Z]?)(\d{2})?(?!\d)", re.I)
ROOM_IN_WO = re.compile(r"(?<![\d.])(\d{3})([A-Z]?)(?!\d)")
STOP = set("""RECSET REC SET PDF THE AND WITH OF FX MW AK DMC APPROVED CLIENT SIGNED REVIEW ROOM
CLOSET""".split())
PICKS = os.path.join(os.path.expanduser("~"), ".sp-tools", "recset_picks.json")


def _words(text):
    text = re.sub(r"P-\d{2}-\d{4}-\d{3}[a-z]?", " ", text, flags=re.I)
    return {t for t in re.findall(r"[A-Z]+", text.upper()) if len(t) > 2 and t not in STOP}


def job_folder(jobs, project_name):
    """'1517_THINK_1165 PARK' -> the ACTIVE JOBS folder starting '1517_'."""
    m = re.match(r"\s*(\d{3,4})", project_name or "")
    if not m:
        return None
    hits = [d for d in os.listdir(jobs) if re.match(rf"{m.group(1)}(?!\d)", d) and os.path.isdir(os.path.join(jobs, d))]
    return os.path.join(jobs, sorted(hits)[0]) if hits else None


def wo_room(wo_name):
    """'[116_HIS DRESSING ROOM]' -> '116'; '[MW_704_DRESSING ROOM]' -> '704'; 'MW01_PRIMARY ALCOVE' -> None."""
    m = ROOM_IN_WO.search(wo_name or "")
    return m.group(1) if m else None


def recsets(folder):
    out = []
    for dp, dn, fn in os.walk(folder):
        dn[:] = [d for d in dn if not SKIP_DIR.search(d)]
        out += [os.path.join(dp, f) for f in fn if f.lower().endswith(".pdf") and RECSET_NAME.search(f)]
    return out


def _rank(path):
    rank = 2
    for rx, r in FOLDER_RANK:
        if rx.search(os.path.dirname(path)):
            rank = r
    return rank


def _rev(name):
    """The revision number: '_05_RECSET' (convention) or '_FX11601_05_' (older files)."""
    m = re.search(r"_(\d{2})_REC[ _]?SET", name, re.I) or re.search(r"FX\w+?_(\d{2})_", name, re.I)
    return int(m.group(1)) if m else -1


def _drawing_key(name):
    """Copies of one drawing share a key: FX code plus name words (FX10501 KITCHEN vs FX10501 KITCHEN HINGE JIGS)."""
    m = FX.search(name)
    fx = "FX" + m.group(1) + m.group(2).upper() + (m.group(3) or "") if m else ""
    return fx + " " + " ".join(sorted(_words(re.sub(r"\d", " ", name))))


def _fit(wo_name, path):
    """How well a file name fits the WO name: (has every WO word, room letter matches, -extra words)."""
    want, have = _words(wo_name), _words(os.path.basename(path))
    m, room = FX.search(os.path.basename(path)), ROOM_IN_WO.search(wo_name or "")
    letter = bool(m and room and room.group(2) and m.group(2).upper() == room.group(2).upper())
    return (bool(want) and want <= have, letter, -len(have - want))


def candidates(wo, folder):
    """The RECSETs that could be this WO's, best copy of each drawing, best match first."""
    number, name = wo["Number"], wo.get("Name", "")
    room = wo_room(name)
    want = _words(name)
    files = recsets(folder)
    tagged = [f for f in files if number.lower() in os.path.basename(f).lower()]
    by_room = [f for f in files if room and any(m.group(1) == room for m in FX.finditer(os.path.basename(f)))]
    # The WO-tagged file and the room's other drawings are compared, so a misfiled tag doesn't hide
    # the right drawing (105 Kitchen: the only [005p] file is the range hood).
    found = list(dict.fromkeys(tagged + by_room)) or [f for f in files if want & _words(os.path.basename(f))]
    best = {}
    for f in found:
        key = _drawing_key(os.path.basename(f))
        score = (_rank(f), _rev(os.path.basename(f)), os.path.getmtime(f))
        if key not in best or score > best[key][0]:
            best[key] = (score, f)
    return sorted((f for _, f in best.values()),
                  key=lambda f: (_fit(name, f), _rank(f), _rev(os.path.basename(f)), os.path.getmtime(f)),
                  reverse=True)


def clear_winner(wo, found):
    """The first candidate, if it clearly is the one; else None and the PM picks.

    It must have every word of the WO name. If a file carries the WO number, the winner must be
    that file. Then it has to beat the next candidate on the name or on the folder.
    """
    if not found:
        return None
    a, number = found[0], wo["Number"].lower()
    if not _fit(wo.get("Name", ""), a)[0]:
        return None
    if any(number in os.path.basename(f).lower() for f in found) and number not in os.path.basename(a).lower():
        return None
    if len(found) == 1:
        return a
    b = found[1]
    if _fit(wo.get("Name", ""), a) > _fit(wo.get("Name", ""), b) or _rank(a) > _rank(b):
        return a
    return None


def _load_picks():
    try:
        with open(PICKS, encoding="utf-8") as fh:
            return json.load(fh)
    except (OSError, ValueError):
        return {}


def _save_pick(number, path):
    picks = _load_picks()
    picks[number] = path
    os.makedirs(os.path.dirname(PICKS), exist_ok=True)
    with open(PICKS, "w", encoding="utf-8") as fh:
        json.dump(picks, fh, indent=1)


def choose(wo, found, read=input, write=print):
    """A clear winner: take it. Else the remembered pick if it's still there, else ask."""
    if not found:
        return ""
    number = wo["Number"]
    winner = clear_winner(wo, found)
    if winner:
        return winner
    remembered = _load_picks().get(number)
    if remembered in found:
        write(f"  RECSET (your earlier pick): {os.path.basename(remembered)}")
        return remembered
    write("")
    write(f"  Which RECSET is {number} {wo.get('Name', '')}?")
    for i, f in enumerate(found, 1):
        write(f"    {i}  {os.path.basename(f)}")
    write(f"    {len(found) + 1}  none of these (drag one in next)")
    while True:
        try:
            answer = read("  Type a number: ").strip()
        except EOFError:
            return ""
        if answer.isdigit() and 1 <= int(answer) <= len(found) + 1:
            if int(answer) == len(found) + 1:
                return ""
            pick = found[int(answer) - 1]
            _save_pick(number, pick)
            return pick
        write(f"  Type a number from 1 to {len(found) + 1}.")


def lookup(number, read=input, write=print):
    """WO number -> (recset path or '', 04_PRODUCTION folder or '', WO record)."""
    from make_checklist import Innergy  # the API key is only needed here
    wo = Innergy().work_order(number)
    jobs = sp_config.jobs_dir()
    if not jobs:
        write("  Couldn't find SP's ACTIVE JOBS folder in Dropbox (set SP_JOBS_DIR in .env).")
        return "", "", wo
    folder = job_folder(jobs, wo.get("ProjectName", ""))
    if not folder:
        write(f"  No folder in ACTIVE JOBS for {wo.get('ProjectName')}.")
        return "", "", wo
    out = os.path.join(folder, "04_PRODUCTION")
    recset = choose(wo, candidates(wo, folder), read, write)
    return recset, out if os.path.isdir(out) else "", wo


def main():
    if len(sys.argv) not in (2, 4):
        raise SystemExit("usage: find_recset.py <WO number> [<recset answer file> <output answer file>]")
    recset, out, wo = lookup(sys.argv[1])
    print(f"  {wo['Number']}  {wo.get('ProjectName')} - {wo.get('Name')}")
    print(f"  RECSET: {os.path.basename(recset) if recset else '(not found)'}")
    print(f"  Output: {out or '(not found)'}")
    if len(sys.argv) == 4:
        for path, value in ((sys.argv[2], recset), (sys.argv[3], out)):
            with open(path, "w", encoding="utf-8") as fh:
                fh.write(value)


if __name__ == "__main__":
    main()
