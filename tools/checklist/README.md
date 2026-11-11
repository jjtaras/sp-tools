# Production checklist tool

Generates the four-page production checklist that goes with every work order to the shop
floor: pulls the work order from Innergy, stamps the four labor QR codes, fills the fillable
PDF, and verifies the result. Helper scripts take quantities off the RECSET shop drawing and
the Rhino model (elevation area, part area, sheet nesting).

Moved into sp-tools 2026-11-10 (from its working folder), unchanged in behavior. Checked by
regenerating a finished checklist from its saved intake: 80 of 82 fields identical, all three
hour estimates identical. The two that differed were the PM name, now "First L." per house
convention, and the due date, which had moved in Innergy.

## Setup (once per machine)

1. The sp-tools `.env` needs `INNERGY_API_KEY` and `SP_CONFIG_DIR` (see `.env.example` at the repo root).
2. SP's config folder must have `checklist/settings.json` (people, defaults) and
   `checklist/PRODUCTION_CHECKLIST_TEMPLATE.pdf`. Example intake files are in `checklist/examples/`.
3. Python 3.9+ and the packages:
   - Mac: `python3 -m venv tools/checklist/.venv && tools/checklist/.venv/bin/pip install -r tools/checklist/requirements.txt`
   - Windows: `py -m pip install -r tools\checklist\requirements.txt`. Plain `python` may be the dead Store stub; use `py`.

`pyzbar` is only needed for the QR scan-back check and `rhino3dm` only for the model tools.

## Use

```
python make_checklist.py P-26-1007-004p --recset RECSET.pdf --model "<working model>.3dm" --intake intake.json --out "<job>/04_PRODUCTION"
```

`--model` fills the CNC part count from the Rhino working model (see "Part count" below).

