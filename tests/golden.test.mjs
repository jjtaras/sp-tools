// Fixture tests: every frozen snapshot, run through each board, must reproduce the frozen output
// exactly. Any difference fails until it's confirmed as intended (see scripts/freeze-fixture.mjs).
//
// By default the boards under test are the baseline copies in sp-tools-config/baseline/. Point a
// board at other code with e.g. SP_APP_DIR_MARGIN_BOARD=<folder> (used once apps/ builds exist).
import { test } from 'node:test';
import assert from 'node:assert/strict';
import path from 'node:path';
import { configDir } from '../lib/env.mjs';
import { frozenSnapshots, loadSnapshot } from './lib/fixture.mjs';
import { loadGasProject } from './lib/gas.mjs';
import { APPS } from './lib/apps.mjs';

/** Up to `max` paths where a and b differ, e.g. jobs[3].contract: 1200 → 1250 */
function differences(a, b, at = '', out = [], max = 25) {
  if (out.length >= max) return out;
  if (a === b || (Number.isNaN(a) && Number.isNaN(b))) return out;
  if (typeof a !== 'object' || typeof b !== 'object' || a === null || b === null || Array.isArray(a) !== Array.isArray(b)) {
    out.push(`${at || '(root)'}: ${JSON.stringify(a)} → ${JSON.stringify(b)}`);
    return out;
  }
  if (Array.isArray(a) && a.length !== b.length) out.push(`${at}: length ${a.length} → ${b.length}`);
  const keys = new Set([...Object.keys(a), ...Object.keys(b)]);
  for (const k of keys) {
    const label = Array.isArray(a) ? `${at}[${k}]` : at ? `${at}.${k}` : k;
    // Name the job when walking a list of job rows, so failures read "jobs[P-00-0000].contract".
    const id = Array.isArray(a) && a[k] && (a[k].job || a[k].project?.num);
    differences(a[k], b[k], id ? `${at}[${id}]` : label, out, max);
  }
  return out;
}

const snapshots = frozenSnapshots();
test('at least one frozen fixture snapshot exists', () => {
  assert.ok(snapshots.length > 0, `No frozen snapshots in ${path.join(configDir(), 'fixtures')}. Record and freeze one first.`);
});

for (const dir of snapshots) {
  const fx = loadSnapshot(dir);
  for (const [app, def] of Object.entries(APPS)) {
    const src = process.env['SP_APP_DIR_' + app.toUpperCase().replace(/-/g, '_')] || path.join(configDir(), 'baseline', def.baseline);
    test(`${fx.name} · ${app} reproduces the frozen output`, () => {
      const got = def.run(loadGasProject(src), fx);
      const want = fx.expected(app);
      const diff = differences(want, got);
      assert.ok(diff.length === 0, `${app} output changed (expected → got):\n  ` + diff.join('\n  '));
    });
  }
}
