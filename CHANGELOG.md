# Engine changelog

Changes to the sp-tools engine and tooling. App changes go in `apps/<app>/CHANGELOG.md`, and assumption changes go in the SP config CHANGELOG.

## 1.1.0 (2026-11-10)

- Assumptions: `shop.crew_by_phase` (cnc / fab / finishing) replaces `shop.crew`; the total is unchanged.

## 1.0.1 (2026-11-10)

Config-only release: `shop.crew` 21 → 22 in assumptions.yaml (6 finishers). No code changes.

## 1.0.0 (2026-11-10)

First deploy from the sp-tools repo.

### Deploy
- `npm run deploy` (scripts/deploy.mjs): checks for a clean tree, the tag on HEAD, changelog entries and passing tests. Then it builds, pushes with a fixed file load order, creates a version and updates the live deployment. The description names the tag and the config fingerprint. Targets come from `sp-tools-config/deploy.yaml`.
- `npm run rollback -- <app>` (scripts/rollback.mjs): pushes the baseline code and points the live deployment back at its pre-sp-tools version.
- Margin Board data version 4 → 5 (data shape changed).

### Shared design
- `apps/shared/design.css` + `head.html`: one look for every board, taken from the Production Tracker: fonts (Archivo, Archivo Narrow, IBM Plex Mono), colors (light and dark), header, stat strip, cards, tables, pills, filters and buttons. The build inlines it wherever a page has `<!-- @design -->`.
- The tracker renders pixel-identical with its styles moved into the shared file (full-page screenshot compare).
- The Margin Board was rebuilt on the shared design: tracker-style header (eyebrow, condensed title, meta line), stat strip, square cards, uppercase section labels, monospace numbers, tracker pills for verdicts and flag levels, and the same palette in its charts.

### Step 3: one assumptions file, shared rules, no numbers in pages
- `model/schema.yaml` + `lib/assumptions.mjs`: SP's `assumptions.yaml` is validated (types, required value/since/source, cross-checks) and bundled into every board as `ASSUMPTIONS`. Both boards' only SP input is that file.
- Rule thresholds that were literals in code or pages are now assumptions (flags, outlook, receiving guard, lookback, schedule, capacity warning, phase shares).
- `core/labor.mjs`: `laborRules` / `classifyLabor`, the shared labor rules. Both boards count labor from timesheets with them.
- `core/innergy.mjs`: one duration reading (seconds dropped), `monthsThrough`.
- Both pages are in `apps/<app>/src/Index.html` and fill every number from the served assumptions. `pageData_` on each board serves them.
- `scripts/accept-change.mjs` (`npm run fixture:accept`) shows an intended output change and, with `--yes`, re-freezes it.
- `scripts/page-check.mjs` renders both pages in headless Chrome with a snapshot's data (frozen clock, all tabs and a job opened) and saves the text and DOM, so page changes can be compared.

### Added
- **`core/` engine** (step 2), bundled into each board as the global `SPCore`:
  - `amount`: Innergy money fields.
  - `durationHours`: Innergy durations. It first kept both boards' readings. Since step 3 there's one reading, seconds dropped.
  - `laborRate` and `laborCost`: burdened hours to dollars, with rates passed in from config.
- **Both boards' server code is in `apps/<app>/src/`.** SP values are out of it: settings, examples with job and client names, and the domain. "Hit 16%" and similar labels are built from the configured margin target. `apps/<app>/app.json` lists what makes up each board.
- **`lib/assemble.mjs` and `npm run build`** put each board together from `core/`, its repo code, and SP's files in `sp-tools-config/apps/<app>/` (settings and, until step 3, the page). The build writes `dist/<app>/`, plus `BUILD.json` with the commit and a config hash. The fixture tests run the same assembly, so what's tested is what gets deployed.
- **Fixture test harness.** `npm test` runs every frozen snapshot in `$SP_CONFIG_DIR/fixtures/` through both boards and fails on any difference from the frozen output. Failures name the job and field that changed.
  - `scripts/record-fixture.mjs` (`npm run fixture:record`) pulls what each board would pull from Innergy right now, plus the billing dashboard from an `.xlsx` download.
  - `scripts/freeze-fixture.mjs` (`npm run fixture:freeze -- <name>`) runs the baseline board code on a snapshot, saves the expected output, and writes a SHA-256 manifest. It won't overwrite a frozen snapshot.
  - `tests/lib/gas.mjs` runs an Apps Script project's server code in a Node sandbox, so the boards' pure `build` and `buildBoard` functions run unchanged.
- **`adapters/innergy/client.mjs`:** a GET-only Innergy client. It batches requests, retries on 429 and 5xx, unzips gzip bodies by magic bytes, and has a per-call `followRedirects` option that matches UrlFetchApp.
- **`adapters/billing-sheet/xlsx.mjs`:** reads the billing dashboard `.xlsx` into the same grids `Range.getValues()` returns. Google's export leaves out the cached value of formulas that come to 0, so those are read as 0.
- **`lib/env.mjs`:** loads `.env` and resolves `SP_CONFIG_DIR`. It fails loudly if the variable is missing.
- `.claude/settings.json` lets Claude Code push to GitHub. Force pushes are denied.
