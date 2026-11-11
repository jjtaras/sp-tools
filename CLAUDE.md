# sp-tools: kickoff brief

Drop this into the repo root as CLAUDE.md. Claude Code reads it at the start of every session.

## What this is

A cost-model engine plus the apps that use it. Right now that's two Google Apps Script dashboards for Studio Practice (SP): the job profitability dashboard and the shop schedule/capacity tracker. Both are live and limited to the studiopracticenyc.com domain. Estimating tools come later and will use the same model.

Goal: one versioned set of shop cost assumptions that every app reads, so changing an assumption is a single edit with a logged reason, never a hand-sync between boards.

## Ownership split (don't blur this)

- **This repo (Jeffrey's, personal GitHub):** the generic engine. Margin, burn and shop-hours math, pace verdicts, the assumptions *schema*, build/deploy tooling, test harness.
- **SP-owned location (outside this repo):** the actual assumption *values*, job fixtures, Innergy and Billing Sheet credentials, the deployed Apps Script projects. The build reads these in; nothing SP-specific gets committed here.
- Done (sent 2026-11-10): written note to Alex and Chris that Jeffrey keeps the rights to the tooling and SP gets a perpetual license to use and modify it.

## Layout

```
model/schema.yaml        # what an assumption looks like (value, since, source, replaces)
core/                    # pure functions, no I/O; bundled into each board as global SPCore
adapters/innergy/        # Innergy API client (Node; used to record fixtures)
adapters/billing-sheet/  # SP Billing Dashboard reader (.xlsx download → getValues()-style grids)
apps/profitability/      # Margin Board: src/Code.js, app.json (file list), appsscript.json, CHANGELOG.md
apps/shop-schedule/      # Production Tracker: same shape
apps/shared/             # the one look both boards share (design.css, head.html); inlined at build
lib/                     # env/.env loading, app assembly, core bundling
scripts/                 # build, deploy, rollback, record/freeze/accept fixtures, page-check
tools/checklist/         # production checklist tool (Python): Innergy → QR codes → filled checklist PDF; RECSET/model take-offs
tests/                   # core unit tests + fixture tests; fixtures load from the SP config location
dist/                    # build output (gitignored)
CHANGELOG.md             # engine changes
```

Each board is assembled from `core/`, `apps/<app>/src/` (code + page), and one generated file, `assumptions.js`, built from SP's `sp-tools-config/assumptions.yaml` (checked against `model/schema.yaml`). Neither code nor pages contain SP numbers. `npm test` runs that same assembly, so what's tested is what deploys.

Commands: `npm test` · `npm run build` · `npm run fixture:record` then `npm run fixture:freeze -- <name>` · `npm run fixture:accept -- <name> [--yes]` for an intended output change · `node scripts/page-check.mjs <snapshot> <out-dir>` to render both pages for comparison.

## Rules

- No machine-specific paths. This has to run on the Mac (home) and the Windows 11 PC (work). Resolve paths relative to the repo, and keep secrets in `.env` (gitignored) or the Apps Script Script Properties.
- Use Node tooling (esbuild + clasp). On the work PC, plain `python` is a dead Store stub, so avoid Python in the build.
- Bundle `core` plus the config into each app at build time. Don't use Apps Script Libraries.
- Every deploy: tests pass, version bumped (semver), CHANGELOG entry written, git tag created, and the clasp deployment description names the tag.
- Assumption changes go in the SP config changelog with the evidence (lookback result, owner decision, etc.), not just the new number.
- Verification is fixture tests: 1517 plus a few closed lookback jobs, frozen. Any output change fails until it's confirmed as intended.

## Two machines, one repo

Jeffrey works on this from the Mac (home) and the Windows 11 PC (work). GitHub is the master copy, and each machine has its own local clone.

- **Start of every session:** run `git status` and `git pull` before touching anything. If there are uncommitted local changes or the pull conflicts, stop and tell Jeffrey. Don't resolve it silently.
- **End of every session, or when Jeffrey says he's done:** commit with a clear message and push. If anything is left uncommitted, remind him before he leaves the machine.
- The repo lives in a plain local folder (`~/code/sp-tools` on the Mac, `C:\code\sp-tools` on the PC), **never** inside Dropbox. If the working directory is under a Dropbox path, say so and stop.
- Per-machine and never committed: `.env` (Innergy credentials), clasp login (`~/.clasprc.json`), `node_modules/`. Keep `.gitignore` covering all of them.
- Day-one setup: add `.gitattributes` with `* text=auto eol=lf` so line endings don't differ between the machines, and add `.nvmrc` to pin the Node version both machines use.

## First tasks

0. ~~Set up the repo: `git init`, `.gitignore`, `.gitattributes`, `.nvmrc`, then the first commit and push to GitHub.~~ Done 2026-11-10 (remote uses HTTPS).
1. ~~`clasp clone` both existing Apps Script projects, baseline with no changes.~~ Done 2026-11-10, **but the baseline went to `sp-tools-config/baseline/` on Drive, not into `apps/`.** Both projects hardcode SP values (rates, job numbers, WO values, Billing Sheet ID, client names), so committing them as-is would break the ownership split. App code enters `apps/` only once those values are split out. See the SP config CHANGELOG for file hashes.
2. ~~Pull the duplicated logic out of both into `core/`, without changing any outputs.~~ Done 2026-11-10. Fixture harness built and verified against the live Margin Board; both boards' server code in `apps/`, SP values in `sp-tools-config/apps/`; shared Innergy-amount, duration and labor-cost math in `core/`. The two boards still count labor differently (timesheets vs WO job costing, different drafting/overhead rules); unifying that is a step 3 decision.
3. ~~Write `model/schema.yaml` and move the hardcoded numbers into `sp-tools-config/assumptions.yaml`.~~ Done 2026-11-10. Owner decisions applied and logged in the SP config CHANGELOG: boards share rules (tracker now counts labor from timesheets with the Margin Board's rules), seconds dropped, crew 21, no numbers in pages. Open: Innergy planned hours still cap the tracker's post-fab forecast (seed notes say ignore them); finisher headcount / sprayer efficiency.
4. ~~Set up the build plus deploy script, and redeploy both boards from the repo.~~ Done 2026-11-10: `npm run deploy` (v1.0.0 → Margin Board version 5, Production Tracker version 13); `npm run rollback -- <app>` returns to the pre-sp-tools versions (4 / 12).

## In progress: production checklist for SP's PMs (as of 2026-11-11)

Goal: a tool Jeffrey hands to SP's three other PMs so they make their own production checklists. Decisions so far:

- **v1 scope:** the checklist only (Innergy → QR codes → filled PDF), with the RECSET fields read automatically. PMs type the hour estimates themselves; the take-off/estimating work below stays Jeffrey's until calibrated.
- **Packaging:** all PMs are on Windows, with Rhino and SP's Dropbox. Plan is a packaged local Windows app built from the existing Python. Each PM has their own Innergy API key, entered once and stored in Windows Credential Manager, so no shared key and no server endpoint.
- **Naming:** new checklists use the generator's convention (`{Project} - {WO name} - {WO number} - Production Checklist.pdf` in `04_PRODUCTION/`). **Leave existing issued sheets alone; never rename them.** RECSET convention (agreed with Derek for SP's drafting SOP, 2026-11-11): `[WO number]_{job#}_{job name}_FX{room}{fixture}_{fixture name}_{rev}_RECSET`, e.g. `[P-26-1007-016p]_1517_THINK 1165 PARK_FX11601_HIS DRESSING_05_RECSET.pdf`. A RECSET can't exist before its WO (nothing to bill against), so every new one carries the WO. Older files vary (`[WO]` with no underscore after it, fixture names, `REC SET`/`REC_SET`, rev before or after the name; 31 of 64 non-archive RECSETs carry an FX code, 8 the WO); jobs like 1549 ZONE, 1519 MW, 1880, 338 carry neither and get a file picker. Lookup order: `[WO number]` → FX room match (Innergy WO names carry only the room, and one room can hold several fixture WOs: 105 FX10501 = 005p, FX10504 = 020p), unique → PM picks, remembered per WO. Newest rev wins; archive/redline folders skipped.
- **Measuring the RECSET pre-fill:** `py tools/checklist/check_recset.py "<SP Dropbox>/SP PROJECTS/ACTIVE JOBS" --out <scratch>/report.json` compares it with issued checklists (write the report outside the repo; it names SP jobs). 27 of 58 checklists pair (2026-11-11).
- **Done 2026-11-11:** hardware schedule read column by column (wrapped cells, `/ BOM` headers, next-table stop, overprinted text flagged); sheet-good rows → Materials with counts/sizes; packing into the template rows in the PMs' grouped style, never dropping a line; first-row font bug fixed (one-widget parent fields flattened in memory); **QR scan-back added** (README claimed it, code didn't have it); SS → Steve S. in SP's `people`. Drafter now right in 18/27.
- **Done 2026-11-11 (later):** FINISHES legend read properly (code column + nearest description; stops at the foreman stamp) and mapped to the finish block (PF → interior; other shop finishes → edges/exterior; by-others paint → shop primed + final paint by others; colours/woods → color sample). Matches Jeffrey's 116 sheet exactly. Overflow flag now means "really doesn't fit".
- **Finish page (2026-11-11):** Jeffrey: finishes vary by job (1517 mostly shop primed; 1516 mixed; often PF interiors + lacquered exteriors), and most RECSETs now carry a finish-map page. `recset._finish_map` finds it by its swatch key; callouts naming surface + code set the surfaces, else colour location per view (1516 Library: PT01 on east elevation → "AT EAST ELEVATION; ELSEWHERE SHOP PRIMED", warned). Checked on 1516 Library, Study, Towel Station, Penthouse; no change on other jobs.
- **Done 2026-11-11 (later):** RECSET found from the WO (`find_recset.py`; launcher shows it, PM can override; output folder found too; never overwrites, writes `(2)`). Data issue for Jeffrey: 1517's only `[P-26-1007-005p]` file is the range hood drawing (`…FX10501_KITCHEN_RANGE HOOD…`), which is WO 026p.
- **Next:** the Windows app (PM's own key in Credential Manager, CHECKLIST_USER at setup, hours typed by the PM); pilot with one PM.

## Paused: automated take-off (as of 2026-11-10)

Goal: `tools/checklist` takes quantities off the Rhino working model (and RECSET) so hours come from data, not hand take-offs. Estimate records + `npm run calibrate` compare them with actuals.

- **Done:** CNC part count via `--model` (solids on sheet-goods layers, duplicate removed; no MATERIAL CALC copy needed, since most jobs don't have one). CNC uses the formula, not the per-sheet method: 104 formula 29 h vs actual 26.5 (sheet said 43). `elevations.py`: sq ft per straight run from the model; 104 = 150.8 sf vs 147.6 by hand.
- **Never take dimensions off a drawing's scale.** Each view on a sheet can have its own scale. Use the model, or printed dimension strings only.
- **Next:** (1) split L/U runs into legs and flag islands. 105 Kitchen is the test case. The island is a separate WO (FX10504; ignore it in the 005p model; likely the 66" x 40" x 32" run). Run on the PC 2026-11-11: about 154 sf total, about 139 without the island. Still waiting on Jeffrey: what did 105's hand 85.8 sf (58.4 cased + 27.4 glass/wine) cover, given the model holds ~170 sf? (2) Finish area: proposed rule is every material is finished except prefinished (PF) layers, with the RECSET finish legend overriding; waiting on Jeffrey to confirm. (3) Sheet count from the RECSET hardware schedule. (4) Wire elevations into the intake take-off.
- Test models: `SP PROJECTS/ACTIVE JOBS/1517_THINK_1165 PARK/02_DRAFTING - DESIGN/02_WORKING FILES/` (004p Scullery, 005p Kitchen), in SP's Dropbox. The Dropbox root differs per machine.

## SP config location (decided Nov 2026)

SP's side lives in an `sp-tools-config/` folder on SP's Google Drive (a Shared drive if SP uses them, otherwise Jeffrey's studiopracticenyc.com My Drive). It's owned by SP's Workspace, not Jeffrey's personal accounts.

```
sp-tools-config/
  assumptions.yaml   # the values, in model/schema.yaml format
  CHANGELOG.md       # every assumption change, with date and evidence
  fixtures/          # frozen job snapshots (1517 + closed lookback jobs)
```

- Each machine reaches it through Google Drive for desktop, which shows Drive as a local folder. The path is different on the Mac and the PC, so each machine sets `SP_CONFIG_DIR` in its own `.env`. Never hardcode it.
- The build reads `assumptions.yaml` and bundles a snapshot into each app at deploy time. The dashboards never read the config live, so an assumption change only goes out with a tagged deploy.
- Every build records which config version it used (a hash of `assumptions.yaml`) in the deployment description and the app's CHANGELOG entry.
- If `SP_CONFIG_DIR` is missing or the file doesn't validate against the schema, the build fails loudly. No silent fallback to old values.
- Drive's own version history is the backup for the config. Its CHANGELOG.md is the readable record.

## Seed values for the SP config (current as of Nov 2026)

These are SP's numbers. They go in the SP config, not in this repo.

- COGS + labor = 60% of value (was 50%; changed after the Oct 2026 owner meeting)
- Overhead = 24%, so margin = 76% − cost ÷ value; target margin 16%
- Burdened labor: drafting $75/hr, everyone else $50/hr; pull hours only from Innergy, never labor cost
- PM, admin and foreman time are overhead, not job cost
- Total contract value: SP Billing Dashboard sheet is the source of truth; fall back to Innergy when there's no billing tab; the closed-job lookback uses Innergy values
- Shop-hours predictor: 60% of WO value, less the greater of 10% material reserve or POs against the WO, converted at $50/hr, net of actual hours
- 1516: 25% of WO value is install, removed before the shop-labor rule
- Headcount: 14 fab, 2 CNC, about 5 finishing (2 sprayers); sprayer efficiency unknown, guessed at 50–80%
- Schedule runs on the Innergy critical milestone (staged-by) date only; Labor Kanban beats the WO Step field for status
- Ignore Innergy planned hours
