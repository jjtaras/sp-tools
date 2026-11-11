# SP Job Margin Board changelog

Changes to this board's code. Assumption values are logged in the SP config CHANGELOG.

## Unreleased

- New look: uses the shared design (the Production Tracker's fonts, colors and components). Header now reads "Studio Practice · Margins / Job Margin Board"; all data and wording otherwise unchanged.
- Innergy planned hours are never used (owner decision 2026-11-10). Planned-hours flag, job figure and WO column removed.
- Reads every number from the shared `ASSUMPTIONS` (SP's assumptions.yaml); the page gets them from `pageData_` and has none written in. The page now lives in the repo (`src/Index.html`).
- Output adds `lookback_excluded` (job and name of each excluded lookback job).
- Durations read to the whole minute (seconds dropped).
- Brought into the repo from the live Apps Script project (clasp clone, 2026-11-10). SP's settings and the page now live in `sp-tools-config/apps/profitability/` and are bundled in at build time.
- Uses the shared engine (`SPCore`) for Innergy amounts, durations and labor dollars.
- Output is unchanged: the fixture snapshot 2026-11-10 reproduces exactly.
