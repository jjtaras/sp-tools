// Fixture tests: every frozen snapshot, run through each board, must reproduce the frozen output
// exactly. Any difference fails until it's confirmed as intended (see scripts/freeze-fixture.mjs).
//
// The boards under test are assembled from this repo (core/ + apps/<app>/src) plus SP's settings,
// exactly as the build deploys them. To test some other copy instead (e.g. a clasp clone), point
// a board at its folder with SP_APP_DIR_MARGIN_BOARD=<folder> or SP_APP_DIR_PRODUCTION_TRACKER=<folder>.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import path from 'node:path';
import { configDir } from '../lib/env.mjs';
import { assembleApp, scriptFiles } from '../lib/assemble.mjs';
import { frozenSnapshots, loadSnapshot } from './lib/fixture.mjs';
import { loadGasFiles, loadGasProject } from './lib/gas.mjs';
import { APPS } from './lib/apps.mjs';
import { differences } from './lib/diff.mjs';

const snapshots = frozenSnapshots();
test('at least one frozen fixture snapshot exists', () => {
  assert.ok(snapshots.length > 0, `No frozen snapshots in ${path.join(configDir(), 'fixtures')}. Record and freeze one first.`);
});

for (const dir of snapshots) {
  const fx = loadSnapshot(dir);
  for (const [app, def] of Object.entries(APPS)) {
    const override = process.env['SP_APP_DIR_' + app.toUpperCase().replace(/-/g, '_')];
    test(`${fx.name} · ${app} reproduces the frozen output`, () => {
      const ctx = override ? loadGasProject(override) : loadGasFiles(scriptFiles(assembleApp(def.baseline)));
      const got = def.run(ctx, fx);
      const want = fx.expected(app);
      const diff = differences(want, got);
      assert.ok(diff.length === 0, `${app} output changed (expected → got):\n  ` + diff.join('\n  '));
    });
  }
}
