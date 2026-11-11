# SP Production Tracker changelog

Changes to this board's code. Assumption values are logged in the SP config CHANGELOG.

## 1.3.0 (2026-11-10)

- One 12-week look-ahead (`shop.load_weeks`) for the schedule, load chart, bottlenecks and read-first notes; the Look ahead dropdown is removed.

## 1.2.0 (2026-11-10)

- Shop load (chart, This week / Next week, capacity note, per-job hours) counts CNC + fab + finishing only; drafting moved to Bottlenecks by area.
- Read-first box under the stat strip: bottlenecks, capacity, late WOs, WOs with no value (hidden when empty). These notes were computed before but never shown.

## 1.1.0 (2026-11-10)

- New "Bottlenecks by area" section: weekly forecast hours for CNC, fab and finishing against each area's capacity, plus drafting for reference. Hours are split by the phase shares over the phases each WO has ahead, worked in order. Amber/red over 85% / 100%, with a summary of which areas go over and when.
- `shop_crew` is now the sum of `shop.crew_by_phase`.

## 1.0.1 (2026-11-10)

Shop capacity 22 × 40 = 880 h/week (was 840). Config change only.

## 1.0.0 (2026-11-10)

First deploy from the sp-tools repo (replaces the hand-edited Apps Script version).

- Innergy planned hours are never used (owner decision 2026-11-10). Post-fab cap is always the budget-share rule; WOs with no value have no forecast; job costing no longer pulled.
- Reads every number from the shared `ASSUMPTIONS` (SP's assumptions.yaml); the page gets them from `pageData_` and has none written in. The page now lives in the repo (`src/Index.html`).
- Actual hours now come from Innergy timesheets with the shared labor rules (SPCore.classifyLabor), not from job costing; job costing is used for planned hours only. Pulls labor items and timesheets.
- Durations read to the whole minute (seconds dropped).
- Brought into the repo from the live Apps Script project (clasp clone, 2026-11-10). SP's settings and the page now live in `sp-tools-config/apps/shop-schedule/` and are bundled in at build time.
- Uses the shared engine (`SPCore`) for Innergy amounts, durations and labor dollars.
- Output is unchanged: the fixture snapshot 2026-11-10 reproduces exactly.
