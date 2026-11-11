#!/usr/bin/env node
// Puts a board back the way it was before sp-tools deployed it: pushes the baseline code from
// sp-tools-config/baseline/<app>/ (triggers run pushed code) and points the live deployment back at
// the previous version from deploy.yaml.
//
//   npm run rollback -- <app> [--dry-run]
import { execFileSync } from 'node:child_process';
import { cpSync, readFileSync, rmSync, writeFileSync, mkdtempSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { parseArgs } from 'node:util';
import YAML from 'yaml';
import { configDir } from '../lib/env.mjs';

const { values: o, positionals } = parseArgs({ allowPositionals: true, options: { 'dry-run': { type: 'boolean' } } });
const app = positionals[0];
const targets = YAML.parse(readFileSync(path.join(configDir(), 'deploy.yaml'), 'utf8'));
const t = targets[app];
if (!t) throw new Error(`Usage: npm run rollback -- <${Object.keys(targets).join('|')}>`);
const dir = mkdtempSync(path.join(os.tmpdir(), `rollback-${app}-`));
cpSync(path.join(configDir(), 'baseline', app), dir, { recursive: true });
const clasp = JSON.parse(readFileSync(path.join(dir, '.clasp.json'), 'utf8'));
if (clasp.scriptId !== t.script_id) throw new Error(`baseline .clasp.json is for ${clasp.scriptId}, deploy.yaml says ${t.script_id}`);
clasp.rootDir = '';
writeFileSync(path.join(dir, '.clasp.json'), JSON.stringify(clasp, null, 2));
console.log(`${t.title}: push baseline code, live deployment → version ${t.previous_version}`);
if (o['dry-run']) { console.log('dry run: nothing changed'); process.exit(0); }
const sh = (args) => execFileSync('clasp', args, { cwd: dir, encoding: 'utf8' }).trim();
console.log(sh(['push', '--force']).split('\n').pop());
console.log(sh(['update-deployment', t.deployment_id, '-V', String(t.previous_version), '-d', `rollback to version ${t.previous_version}`]).split('\n').pop());
rmSync(dir, { recursive: true, force: true });
console.log('Rolled back.');
