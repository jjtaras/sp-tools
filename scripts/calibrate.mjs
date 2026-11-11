#!/usr/bin/env node
// Recalibrates the shop-hours estimating rates from finished work orders.
//
//   npm run calibrate                      live Innergy data, as of today
//   npm run calibrate -- --snapshot <name> a frozen fixture snapshot (repeatable)
//
// Reads every estimate record in $SP_CONFIG_DIR/estimating/records/, compares each settled work
// order's actual CNC / fab / finishing hours (timesheets, shared labor rules) with its take-off,
// and writes $SP_CONFIG_DIR/estimating/calibration/<date>.md. It never changes a rate: changes go
// through assumptions.yaml and its CHANGELOG, by the owner.
import { readdirSync, readFileSync, writeFileSync, mkdirSync } from 'node:fs';
import path from 'node:path';
import { parseArgs } from 'node:util';
import { configDir, requireEnv, loadEnv } from '../lib/env.mjs';
import { loadAssumptions } from '../lib/assumptions.mjs';
import { innergyClient } from '../adapters/innergy/client.mjs';
import { readJson } from '../tests/lib/fixture.mjs';
import { laborRules, monthsThrough, woActuals, calibrate } from '../core/index.mjs';

const { values: o } = parseArgs({ options: { snapshot: { type: 'string' } } });
loadEnv();
const A = loadAssumptions();
const E = A.values.estimating;
const rates = { fab: E.fab_rates, showpiece: E.showpiece_multiplier, cnc: E.cnc_formula, primer: E.finish_primer_rate };

const recDir = path.join(configDir(), 'estimating', 'records');
const records = readdirSync(recDir).filter((f) => f.endsWith('.json')).map((f) => JSON.parse(readFileSync(path.join(recDir, f), 'utf8')));
if (!records.length) throw new Error(`No estimate records in ${recDir}`);

// ---- Innergy: work orders (status, names), labor items, timesheets
let workOrders, labors, timesheets, asOf, source;
if (o.snapshot) {
  const dir = path.join(configDir(), 'fixtures', o.snapshot);
  const m = readJson(path.join(dir, 'innergy-margin.json'));
  ({ workOrders, labors, timesheets } = m);
  asOf = readJson(path.join(dir, 'meta.json')).today;
  source = `fixture snapshot ${o.snapshot}`;
} else {
  const api = innergyClient({ apiKey: requireEnv('INNERGY_API_KEY'), baseUrl: process.env.INNERGY_BASE_URL || undefined });
  const json = (r, p) => { if (r.status !== 200) throw new Error(`Innergy ${p} returned ${r.status}`); return JSON.parse(r.text); };
  workOrders = [];
  for (let skip = 0; ; skip += 500) {
    const p = `/api/v2-unstable/project-management/work-orders?take=500&skip=${skip}&requireTotalCount=true`;
    const page = json(await api.get(p, { followRedirects: false }), p);
    workOrders = workOrders.concat(page.data || []);
    if (!page.data || page.data.length < 500) break;
  }
  const l = json(await api.get('/api/labors', { followRedirects: false }), '/api/labors');
  labors = l.Items || l;
  const paths = monthsThrough(A.values.innergy.timesheets_start, new Date()).map((m) => `/api/timeTracking/${m[0]}/${m[1]}`);
  timesheets = (await api.getAll(paths, { followRedirects: false })).flatMap((r, i) => [].concat(json(r, paths[i])));
  asOf = new Intl.DateTimeFormat('en-CA', { timeZone: 'America/New_York' }).format(new Date());
  source = `live Innergy, ${new Date().toISOString()}`;
}
const byWo = Object.fromEntries(workOrders.map((w) => [w.SequenceIdentifier && w.SequenceIdentifier.DisplayName, w]));
const status = Object.fromEntries(Object.entries(byWo).map(([k, w]) => [k, w.WorkflowStatus]));
const actuals = woActuals(timesheets, laborRules(labors, A.values.labor), records.map((r) => r.work_order));
const c = calibrate(records, actuals, status, rates, { asOf, settledDays: E.settled_after_days });

