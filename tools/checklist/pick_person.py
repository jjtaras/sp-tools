#!/usr/bin/env python3
"""
Ask who fills a person field on the checklist (VIF, Engineering Sign Off) from a numbered list.

The lists live in SP's checklist/settings.json under "choices" (field -> names), and the default
under "defaults". Enter takes the default; a number picks from the list. Used by run_checklist.bat,
which reads the answer back from the file named on the command line.

    py pick_person.py vif "%TEMP%\\sp_vif.txt"
"""

import os
import sys

import sp_config

LABELS = {
    "vif": "VIF - who verified in field",
    "eng_signoff": "Engineering sign off",
}


def choices(settings, field, user=None):
    names = settings.get("choices", {}).get(field)
    if not names:  # no list configured: everyone in the people map
        names = list(dict.fromkeys(settings.get("people", {}).values()))
    default = settings.get("defaults", {}).get(field, "")
    # VIF defaults to the PM running the tool (CHECKLIST_USER in their .env), initials or name.
    if field == "vif" and user:
        default = settings.get("people", {}).get(user.strip().upper().rstrip("."), user.strip())
    if default and default not in names:
        names = [default] + names
    return names, default


def ask(field, settings, user=None, read=input, write=print):
    names, default = choices(settings, field, user)
    write("")
    write(f"  {LABELS.get(field, field)}:")
    for i, name in enumerate(names, 1):
        write(f"    {i}  {name}" + ("   (default)" if name == default else ""))
    while True:
        try:
            answer = read("  Enter for the default, or type a number: ").strip()
        except EOFError:  # no console to read from (piped or closed): take the default
            return default
        if not answer:
            return default
        if answer.isdigit() and 1 <= int(answer) <= len(names):
            return names[int(answer) - 1]
        write(f"  Type a number from 1 to {len(names)}, or press Enter.")


def main():
    if len(sys.argv) != 3 or sys.argv[1] not in LABELS:
        raise SystemExit(f"usage: pick_person.py {{{'|'.join(LABELS)}}} <answer file>")
    field, out = sys.argv[1], sys.argv[2]
    settings = sp_config.settings()  # loads the repo .env too
    name = ask(field, settings, os.environ.get("CHECKLIST_USER"))
    with open(out, "w", encoding="utf-8") as fh:
        fh.write(name)


if __name__ == "__main__":
    main()
