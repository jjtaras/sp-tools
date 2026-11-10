// Runs an Apps Script project's server code in a Node sandbox, the way Apps Script does:
// every script file shares one global scope, loaded in order. No Google services are provided,
// so only the pure parts (build, buildBoard, parseBillingRows, ...) can be called.
import vm from 'node:vm';
import { readFileSync, readdirSync } from 'node:fs';
import path from 'node:path';

/** @param {{name: string, content: string}[]} files script files in load order */
export function loadGasFiles(files) {
  if (!files.length) throw new Error('No script files to load');
  const ctx = vm.createContext({ console });
  for (const f of files) vm.runInContext(f.content, ctx, { filename: f.name });
  return ctx;
}

/** A folder of .js/.gs files, loaded alphabetically (e.g. a clasp clone or the baseline copy). */
export function loadGasProject(dir) {
  const names = readdirSync(dir).filter((f) => /\.(js|gs)$/.test(f)).sort();
  return loadGasFiles(names.map((n) => ({ name: path.join(dir, n), content: readFileSync(path.join(dir, n), 'utf8') })));
}

// Values made inside the sandbox have the sandbox's prototypes; a JSON round trip gives plain
// objects that compare cleanly. It also matches what the boards do: they save JSON.stringify(result).
export const plain = (x) => JSON.parse(JSON.stringify(x));
