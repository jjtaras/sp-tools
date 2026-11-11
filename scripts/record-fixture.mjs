#!/usr/bin/env node
// Records a new fixture snapshot: what both boards would pull from Innergy right now, plus the
// billing dashboard from an .xlsx download. Writes $SP_CONFIG_DIR/fixtures/<date>/.
//
//   npm run fixture:record -- --billing "<path to SP BILLING DASHBOARD.xlsx>"
//
// Then review it and run `npm run fixture:freeze -- <date>` to freeze the expected outputs.
import { copyFileSync, existsSync } from 'node:fs';
import path from 'node:path';
import { parseArgs } from 'node:util';
import { requireEnv, loadEnv } from '../lib/env.mjs';
import { innergyClient } from '../adapters/innergy/client.mjs';
import { readBillingWorkbook } from '../adapters/billing-sheet/xlsx.mjs';
import { fixturesRoot, writeJson } from '../tests/lib/fixture.mjs';
import { loadGasProject } from '../tests/lib/gas.mjs';
import { configDir } from '../lib/env.mjs';

const { values: args } = parseArgs({ options: { billing: { type: 'string' }, name: { type: 'string' } } });
loadEnv();
const billingFile = args.billing || path.join(fixturesRoot(), 'SP BILLING DASHBOARD.xlsx');
if (!existsSync(billingFile)) throw new Error(`Billing workbook not found: ${billingFile}. Pass --billing <file>.`);

const TZ = 'America/New_York';
const now = new Date();
const part = (opts) => new Intl.DateTimeFormat('en-US', { timeZone: TZ, ...opts }).format(now);
const today = new Intl.DateTimeFormat('en-CA', { timeZone: TZ, year: 'numeric', month: '2-digit', day: '2-digit' }).format(now);
// Same text the tracker writes: "EEE MMM d, yyyy '·' h:mm a"
const asof = `${part({ weekday: 'short' })} ${part({ month: 'short' })} ${part({ day: 'numeric' })}, ${part({ year: 'numeric' })} · ${part({ hour: 'numeric', minute: '2-digit', hour12: true })}`;

let out = path.join(fixturesRoot(), args.name || today);
for (let i = 2; existsSync(out); i++) out = path.join(fixturesRoot(), `${args.name || today}-${i}`);

// The boards' own settings decide what gets pulled (e.g. the first timesheet month).
const margin = loadGasProject(path.join(configDir(), 'baseline', 'profitability'));
const api = innergyClient({ apiKey: requireEnv('INNERGY_API_KEY'), baseUrl: process.env.INNERGY_BASE_URL || undefined });

// ---- Margin Board: fetchInnergy_() (followRedirects: false)
const NOFOLLOW = { followRedirects: false };
const strict = (r, p) => { if (r.status !== 200) throw new Error(`Innergy ${p} returned ${r.status}`); return JSON.parse(r.text); };
const items = (o) => o.Items || o;
async function grid(p) {
  let rows = [], skip = 0;
  for (;;) {
    const q = `${p}?take=500&skip=${skip}&requireTotalCount=true`;
    const page = strict(await api.get(q, NOFOLLOW), q);
    rows = rows.concat(page.data || []);
    if (!page.data || page.data.length < 500) break;
    skip += 500;
  }
  return rows;
}
console.log('Margin Board: projects, labors, work orders, PO lines, timesheets…');
const months = margin.monthList_(margin.CONFIG.TIMESHEETS_START, now);
const tsPaths = months.map((m) => `/api/timeTracking/${m[0]}/${m[1]}`);
const marginRaw = {
  projects: items(strict(await api.get('/api/projects', NOFOLLOW), '/api/projects')),
  labors: items(strict(await api.get('/api/labors', NOFOLLOW), '/api/labors')),
  workOrders: await grid('/api/v2-unstable/project-management/work-orders'),
  poLines: await grid('/api/v2-unstable/purchasing/purchase-orders/line-items'),
  timesheets: (await api.getAll(tsPaths, NOFOLLOW)).flatMap((r, i) => [].concat(strict(r, tsPaths[i]))),
};

// ---- Production Tracker: pull_()
const loose = (r, p) => {
  if (r.status === 204) return null;
  if (r.status < 200 || r.status >= 300) throw new Error(`Innergy HTTP ${r.status} for ${p}: ${r.text.slice(0, 300)}`);
  const o = r.text ? JSON.parse(r.text) : null;
  return o && typeof o === 'object' && !Array.isArray(o) && 'Items' in o ? o.Items : o;
};
console.log('Production Tracker: open projects and their work orders and dates; POs; kanban…');
const open = loose(await api.get('/api/projects'), '/api/projects').filter((p) => (p.Status || '') !== 'Closed');
const calls = open.flatMap((p) => [
  `/api/projects/${p.Number}`, `/api/projects/${p.Id}/workOrders`, `/api/dateManagement/${p.Id}`,
]);
const res = (await api.getAll(calls)).map((r, i) => loose(r, calls[i]));
const trackerRaw = { projects: [], purchaseOrders: null, kanban: null };
open.forEach((_, i) => {
  if (!res[i * 3]) return;
  trackerRaw.projects.push({ detail: res[i * 3], workOrders: res[i * 3 + 1] || [], dates: res[i * 3 + 2] });
});
trackerRaw.purchaseOrders = loose(await api.get('/api/purchaseOrders'), '/api/purchaseOrders') || [];
trackerRaw.kanban = loose(await api.get('/api/laborKanbanGridItems'), '/api/laborKanbanGridItems') || [];

// ---- Billing dashboard
console.log('Billing dashboard workbook…');
const billing = await readBillingWorkbook(billingFile, { mstrTab: margin.CONFIG.BILLING_TAB });

writeJson(path.join(out, 'innergy-margin.json'), marginRaw);
writeJson(path.join(out, 'innergy-tracker.json'), trackerRaw);
writeJson(path.join(out, 'billing-grids.json'), billing);
copyFileSync(billingFile, path.join(out, 'billing-dashboard.xlsx'));
writeJson(path.join(out, 'meta.json'), {
  recorded_at: now.toISOString(), today, asof, timezone: TZ,
  innergy_base_url: process.env.INNERGY_BASE_URL || 'https://app.innergy.com',
  billing_source: path.basename(billingFile),
  counts: {
    margin_projects: marginRaw.projects.length, timesheet_entries: marginRaw.timesheets.length,
    work_orders: marginRaw.workOrders.length, po_lines: marginRaw.poLines.length,
    tracker_projects: trackerRaw.projects.length, purchase_orders: trackerRaw.purchaseOrders.length,
    kanban_items: trackerRaw.kanban.length, billing_rows: billing.mstr.length, billing_job_tabs: Object.keys(billing.tabs).length,
  },
}, { pretty: true });
console.log(`Recorded ${out}`);
