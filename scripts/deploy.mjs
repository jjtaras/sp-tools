#!/usr/bin/env node
// Deploys boards to their live Apps Script deployments, following the release rules in CLAUDE.md:
// tests pass, version bumped, CHANGELOG entry, git tag on HEAD, and the deployment description
// names the tag and the config (assumptions.yaml) fingerprint.
//
//   npm run deploy -- [app ...] [--dry-run]
//
// Targets (script and deployment IDs) come from sp-tools-config/deploy.yaml.
// Note: Apps Script triggers always run the pushed code, so push and the live switch happen together.
import { execFileSync } from 'node:child_process';
import { readFileSync, writeFileSync, mkdirSync, rmSync, copyFileSync } from 'node:fs';
import path from 'node:path';
import { parseArgs } from 'node:util';
import YAML from 'yaml';
import { REPO_ROOT, configDir } from '../lib/env.mjs';
import { APP_NAMES, assembleApp } from '../lib/assemble.mjs';

const { values: o, positionals } = parseArgs({ allowPositionals: true, options: { 'dry-run': { type: 'boolean' } } });
const apps = positionals.length ? positionals : APP_NAMES;
for (const a of apps) if (!APP_NAMES.includes(a)) throw new Error(`Unknown app "${a}"`);
const sh = (cmd, args, cwd = REPO_ROOT) => execFileSync(cmd, args, { cwd, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] }).trim();
const fail = (m) => { console.error('Not deploying: ' + m); process.exit(1); };

// ---- release checks
const version = JSON.parse(readFileSync(path.join(REPO_ROOT, 'package.json'), 'utf8')).version;
const tag = 'v' + version;
if (sh('git', ['status', '--porcelain'])) fail('uncommitted changes. Commit first.');
let tagged = '';
try { tagged = sh('git', ['rev-list', '-n', '1', tag]); } catch { fail(`no git tag ${tag}. Bump the version, update the CHANGELOGs, commit, then: git tag ${tag}`); }
if (tagged !== sh('git', ['rev-parse', 'HEAD'])) fail(`tag ${tag} isn't on HEAD.`);
if (!readFileSync(path.join(REPO_ROOT, 'CHANGELOG.md'), 'utf8').includes(`## ${version}`)) fail(`CHANGELOG.md has no "## ${version}" entry.`);
for (const a of apps) if (!readFileSync(path.join(REPO_ROOT, 'apps', a, 'CHANGELOG.md'), 'utf8').includes(`## ${version}`)) fail(`apps/${a}/CHANGELOG.md has no "## ${version}" entry.`);
console.log('Running tests…');
try { sh('node', ['--test', 'tests/']); } catch (e) { console.error(e.stdout || e.message); fail('tests failed.'); }

const targets = YAML.parse(readFileSync(path.join(configDir(), 'deploy.yaml'), 'utf8'));
for (const app of apps) {
  const t = targets[app];
  if (!t || !t.script_id || !t.deployment_id) fail(`deploy.yaml has no script_id/deployment_id for ${app}.`);
  const a = assembleApp(app);
  const desc = `sp-tools ${tag} · config ${a.configHash}`;
  const out = path.join(REPO_ROOT, 'dist', app);
  rmSync(out, { recursive: true, force: true });
  mkdirSync(out, { recursive: true });
  for (const f of a.files) writeFileSync(path.join(out, f.name), f.content);
  copyFileSync(path.join(REPO_ROOT, 'apps', app, 'appsscript.json'), path.join(out, 'appsscript.json'));
  const order = a.files.filter((f) => /\.(js|gs)$/.test(f.name)).map((f) => f.name);
  writeFileSync(path.join(out, '.clasp.json'), JSON.stringify({ scriptId: t.script_id, rootDir: '', scriptExtensions: ['.js', '.gs'], htmlExtensions: ['.html'], jsonExtensions: ['.json'], filePushOrder: order }, null, 2) + '\n');
  writeFileSync(path.join(out, '.claspignore'), 'BUILD.json\n.clasp.json\n');
  writeFileSync(path.join(out, 'BUILD.json'), JSON.stringify({ app, tag, config_hash: a.configHash, assumptions_hash: a.assumptionsHash, commit: sh('git', ['rev-parse', '--short', 'HEAD']), built_at: new Date().toISOString(), load_order: order }, null, 2) + '\n');
  console.log(`\n${t.title} (${app}): ${desc}\n  files: ${a.files.map((f) => f.name).join(', ')}`);
  if (o['dry-run']) { console.log('  dry run: not pushed'); continue; }
  console.log('  ' + sh('clasp', ['push', '--force'], out).split('\n').pop());
  const v = sh('clasp', ['create-version', desc], out);
  const n = (v.match(/version (\d+)/i) || [])[1];
  if (!n) fail(`couldn't read the new version number from: ${v}`);
  console.log(`  version ${n} created`);
  console.log('  ' + sh('clasp', ['update-deployment', t.deployment_id, '-V', n, '-d', desc], out).split('\n').pop());
  console.log(`  live: https://script.google.com/a/macros/studiopracticenyc.com/s/${t.deployment_id}/exec`);
  console.log(`  rollback: npm run rollback -- ${app}`);
}