On Windows, double-click `run_checklist.bat`. It asks for the work order, the RECSET and the
output folder (drag files and folders in; paths with spaces are fine), then offers numbered lists
for VIF and Engineering Sign Off (`pick_person.py`). The lists are `choices` in SP's
`checklist/settings.json`. Enter takes the default: for VIF that's the PM running the tool
(`CHECKLIST_USER` in the PC's `.env`), for engineering `defaults.eng_signoff`.

| File | What it does |
|---|---|
| `make_checklist.py` | The generator. Innergy → QR codes → filled PDF. |
| `recset.py` | Reads a RECSET shop drawing: drafter, materials, hardware, finishes, sheet-goods schedule. |
| `measure_elev.py` | Elevation area off a shop drawing, at the sheet's printed scale. |
| `elevations.py` | Elevation sq ft per cabinet run from the Rhino model (real inches, no drawing scale). |
| `measure.py` | Cabinet part area from a Rhino model, with duplicate-copy removal. |
| `nest.py` | MaxRects nester. Sheet counts from a Rhino model. |
| `sp_config.py` | Finds `.env` and SP's config folder; fails loudly if anything is missing. |
| `run_checklist.bat` | Double-click wrapper for Windows. |

## The intake file

Innergy carries the work order, project, PM and due date. Everything else comes from the drawing
or from you. Copy an example from SP's `checklist/examples/` and edit it. Each block has a fixed
number of rows on the template; more lines than rows stops the generator rather than dropping
one (a dropped line is a hardware note that never reaches the floor). `due` (YYYY-MM-DD) overrides
Innergy's PlannedEndDate. `est_cnc` / `est_fab` / `est_fin` set the hours on the sheet.

**Never print Innergy planned hours on a sheet.** They're made up (owner decision 2026-11-10).

## Estimating hours

The signed-off rates are in SP's `assumptions.yaml` under `estimating.*`: fabrication hours per
sq ft of elevation by build type, the showpiece multiplier, the CNC formula and the primer rate.
The full basis is in `sp-tools-config/estimating/shop-hours-basis.md`.

Put the take-off in the intake as a `takeoff` block (format at the top of `estimate.py`):
elevations with sq ft and build type, an optional fab allowance, the deduplicated part count,
and the primed area by finish scope. The tool then:

- **recommends a build type** from the work order name, the RECSET and the intake (hinges or slides
  → cased, CNC cut or hand cut; glass/muntins/wine → split out a showpiece elevation; dressing room
  with drawers/locks/doors vs shelving; rods only → rod and liner; shelving only → shelf tower;
  panels/cladding/doors → door/panel). Elevations without a build type use it, flagged to confirm;
- **prices the hours** at the signed-off rates (an explicit `est_*` in the intake still wins, with a warning);
- **adds a basis line** to the shop notes when there's room;
- **writes an estimate record**: `… - Estimate.json` next to the checklist, and
  `sp-tools-config/estimating/records/<WO>.json`. `npm run calibrate` (repo root) compares these
  with timesheet actuals once a work order is Completed and quiet for `estimating.settled_after_days`.

Hours are never taken from Innergy's planned hours: with no take-off and no estimate the sheet is
left blank and the tool warns. `python estimate.py --takeoff t.json --name "<WO name>"` prices a
take-off without making a checklist.

Measuring an elevation: **don't take it off the sheet's scale.** Every view on a sheet can have
its own scale. `elevations.py` measures runs from the model instead (104: 150.8 sf vs 147.6 by hand);
L/U runs and islands are flagged for a hand measurement for now. On a drawing, only printed
dimensions are trustworthy. Use the printed overall dimension where there is one. Wall runs count one face;
freestanding islands count all four. Classify each elevation by what's behind it.

## House conventions

- People are `First L.` everywhere (PM, VIF, Drawn By, Engineering Sign Off). Initials are
  normalized through `people` in SP's `checklist/settings.json`.
- `NONE`, never NA or N/A.
- Filename: `{ProjectName} - {WOName} - {WONumber} - Production Checklist.pdf`, into the job's `04_PRODUCTION` folder.
- CNC blank sizes can't be read off a drawing. They default to NONE and need checking before the sheet goes out.

## The QR codes: why this exists

Hand-built checklists carried duplicated QR codes, so hours landed on the wrong labor line for
years. One verified code per page:

```
page 1   `#projectWorkOrder;{wo_id}`
page 2   `#laborItem;{labor_id};projectWorkOrder;{wo_id}`   002 - CNC
page 3   same form                                          003 - FABRICATION: Wood Shop
page 4   same form                                          004 - Finishing
```

The backticks are part of the payload. Labor IDs come from `/api/labors` and are global, so
they're stable. **Never hand over a sheet without scanning the codes back.** The generator does
this itself: after writing the PDF it renders every page, decodes the QR with `pyzbar`, and checks
there's exactly one code per page and that it matches. The result shows `qr_verified`; a failure
puts `QR SCAN-BACK FAILED - do not issue this sheet` at the top of the warnings.

## Reading a RECSET

CAD text extraction is unordered, so `recset.py` works off position, not reading order. The
`DRAWN BY:` caption is outlined vector text; the initials sit bottom-right, on the row above SCALE.
Section parsers are scoped to the page their header is on. Newer RECSETs carry sheet goods inside
the HARDWARE SCHEDULE as `LUMBER | NA | SHEET GOOD | <material> | NA | <qty>`, which is the
ordering authority (about 20% over a tight nest). Use `nest.py` as a cross-check.

**The hardware schedule** (`HARDWARE SCHEDULE`, `HARDWARE SCHEDULE / BOM`) is read column by column:
each value goes to the header whose centre is nearest, rows are anchored on the ITEM column, and a
wrapped description joins its row. The table ends at the next schedule in the same columns
(APPLIANCE SCHEDULE etc.); legends at the far side of the sheet don't end it. Text a drawing
carries twice at the same spot is kept once; two *different* values printed over each other are
a drawing error, flagged in the warnings and marked `(CHECK RECSET)` on the sheet.

- Sheet-good rows become **Materials** with counts and sizes. Without them the HATCH KEY is the
  fallback (types only, 3/4" assumed, with a warning).
- Everything else is **Hardware**, written the way PMs write it: `(2 PR) ACCURIDE 3832-C16EC 16" EASY CLOSE … - NICKEL PLATED`.
- More lines than the template has rows are packed, never dropped: the PMs' grouped shorthand
  first (`PLUMA PLY: (5) 3/4" [4x8], (4) 3/4" [4x10]`, `HAFELE: (1) 237.59.010 TERMINAL, …`),
  wrapping a long group onto the next row, at 9 pt down to 6 pt. If even that won't fit, the last
  row reads `+ N MORE - SEE RECSET SCHEDULE` and a warning says so.

A RECSET with no hardware schedule gives NONE; on several jobs the PM's hardware came from
elsewhere (shop stock, client supplied). A RECSET with no extractable text (outlined or scanned,
e.g. 1884) gives nothing at all.

**Checking the pre-fill against issued sheets:** `py check_recset.py "<SP Dropbox>/SP PROJECTS/ACTIVE JOBS" --out <file outside the repo>`
pairs each issued checklist with its job's RECSET and compares field by field. The issued sheets are
a reference, not ground truth (PMs write materials and finishes in their own words), so read the
disagreements rather than trusting the score.

## Part count (CNC)

`--model` counts every **solid** (Brep, extrusion, SubD, mesh) on a sheet-goods layer of the
working model (MEDEX, ply, PlumaPly, PF maple, PS/rift white oak, MDF; not solid wood, stone,
hardware, glass, steel), drops a duplicated copy, and puts the count in the take-off. Curves,
hatches and anything under layout space are not parts. The per-layer breakdown goes into the
estimate record, so the count can be checked later.

There's no need for a trimmed MATERIAL CALC copy (most jobs don't have one). Checked 2026-11-10:

| WO | Trimmed count | Working model | CNC at formula | Actual so far |
|---|---|---|---|---|
| 104 Scullery | 309 (sheet said 43 h, sheet route) | 483 | 29 h | 26.5 h |
| 105 Kitchen | 275 (sheet said 28 h) | 381 | 25 h | 21.4 h (running) |

## Rhino models: the duplicate problem

Models often carry the cabinetry twice (a translated working copy, or CNC parts copied next to
the assembly). `measure.py` finds the duplicate by indexing parts on layer, position and
dimensions, searching for the offset that aligns the most parts, and dropping one side. Areas
come from bounding boxes, which overstate rotated parts by 5–27%: treat square feet as ±20%.
