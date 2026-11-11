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
python make_checklist.py P-26-1007-004p --recset RECSET.pdf --intake intake.json --out "<job>/04_PRODUCTION"
```

On Windows, double-click `run_checklist.bat`. It asks for the work order, the RECSET and the
output folder; blank VIF / engineering sign-off take SP's defaults from `settings.json`.

| File | What it does |
|---|---|
| `make_checklist.py` | The generator. Innergy → QR codes → filled PDF. |
| `recset.py` | Reads a RECSET shop drawing: drafter, materials, hardware, finishes, sheet-goods schedule. |
| `measure_elev.py` | Elevation area off a shop drawing, at the sheet's printed scale. |
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
The full basis and calibration notes are in `sp-tools-config/estimating/shop-hours-basis.md`.
*(Next: an estimating step in this tool that applies those rates to the take-off quantities and
saves an estimate record next to each checklist, so completed work orders can recalibrate them.)*

Measuring an elevation: **read the scale off the sheet**, never assume; sets mix scales across
pages. Use the printed overall dimension where there is one. Wall runs count one face;
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
they're stable. **Never hand over a sheet without scanning the codes back.**

## Reading a RECSET

CAD text extraction is unordered, so `recset.py` works off position, not reading order. The
`DRAWN BY:` caption is outlined vector text; the initials sit bottom-right, on the row above SCALE.
Section parsers are scoped to the page their header is on. Newer RECSETs carry sheet goods inside
the HARDWARE SCHEDULE as `LUMBER | NA | SHEET GOOD | <material> | NA | <qty>`, which is the
ordering authority (about 20% over a tight nest). Use `nest.py` as a cross-check.

## Rhino models: the duplicate problem

Models often carry the cabinetry twice (a translated working copy, or CNC parts copied next to
the assembly). `measure.py` finds the duplicate by indexing parts on layer, position and
dimensions, searching for the offset that aligns the most parts, and dropping one side. Areas
come from bounding boxes, which overstate rotated parts by 5–27%: treat square feet as ±20%.
