# SP Job Margin Board changelog

Changes to this board's code. Assumption values are logged in the SP config CHANGELOG.

## Unreleased

- Brought into the repo from the live Apps Script project (clasp clone, 2026-11-10). SP's settings and the page now live in `sp-tools-config/apps/profitability/` and are bundled in at build time.
- Uses the shared engine (`SPCore`) for Innergy amounts, durations and labor dollars.
- Output is unchanged: the fixture snapshot 2026-11-10 reproduces exactly.
