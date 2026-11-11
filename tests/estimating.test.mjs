// Unit tests for core/estimating.mjs. Made-up work orders only.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { shopArea, woActuals, settledStatus, linearFit, calibrate, laborRules } from '../core/index.mjs';

const rules = laborRules([], { overhead_items: ['FOREMAN'], drafting_items: [], drafting_type_prefix: 'Drafting', drafting_department_prefix: '3 -' });
const ts = (wo, item, dur, date, status = 'Approved') => ({ WorkOrderNumber: wo, LaborItemName: item, ActivityDuration: dur, ActivityDate: date + 'T08:00:00', ActivityStatus: status, EmployeeDepartment: '5 - Production' });

test('shop areas by labor item', () => {
  assert.equal(shopArea('002 - CNC'), 'cnc');
  assert.equal(shopArea('003 - FABRICATION: Wood Shop'), 'fab');
  assert.equal(shopArea('004 - Finishing'), 'fin');
  assert.equal(shopArea('006 -Installation'), null);
});

test('actuals per WO: areas, pending, last date; overhead left out', () => {
  const a = woActuals([ts('W1', '002 - CNC', '02:00:00', '2026-01-02'), ts('W1', '003 - FABRICATION: Wood Shop', '10:30:00', '2026-01-05', 'Pending'),
    ts('W1', 'FOREMAN', '05:00:00', '2026-01-20'), ts('W2', '004 - Finishing', '01:00:00', '2026-01-03')], rules);
  assert.deepEqual(a.W1, { cnc: 2, fab: 10.5, fin: 0, other: 0, pending: 10.5, last: '2026-01-05' });
  assert.equal(a.W2.fin, 1);
});

test('settled needs Completed and a quiet period', () => {
  assert.equal(settledStatus({ last: '2026-01-01' }, 'Completed', '2026-01-20', 14).settled, true);
  assert.equal(settledStatus({ last: '2026-01-10' }, 'Completed', '2026-01-20', 14).settled, false);
  assert.equal(settledStatus({ last: '2026-01-01' }, 'On Schedule', '2026-01-20', 14).settled, false);
  assert.equal(settledStatus(null, 'Completed', '2026-01-20', 14).settled, false);
});

test('linear fit', () => {
  const f = linearFit([{ x: 0, y: 1 }, { x: 10, y: 21 }, { x: 20, y: 41 }]);
  assert.ok(Math.abs(f.base - 1) < 1e-9 && Math.abs(f.per - 2) < 1e-9);
  assert.equal(linearFit([{ x: 1, y: 1 }, { x: 2, y: 2 }]), null);
});

test('calibrate: clean fab points pool by build type; showpiece backs out the plain part; exclusions respected', () => {
  const rates = { fab: { cased: 2, tower: 1 }, showpiece: 3, cnc: { base: 5, per_part: 0.1 }, primer: 0.1 };
  const rec = (wo, lines, extra = {}) => ({ work_order: wo, project_number: 'P-1', takeoff: extra.takeoff || {}, exclude: extra.exclude || {},
    estimate: { lines: lines.map(([sq, bt, show]) => ({ sq_ft: sq, build_type: bt, showpiece: !!show })) } });
  const records = [
    rec('A', [[100, 'cased']], { takeoff: { part_count: 50 } }),          // 250 h → 2.5
    rec('B', [[50, 'cased']]),                                              // 100 h → 2.0
    rec('C', [[40, 'cased'], [10, 'cased', true]]),                          // 40×2=80 plain, 10 sq ft show → (180−80)/10 = 10 → 5× cased
    rec('D', [[30, 'tower']], { exclude: { fab: 'logged elsewhere' } }),
    rec('E', [[30, 'tower']]),                                               // running → ignored
  ];
  const actuals = { A: { fab: 250, cnc: 12, fin: 0, last: '2026-01-01' }, B: { fab: 100, cnc: 0, fin: 0, last: '2026-01-01' },
    C: { fab: 180, cnc: 0, fin: 0, last: '2026-01-01' }, D: { fab: 1, cnc: 0, fin: 0, last: '2026-01-01' }, E: { fab: 5, cnc: 0, fin: 0, last: '2026-01-19' } };
  const status = { A: 'Completed', B: 'Completed', C: 'Completed', D: 'Completed', E: 'Completed' };
  const c = calibrate(records, actuals, status, rates, { asOf: '2026-01-20', settledDays: 14 });
  assert.equal(c.fab.cased.n, 2);
  assert.ok(Math.abs(c.fab.cased.data - 350 / 150) < 1e-9);
  assert.equal(c.fab.tower.n, 0);                     // D excluded, E not settled
  assert.equal(c.showpiece.n, 1);
  assert.ok(Math.abs(c.showpiece.data - 5) < 1e-9);
  assert.equal(c.cnc.n, 1);
  assert.ok(Math.abs(c.cnc.ratio - 12 / 10) < 1e-9);
  assert.equal(c.rows.find((r) => r.wo === 'E').settled, false);
});