// ---- report
const f1 = (x) => (x == null || Number.isNaN(x) ? '–' : (Math.round(x * 10) / 10).toLocaleString('en-US'));
const f2 = (x) => (x == null || Number.isNaN(x) ? '–' : x.toFixed(2));
const pct = (x) => (x == null ? '–' : (x >= 0 ? '+' : '') + Math.round(x * 100) + '%');
const verdict = (n, drift) => (n === 0 ? 'no settled data' : n < 3 ? `thin (${n} WO${n > 1 ? 's' : ''}); watch` : Math.abs(drift) > 0.15 ? '**review**' : 'holding');
const L = [];
L.push(`# Shop-hours calibration, ${asOf}`, '');
L.push(`Data: ${source}. Assumptions ${A.hash}. ${records.length} estimate records; a work order counts once it's **Completed or Closed in Innergy with no hours for ${E.settled_after_days} days**. Actuals are timesheet hours (approved and pending), by labor item: 002 CNC, 003 Fabrication, 004 Finishing; overhead per the shared labor rules is left out. Nothing here changes a rate: that's an owner decision, logged in CHANGELOG.md.`, '');
const settledN = c.rows.filter((r) => r.settled).length;
L.push(`**${settledN} of ${c.rows.length} work orders are settled.**`, '');
L.push('## Rates', '', '| Rate | Current | Settled data says | Drift | WOs | Jobs | Read |', '|---|---|---|---|---|---|---|');
for (const [bt, v] of Object.entries(c.fab)) {
  L.push(`| Fab · ${bt.replace(/_/g, ' ')} (h/sq ft) | ${f2(v.current)} | ${f2(v.data)}${v.onlyDerived ? ' (set from these WOs)' : ''} | ${pct(v.drift)} | ${v.n} | ${v.jobs.join(', ') || '–'} | ${v.onlyDerived ? 'no independent data' : verdict(v.n, v.drift || 0)} |`);
}
L.push(`| Showpiece (× cased) | ${f2(c.showpiece.current)} | ${f2(c.showpiece.data)} | ${pct(c.showpiece.data == null ? null : c.showpiece.data / c.showpiece.current - 1)} | ${c.showpiece.n} | ${c.showpiece.jobs.join(', ') || '–'} | ${verdict(c.showpiece.n, c.showpiece.data == null ? 0 : c.showpiece.data / c.showpiece.current - 1)} |`);
L.push(`| CNC (${c.cnc.current.base} + ${c.cnc.current.per_part} × parts) | formula | actual ÷ formula ${f2(c.cnc.ratio)}${c.cnc.fit ? `; fit ${f2(c.cnc.fit.base)} + ${c.cnc.fit.per.toFixed(3)} × parts` : ''} | ${pct(c.cnc.ratio == null ? null : c.cnc.ratio - 1)} | ${c.cnc.n} | ${c.cnc.jobs.join(', ') || '–'} | ${verdict(c.cnc.n, c.cnc.ratio == null ? 0 : c.cnc.ratio - 1)} |`);
L.push(`| Primer (h/sq ft primed) | ${f2(c.primer.current)} | ${f2(c.primer.data)} | ${pct(c.primer.drift)} | ${c.primer.n} | ${c.primer.jobs.join(', ') || '–'} | ${verdict(c.primer.n, c.primer.drift || 0)} |`);
L.push('', 'Fab points are work orders taken off as a single build type. Showpiece points back out the plain elevations and allowances at today\'s rates. "Set from these WOs" means the only data is the work order the rate was taken from.', '');
L.push('## Work orders', '', '| WO | Name | Estimated by | Counts? | Why | On the sheet CNC / Fab / Fin | Today\'s rates | Actual CNC / Fab / Fin | Pending h | Excluded |', '|---|---|---|---|---|---|---|---|---|---|');
for (const r of c.rows.sort((a, b) => a.wo.localeCompare(b.wo))) {
  const w = byWo[r.wo], name = (w && w.Name && w.Name.DisplayName) || r.name || '';
  const s = (h) => [h.cnc, h.fab, h.fin].map(f1).join(' / ');
  const a = r.actual ? [r.actual.cnc, r.actual.fab, r.actual.fin].map(f1).join(' / ') : 'no hours';
  const recW = records.find((x) => x.work_order === r.wo);
  L.push(`| ${r.wo} | ${name} | ${(recW && recW.estimated_by) || ''} | ${r.settled ? 'yes' : 'no'} | ${r.why} | ${s(r.issued)} | ${s(r.estimate)} | ${a} | ${r.actual ? f1(r.actual.pending) : '–'} | ${Object.entries(r.exclude).map(([k, v]) => `${k}: ${v}`).join('; ') || ''} |`);
}
// Estimate accuracy by estimator: actual ÷ what went on the sheet, per area.
const byEst = {}, noHours = {};
for (const r of c.rows) {
  const rec = records.find((x) => x.work_order === r.wo), who = (rec && rec.estimated_by) || 'unknown';
  if (!r.actual) continue;
  for (const k of ['cnc', 'fab', 'fin']) {
    const est = r.issued[k];
    if (est == null || est === 0 || r.exclude[k]) continue;
    if (r.settled && !(r.actual[k] > 0)) { (noHours[who] ||= []).push(`${r.wo} ${k}`); continue; }  // booked elsewhere
    const g = ((byEst[who] ||= {})[r.settled ? 'settled' : 'running'] ||= { cnc: [0, 0, 0], fab: [0, 0, 0], fin: [0, 0, 0] })[k];
    g[0] += r.actual[k]; g[1] += est; g[2] += 1;
  }
}
L.push('', '## Estimate accuracy by estimator', '', 'Actual hours ÷ the hours on the checklist, per area (WO count in brackets). Above 1 = the shop took longer than estimated. "So far" counts work orders still running, so those ratios can only grow. Zero estimates and excluded areas are left out.', '',
  '| Estimator | Work orders | CNC | Fab | Finish |', '|---|---|---|---|---|');
