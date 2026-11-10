// Bundles core/ into one Apps Script file that defines the global `SPCore`.
// Apps Script has no modules, so the engine ships as an IIFE alongside each board's code.
import { buildSync } from 'esbuild';
import path from 'node:path';
import { REPO_ROOT } from './env.mjs';

let cached;
export function bundleCore() {
  if (cached) return cached;
  const out = buildSync({
    entryPoints: [path.join(REPO_ROOT, 'core', 'index.mjs')],
    bundle: true, write: false, format: 'iife', globalName: 'SPCore',
    target: 'es2019', platform: 'neutral', charset: 'utf8', legalComments: 'none',
  });
  cached = '// sp-tools engine (core/), bundled at build time. Do not edit here.\n' + out.outputFiles[0].text;
  return cached;
}
