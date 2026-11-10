// Per-machine settings: .env at the repo root (gitignored). See .env.example.
import { existsSync, statSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import path from 'node:path';

export const REPO_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');

let loaded = false;
export function loadEnv() {
  if (loaded) return;
  const file = path.join(REPO_ROOT, '.env');
  if (existsSync(file)) process.loadEnvFile(file);
  loaded = true;
}

/** The SP-owned config folder. Fails loudly: there is no fallback. */
export function configDir() {
  loadEnv();
  const dir = process.env.SP_CONFIG_DIR;
  if (!dir) throw new Error('SP_CONFIG_DIR is not set. Add it to .env (see .env.example).');
  if (!existsSync(dir) || !statSync(dir).isDirectory()) throw new Error(`SP_CONFIG_DIR does not exist or is not a folder: ${dir}`);
  return dir;
}

export function requireEnv(name) {
  loadEnv();
  const v = process.env[name];
  if (!v) throw new Error(`${name} is not set. Add it to .env (see .env.example).`);
  return v;
}
