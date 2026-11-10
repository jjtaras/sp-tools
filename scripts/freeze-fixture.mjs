#!/usr/bin/env node
// Freezes a recorded snapshot: runs the baseline board code (sp-tools-config/baseline/) on it,
// saves each board's output as expected/<app>.json, and writes manifest.json with file hashes.
//
//   npm run fixture:freeze -- <snapshot folder name>
//
// Refuses to overwrite a frozen snapshot. To change expected output, record a new snapshot,
// or confirm the change is intended and log it in the SP config CHANGELOG.
import { existsSync } from 'node:fs';
import path from 'node:path';
import { configDir } from '../lib/env.mjs';
import { fixturesRoot, INPUT_FILES, readJson, writeJson, writeManifest } from '../tests/lib/fixture.mjs';
import { loadGasProject } from '../tests/lib/gas.mjs';
import { APPS } from '../tests/lib/apps.mjs';

const name = process.argv[2];
if (!name) throw new Error('Usage: npm run fixture:freeze -- <snapshot folder name>');
const dir = path.join(fixturesRoot(), name);
if (!existsSync(dir)) throw new Error(`No snapshot folder ${dir}`);
if (existsSync(path.join(dir, 'manifest.json'))) throw new Error(`${name} is already frozen.`);

const fx = {
  meta: readJson(path.join(dir, 'meta.json')),
  margin: readJson(path.join(dir, 'innergy-margin.json')),
  tracker: readJson(path.join(dir, 'innergy-tracker.json')),
  billing: readJson(path.join(dir, 'billing-grids.json')),
};
const files = [...INPUT_FILES, 'billing-dashboard.xlsx'];
for (const [app, def] of Object.entries(APPS)) {
  const ctx = loadGasProject(path.join(configDir(), 'baseline', def.baseline));
  const a = def.run(ctx, fx), b = def.run(loadGasProject(path.join(configDir(), 'baseline', def.baseline)), fx);
  if (JSON.stringify(a) !== JSON.stringify(b)) throw new Error(`${app}: two runs on the same snapshot disagree; output is not deterministic.`);
  writeJson(path.join(dir, 'expected', app + '.json'), a, { pretty: true });
  files.push(`expected/${app}.json`);
  console.log(`${app}: expected output written`);
}
writeManifest(dir, files);
console.log(`Frozen ${dir}`);
