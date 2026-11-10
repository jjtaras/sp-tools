// Runs an Apps Script project's server code in a Node sandbox, the way Apps Script does:
// every .js/.gs file shares one global scope. No Google services are provided, so only the
// pure parts (build, buildBoard, parseBillingRows, ...) can be called.
import vm from 'node:vm';
import { readFileSync, readdirSync } from 'node:fs';
import path from 'node:path';

export function loadGasProject(dir) {
  const files = readdirSync(dir).filter((f) => /\.(js|gs)$/.test(f)).sort();
  if (!files.length) throw new Error(`No .js/.gs files in ${dir}`);
  const ctx = vm.createContext({ console });
  for (const f of files) vm.runInContext(readFileSync(path.join(dir, f), 'utf8'), ctx, { filename: path.join(dir, f) });
  return ctx;
}

// Values made inside the sandbox have the sandbox's prototypes; a JSON round trip gives plain
// objects that compare cleanly. It also matches what the boards do: they save JSON.stringify(result).
export const plain = (x) => JSON.parse(JSON.stringify(x));
