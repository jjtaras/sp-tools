// Loads SP's assumptions.yaml and checks it against model/schema.yaml. Any problem fails loudly,
// listing every issue; there is no fallback to older values.
import { createHash } from 'node:crypto';
import { readFileSync, existsSync } from 'node:fs';
import path from 'node:path';
import YAML from 'yaml';
import { REPO_ROOT, configDir } from './env.mjs';

const schemaFile = path.join(REPO_ROOT, 'model', 'schema.yaml');
const ENTRY_FIELDS = new Set(['value', 'since', 'source', 'replaces', 'note']);
const isObj = (x) => x && typeof x === 'object' && !Array.isArray(x);

function checkType(type, v) {
  const num = (x) => typeof x === 'number' && Number.isFinite(x);
  const share = (x) => num(x) && x >= 0 && x <= 1;
  switch (type) {
    case 'number': return num(v);
    case 'share': return share(v);
    case 'string': return typeof v === 'string' && v.length > 0;
    case 'regex': try { return typeof v === 'string' && !!new RegExp(v); } catch { return false; }
    case 'month': return typeof v === 'string' && /^\d{4}-\d{2}$/.test(v);
    case 'date': return typeof v === 'string' && /^\d{4}-\d{2}-\d{2}$/.test(v);
    case 'list<string>': return Array.isArray(v) && v.every((x) => typeof x === 'string');
    case 'map<string>': return isObj(v) && Object.values(v).every((x) => typeof x === 'string');
    case 'map<number>': return isObj(v) && Object.values(v).every(num);
    case 'map<share>': return isObj(v) && Object.values(v).every(share);
    case 'map<any>': return isObj(v);
    default: throw new Error(`schema.yaml: unknown type "${type}"`);
  }
}

/**
 * @returns {{ values: object, jobFixes: object, hash: string, file: string, raw: object }}
 *   values: nested by dotted key, e.g. values.labor.rate_drafting
 */
export function loadAssumptions(file = path.join(configDir(), 'assumptions.yaml')) {
  if (!existsSync(file)) throw new Error(`No assumptions file at ${file}`);
  const schema = YAML.parse(readFileSync(schemaFile, 'utf8'));
  const text = readFileSync(file, 'utf8');
  const doc = YAML.parse(text);
  const problems = [];
  if (!isObj(doc)) throw new Error(`${file} is not a YAML mapping`);
  if (doc.version !== schema.version) problems.push(`version is ${doc.version}, schema expects ${schema.version}`);

  const A = doc.assumptions || {};
  for (const key of Object.keys(schema.assumptions)) if (!(key in A)) problems.push(`assumptions.${key} is missing`);
  for (const [key, e] of Object.entries(A)) {
    const s = schema.assumptions[key];
    if (!s) { problems.push(`assumptions.${key} is not in the schema`); continue; }
    if (!isObj(e) || !('value' in e)) { problems.push(`assumptions.${key} needs value, since and source`); continue; }
    for (const f of Object.keys(e)) if (!ENTRY_FIELDS.has(f)) problems.push(`assumptions.${key}: unknown field "${f}"`);
    if (!checkType(s.type, e.value)) problems.push(`assumptions.${key}: value ${JSON.stringify(e.value)} is not a ${s.type}`);
    if (!(typeof e.since === 'string' && /^\d{4}-\d{2}(-\d{2})?$/.test(e.since))) problems.push(`assumptions.${key}: since must be YYYY-MM or YYYY-MM-DD`);
    if (!(typeof e.source === 'string' && e.source.trim())) problems.push(`assumptions.${key}: source is required`);
  }
  const J = doc.job_fixes || {};
  for (const key of Object.keys(schema.job_fixes)) if (!(key in J)) problems.push(`job_fixes.${key} is missing`);
  for (const [key, v] of Object.entries(J)) {
    const s = schema.job_fixes[key];
    if (!s) problems.push(`job_fixes.${key} is not in the schema`);
    else if (!checkType(s.type, v)) problems.push(`job_fixes.${key} is not a ${s.type}`);
  }
  // Cross-checks
  const v = (k) => A[k] && A[k].value;
  if (typeof v('cost.margin_target') === 'number' && Math.abs(v('cost.margin_target') - (1 - v('cost.overhead_share') - v('cost.cogs_share'))) > 1e-9)
    problems.push('cost.margin_target must equal 1 - cost.overhead_share - cost.cogs_share');

  const w = v('outlook.progress_weights');
  if (w && Math.abs((w.drafting || 0) + (w.shop || 0) - 1) > 1e-9) problems.push('outlook.progress_weights: drafting + shop must equal 1');

  if (problems.length) throw new Error(`assumptions.yaml doesn't match model/schema.yaml:\n  - ` + problems.join('\n  - '));

  const values = {};
  for (const [key, e] of Object.entries(A)) {
    const parts = key.split('.');
    let o = values;
    for (const p of parts.slice(0, -1)) o = o[p] = o[p] || {};
    o[parts[parts.length - 1]] = e.value;
  }
  return { values, jobFixes: J, hash: createHash('sha256').update(text).digest('hex').slice(0, 12), file, raw: doc };
}

/** The Apps Script file every board loads first: the assumptions as a global. */
export function assumptionsScript(a) {
  return `// SP assumptions, bundled at build time from sp-tools-config/assumptions.yaml (config ${a.hash}).\n` +
    `// Do not edit here: change assumptions.yaml, log it in its CHANGELOG, and redeploy.\n` +
    `var ASSUMPTIONS = ${JSON.stringify({ ...a.values, job_fixes: a.jobFixes, config_hash: a.hash }, null, 2)};\n`;
}
