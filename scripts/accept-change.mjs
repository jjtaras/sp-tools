#!/usr/bin/env node
// Accepts an intended output change: reruns the current boards (repo code + assumptions.yaml) on a
// frozen snapshot, prints what changed, and with --yes saves it as the new expected output and
// re-signs the manifest. The snapshot's input data never changes.
//
//   npm run fixture:accept -- <snapshot>          show what would change
//   npm run fixture:accept -- <snapshot> --yes    accept it
//
// Log the change and its reason in the SP config CHANGELOG (paste the summary this prints).
import path from 'node:path';
import { parseArgs } from 'node:util';
import { assembleApp, scriptFiles } from '../lib/assemble.mjs';
import { fixturesRoot, loadSnapshot, readJson, writeJson, writeManifest } from '../tests/lib/fixture.mjs';
import { loadGasFiles } from '../tests/lib/gas.mjs';
import { APPS } from '../tests/lib/apps.mjs';
import { changeSummary } from '../tests/lib/diff.mjs';

const { values: opts, positionals } = parseArgs({ allowPositionals: true, options: { yes: { type: 'boolean' } } });
const name = positionals[0];
if (!name) throw new Error('Usage: npm run fixture:accept -- <snapshot> [--yes]');
const dir = path.join(fixturesRoot(), name);
const fx = loadSnapshot(dir);

const changed = [];
for (const [app, def] of Object.entries(APPS)) {
  const got = def.run(loadGasFiles(scriptFiles(assembleApp(def.baseline))), fx);
  const s = changeSummary(fx.expected(app), got);
  console.log(`\n${app}: ${s.total ? s.total + ' values changed' : 'no change'}`);
  for (const [k, n] of Object.entries(s.groups).sort((x, y) => y[1] - x[1])) console.log(`  ${String(n).padStart(5)}  ${k}`);
  if (s.total) { console.log('  e.g.'); s.sample.forEach((d) => console.log('    ' + d)); changed.push([app, got]); }
}
if (!changed.length) { console.log('\nNothing to accept.'); process.exit(0); }
if (!opts.yes) { console.log('\nNot saved. Rerun with --yes to accept these changes.'); process.exit(0); }
for (const [app, got] of changed) writeJson(path.join(dir, 'expected', app + '.json'), got, { pretty: true });
writeManifest(dir, Object.keys(readJson(path.join(dir, 'manifest.json')).sha256));
console.log(`\nAccepted. New expected output saved for ${changed.map((c) => c[0]).join(', ')}.`);
