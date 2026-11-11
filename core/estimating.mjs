// Calibrating the shop-hours estimating rates from finished work orders.
// Pure functions: estimate records + timesheets + work-order status in, rate evidence out.
import { classifyLabor } from './labor.mjs';
import { durationHours } from './innergy.mjs';

/** Which shop area a labor item books to: 'cnc' | 'fab' | 'fin', or null (drafting, install, delivery...). */
export function shopArea(laborItemName) {
  const n = String(laborItemName || '').toUpperCase();
  if (n.includes('CNC')) return 'cnc';
  if (n.includes('FINISH')) return 'fin';
  if (n.includes('FABRICATION')) return 'fab';
  return null;
}

/**
 * Actual hours per work order and area, from timesheets. Overhead (by the shared labor rules) is
 * left out. Returns { [wo]: { cnc, fab, fin, other, pending, last } }, last = latest entry date.
 */
export function woActuals(timesheets, rules, wos) {
  const want = wos ? new Set(wos) : null;
  const out = {};
  for (const t of timesheets) {
    const wo = t.WorkOrderNumber;
    if (!wo || (want && !want.has(wo))) continue;
    if (classifyLabor(t.LaborItemName, t.EmployeeDepartment, rules) === 'overhead') continue;
    const a = (out[wo] ||= { cnc: 0, fab: 0, fin: 0, other: 0, pending: 0, last: null });
    const h = durationHours(t.ActivityDuration);
    a[shopArea(t.LaborItemName) || 'other'] += h;
    if (t.ActivityStatus !== 'Approved') a.pending += h;
    const d = String(t.ActivityDate || '').slice(0, 10);
    if (d && (!a.last || d > a.last)) a.last = d;
  }
  return out;
}

const daysBetween = (a, b) => Math.round((Date.parse(b) - Date.parse(a)) / 864e5);

/** Innergy workflow statuses that mean the work order is finished. */
export const DONE_STATUSES = ['Completed', 'Closed'];

/** Settled = finished in Innergy (Completed or Closed) and no hours for `days` (the hours have stopped). */
export function settledStatus(actual, workflowStatus, asOf, days) {
  if (!DONE_STATUSES.includes(workflowStatus)) return { settled: false, why: `not Completed (${workflowStatus || 'unknown'})` };
  if (!actual || !actual.last) return { settled: false, why: 'no hours booked' };
  const quiet = daysBetween(actual.last, asOf);
  if (quiet < days) return { settled: false, why: `hours ${quiet} days ago (needs ${days})` };
  return { settled: true, why: `Completed, quiet ${quiet} days` };
}

const sum = (xs) => xs.reduce((s, x) => s + x, 0);

/** Least squares y = a + b·x. Null with fewer than 3 points or no spread in x. */
export function linearFit(points) {
  if (points.length < 3) return null;
  const n = points.length, mx = sum(points.map((p) => p.x)) / n, my = sum(points.map((p) => p.y)) / n;
  const sxx = sum(points.map((p) => (p.x - mx) ** 2));
  if (!sxx) return null;
  const b = sum(points.map((p) => (p.x - mx) * (p.y - my))) / sxx;
  return { base: my - b * mx, per: b };
}

/**
 * Rate evidence from settled records.
 * @param records  estimate records (tools/checklist estimate.py)
 * @param actuals  woActuals() output
 * @param status   { [wo]: workflowStatus }
 * @param rates    current rates { fab: {type: h/sqft}, showpiece, cnc: {base, per_part}, primer }
 * @param opts     { asOf: 'YYYY-MM-DD', settledDays }
 */
export function calibrate(records, actuals, status, rates, { asOf, settledDays }) {
  const rows = [], fabPts = {}, showPts = [], cncPts = [], finPts = [];
  for (const r of records) {
    const wo = r.work_order, a = actuals[wo], st = settledStatus(a, status[wo], asOf, settledDays);
    const ex = r.exclude || {}, t = r.takeoff || {}, lines = (r.estimate && r.estimate.lines) || [];
    rows.push({ wo, name: r.name, project: r.project_number, settled: st.settled, why: st.why, issued: r.issued_hours || {},
      estimate: (r.estimate && r.estimate.hours) || {}, actual: a || null, exclude: ex });
    if (!st.settled) continue;
    const empty = (k) => !(a[k] > 0);
    // Fabrication: a WO whose take-off is one build type, no showpiece, no allowance → a clean rate point.
    if (!ex.fab && !empty('fab') && lines.length) {
      const types = new Set(lines.map((l) => l.build_type));
      const show = lines.filter((l) => l.showpiece), plain = lines.filter((l) => !l.showpiece);
      const allowance = Number(t.fab_allowance_hours || 0);
      if (types.size === 1 && !show.length && !allowance) {
        const bt = lines[0].build_type, sq = sum(lines.map((l) => l.sq_ft));
        (fabPts[bt] ||= []).push({ wo, project: r.project_number, sq_ft: sq, hours: a.fab, rate: a.fab / sq, derived: lines.some((l) => l.derived || (t.elevations || []).some((e) => e.derived)) });
      } else if (show.length) {
        // Showpiece: back out the plain elevations and the allowance at today's rates.
        const plainH = sum(plain.map((l) => l.sq_ft * rates.fab[l.build_type])) + allowance;
        const showSq = sum(show.map((l) => l.sq_ft)), cased = rates.fab[show[0].build_type];
        const per = (a.fab - plainH) / showSq;
        showPts.push({ wo, project: r.project_number, sq_ft: showSq, hours: a.fab - plainH, rate: per, cased, multiplier: per / cased });
      }
    }
    if (!ex.cnc && !empty('cnc') && t.part_count != null) cncPts.push({ wo, project: r.project_number, x: Number(t.part_count), y: a.cnc,
      predicted: rates.cnc.base + rates.cnc.per_part * Number(t.part_count) });
    if (!ex.fin && !empty('fin') && t.primed_sq_ft != null) finPts.push({ wo, project: r.project_number, sq_ft: Number(t.primed_sq_ft), hours: a.fin, rate: a.fin / Number(t.primed_sq_ft) });
  }
  const pooled = (pts) => (pts.length ? sum(pts.map((p) => p.hours)) / sum(pts.map((p) => p.sq_ft)) : null);
  const jobs = (pts) => [...new Set(pts.map((p) => p.project))];
  const fab = {};
  for (const bt of Object.keys(rates.fab)) {
    const pts = fabPts[bt] || [], v = pooled(pts);
    fab[bt] = { current: rates.fab[bt], data: v, n: pts.length, jobs: jobs(pts), points: pts, drift: v == null ? null : v / rates.fab[bt] - 1,
      onlyDerived: pts.length > 0 && pts.every((p) => p.derived) };
  }
  // Multiplier, pooled: showpiece hours ÷ what the same area would take at its own cased rate.
  const showMult = showPts.length ? sum(showPts.map((p) => p.hours)) / sum(showPts.map((p) => p.sq_ft * p.cased)) : null;
  const fit = linearFit(cncPts);
  const finV = pooled(finPts);
  return {
    rows,
    fab,
    showpiece: { current: rates.showpiece, data: showMult, n: showPts.length, jobs: jobs(showPts), points: showPts },
    cnc: { current: rates.cnc, fit, n: cncPts.length, jobs: jobs(cncPts), points: cncPts,
      ratio: cncPts.length ? sum(cncPts.map((p) => p.y)) / sum(cncPts.map((p) => p.predicted)) : null },
    primer: { current: rates.primer, data: finV, n: finPts.length, jobs: jobs(finPts), points: finPts, drift: finV == null ? null : finV / rates.primer - 1 },
  };
}
