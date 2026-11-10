# Engine changelog

Changes to the sp-tools engine and tooling. App changes go in `apps/<app>/CHANGELOG.md`, and assumption changes go in the SP config CHANGELOG.

## Unreleased

### Added
- **Fixture test harness.** `npm test` runs every frozen snapshot in `$SP_CONFIG_DIR/fixtures/` through both boards and fails on any difference from the frozen output. Failures name the job and field that changed.
  - `scripts/record-fixture.mjs` (`npm run fixture:record`) pulls what each board would pull from Innergy right now, plus the billing dashboard from an `.xlsx` download.
  - `scripts/freeze-fixture.mjs` (`npm run fixture:freeze -- <name>`) runs the baseline board code on a snapshot, saves the expected output, and writes a SHA-256 manifest. It won't overwrite a frozen snapshot.
  - `tests/lib/gas.mjs` runs an Apps Script project's server code in a Node sandbox, so the boards' pure `build` and `buildBoard` functions run unchanged.
- **`adapters/innergy/client.mjs`:** a GET-only Innergy client. It batches requests, retries on 429 and 5xx, unzips gzip bodies by magic bytes, and has a per-call `followRedirects` option that matches UrlFetchApp.
- **`adapters/billing-sheet/xlsx.mjs`:** reads the billing dashboard `.xlsx` into the same grids `Range.getValues()` returns. Google's export leaves out the cached value of formulas that come to 0, so those are read as 0.
- **`lib/env.mjs`:** loads `.env` and resolves `SP_CONFIG_DIR`. It fails loudly if the variable is missing.
- `.claude/settings.json` lets Claude Code push to GitHub. Force pushes are denied.
