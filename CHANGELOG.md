# Engine changelog

Changes to the sp-tools engine and tooling. App changes go in `apps/<app>/CHANGELOG.md`, and assumption changes go in the SP config CHANGELOG.

## Unreleased

### Added
- **`core/` engine** (step 2), bundled into each board as the global `SPCore`:
  - `amount`: Innergy money fields.
  - `durationHours`: Innergy durations. It keeps both boards' readings: the Margin Board counts seconds, and the tracker ignores them (`wholeMinutes`). Unifying them is an assumption decision.
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