const ratio = (g) => (g && g[2] ? `${(g[0] / g[1]).toFixed(2)}× (${g[2]})` : '–');
for (const [who, v] of Object.entries(byEst).sort()) {
  for (const k of ['settled', 'running']) if (v[k]) L.push(`| ${who} | ${k === 'settled' ? 'settled' : 'running (so far)'} | ${ratio(v[k].cnc)} | ${ratio(v[k].fab)} | ${ratio(v[k].fin)} |`);
}
const nh = Object.entries(noHours).map(([w, l]) => `${w}: ${l.join(', ')}`);
if (nh.length) L.push('', `Left out: finished work orders with **no hours at all** in an area that was estimated (the hours were almost certainly booked to another WO). ${nh.join('; ')}.`);
L.push('', '"Today\'s rates" is the take-off priced at the current assumptions (blank where the record has no quantities). Records come from tools/checklist; back-filled ones are marked in their source.', '');
const outDir = path.join(configDir(), 'estimating', 'calibration');
mkdirSync(outDir, { recursive: true });
const out = path.join(outDir, `${asOf}${o.snapshot ? '-snapshot-' + o.snapshot : ''}.md`);
writeFileSync(out, L.join('\n') + '\n');
console.log(`${settledN} of ${c.rows.length} work orders settled. Report: ${out}`);
for (const [bt, v] of Object.entries(c.fab)) if (v.n) console.log(`  fab ${bt}: current ${f2(v.current)}, data ${f2(v.data)} (${v.n} WO)${v.onlyDerived ? ' [set from these WOs]' : ''}`);
if (c.showpiece.n) console.log(`  showpiece: current ${f2(c.showpiece.current)}, data ${f2(c.showpiece.data)} (${c.showpiece.n})`);
if (c.cnc.n) console.log(`  CNC: actual ÷ formula ${f2(c.cnc.ratio)} (${c.cnc.n})`);
if (c.primer.n) console.log(`  primer: current ${f2(c.primer.current)}, data ${f2(c.primer.data)} (${c.primer.n})`);
