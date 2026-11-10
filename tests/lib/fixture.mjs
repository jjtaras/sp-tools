// Frozen fixtures live in $SP_CONFIG_DIR/fixtures/<snapshot>/ (SP-owned, never in this repo).
//
//   meta.json                 when and how the snapshot was taken
//   innergy-margin.json       what the Margin Board pulled from Innergy
//   innergy-tracker.json      what the Production Tracker pulled from Innergy
//   billing-grids.json        MSTR + job-tab value grids from the billing dashboard .xlsx
//   expected/<app>.json       board output, frozen from the baseline code
//   manifest.json             SHA-256 of every file above; a test fails if any file changes
import { createHash } from 'node:crypto';
import { readFileSync, writeFileSync, readdirSync, existsSync, mkdirSync } from 'node:fs';
import path from 'node:path';
import { configDir } from '../../lib/env.mjs';

export const INPUT_FILES = ['meta.json', 'innergy-margin.json', 'innergy-tracker.json', 'billing-grids.json'];

export const fixturesRoot = () => path.join(configDir(), 'fixtures');

/** Snapshot folders that have been frozen (have a manifest). */
export function frozenSnapshots() {
  const root = fixturesRoot();
  if (!existsSync(root)) return [];
  return readdirSync(root, { withFileTypes: true })
    .filter((d) => d.isDirectory() && existsSync(path.join(root, d.name, 'manifest.json')))
    .map((d) => path.join(root, d.name))
    .sort();
}

const sha256 = (file) => createHash('sha256').update(readFileSync(file)).digest('hex');

// Dates survive JSON as {"$date": iso} so the boards see real Date objects, as getValues() returns them.
const replacer = function (key, v) { return this[key] instanceof Date ? { $date: this[key].toISOString() } : v; };
const reviver = (_, v) => (v && typeof v === 'object' && typeof v.$date === 'string' && Object.keys(v).length === 1 ? new Date(v.$date) : v);

export function writeJson(file, obj, { pretty = false } = {}) {
  mkdirSync(path.dirname(file), { recursive: true });
  writeFileSync(file, JSON.stringify(obj, replacer, pretty ? 2 : undefined) + '\n');
}
export const readJson = (file) => JSON.parse(readFileSync(file, 'utf8'), reviver);

export function writeManifest(dir, files) {
  const hashes = {};
  for (const f of files) hashes[f] = sha256(path.join(dir, f));
  writeJson(path.join(dir, 'manifest.json'), { frozen_at: new Date().toISOString(), sha256: hashes }, { pretty: true });
}

/** Loads a snapshot after checking every file against its manifest. */
export function loadSnapshot(dir) {
  const manifest = readJson(path.join(dir, 'manifest.json'));
  for (const [f, h] of Object.entries(manifest.sha256)) {
    const p = path.join(dir, f);
    if (!existsSync(p)) throw new Error(`Fixture file missing: ${p}`);
    if (sha256(p) !== h) throw new Error(`Fixture file changed since it was frozen: ${p}`);
  }
  const fx = { dir, name: path.basename(dir), manifest };
  fx.meta = readJson(path.join(dir, 'meta.json'));
  fx.margin = readJson(path.join(dir, 'innergy-margin.json'));
  fx.tracker = readJson(path.join(dir, 'innergy-tracker.json'));
  fx.billing = readJson(path.join(dir, 'billing-grids.json'));
  fx.expected = (app) => readJson(path.join(dir, 'expected', app + '.json'));
  return fx;
}
