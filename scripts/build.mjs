#!/usr/bin/env node
// Builds each board into dist/<app>/: the engine bundle, the board's code, SP's settings and page,
// and appsscript.json. This is exactly what the fixture tests run. Deploying it is step 4.
//
//   npm run build            all boards
//   npm run build -- <app>   one board (profitability | shop-schedule)
import { execFileSync } from 'node:child_process';
import { copyFileSync, mkdirSync, rmSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { REPO_ROOT } from '../lib/env.mjs';
import { APP_NAMES, assembleApp } from '../lib/assemble.mjs';

const which = process.argv[2] ? [process.argv[2]] : APP_NAMES;
for (const app of which) if (!APP_NAMES.includes(app)) throw new Error(`Unknown app "${app}". Use one of: ${APP_NAMES.join(', ')}`);

const git = (...a) => { try { return execFileSync('git', a, { cwd: REPO_ROOT, encoding: 'utf8' }).trim(); } catch { return null; } };
const commit = git('rev-parse', '--short', 'HEAD');
const dirty = !!git('status', '--porcelain');

for (const app of which) {
  const a = assembleApp(app);
  const out = path.join(REPO_ROOT, 'dist', app);
  rmSync(out, { recursive: true, force: true });
  mkdirSync(out, { recursive: true });
  for (const f of a.files) writeFileSync(path.join(out, f.name), f.content);
  copyFileSync(path.join(REPO_ROOT, 'apps', app, 'appsscript.json'), path.join(out, 'appsscript.json'));
  const build = { app, title: a.title, commit, uncommitted_changes: dirty, config_hash: a.configHash, built_at: new Date().toISOString(),
    load_order: a.files.filter((f) => /\.(js|gs)$/.test(f.name)).map((f) => f.name) };
  writeFileSync(path.join(out, 'BUILD.json'), JSON.stringify(build, null, 2) + '\n');
  console.log(`${app}: dist/${app}/ (commit ${commit}${dirty ? ' + uncommitted changes' : ''}, config ${a.configHash})`);
}
