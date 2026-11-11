// Puts an app together from its three sources, in Apps Script load order:
//   core   the shared engine (core/), bundled into one script
//   generated  assumptions.js: SP's assumptions.yaml, validated against model/schema.yaml
//   repo   the app's own generic code (apps/<app>/src/)
// The tests and the build both use this, so what's tested is exactly what gets deployed.
import { createHash } from 'node:crypto';
import { readFileSync } from 'node:fs';
import path from 'node:path';
import { REPO_ROOT, configDir } from './env.mjs';
import { bundleCore } from './core-bundle.mjs';
import { loadAssumptions, assumptionsScript } from './assumptions.mjs';

export const APP_NAMES = ['profitability', 'shop-schedule'];

/** @returns {{ app: string, title: string, files: {name: string, content: string}[], configHash: string }} */
export function assembleApp(app) {
  const appDir = path.join(REPO_ROOT, 'apps', app);
  const spDir = path.join(configDir(), 'apps', app);
  const manifest = JSON.parse(readFileSync(path.join(appDir, 'app.json'), 'utf8'));
  const files = [{ name: 'core.js', content: bundleCore() }];
  const hash = createHash('sha256');
  const assumptions = loadAssumptions();
  for (const f of manifest.files) {
    if (f.source === 'generated') {
      if (f.path !== 'assumptions.js') throw new Error(`${app}/app.json: unknown generated file "${f.path}"`);
      hash.update('assumptions\0' + assumptions.hash + '\0');
      files.push({ name: 'assumptions.js', content: assumptionsScript(assumptions) });
      continue;
    }
    const from = f.source === 'sp' ? spDir : f.source === 'repo' ? appDir : null;
    if (!from) throw new Error(`${app}/app.json: unknown source "${f.source}"`);
    const content = readFileSync(path.join(from, f.path), 'utf8');
    if (f.source === 'sp') hash.update(f.path + '\0' + content + '\0');
    files.push({ name: path.basename(f.path), content });
  }
  return { app, title: manifest.title, files, configHash: hash.digest('hex').slice(0, 12), assumptionsHash: assumptions.hash };
}

/** Script files only, in load order (what the test sandbox runs). */
export const scriptFiles = (assembled) => assembled.files.filter((f) => /\.(js|gs)$/.test(f.name));
