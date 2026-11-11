#!/usr/bin/env node
// Renders each board's page in headless Chrome with a fixture snapshot's data, and saves the page's
// visible text. Compare two runs to prove a page change shows exactly the same thing.
//
//   node scripts/page-check.mjs <snapshot> <out-dir> [--page-dir <dir>]
//
// --page-dir points at a folder with <app>/Index.html to render instead of the built page (e.g. the
// baseline). The clock is frozen at the snapshot's recorded time, so runs are repeatable.
import { execFileSync } from 'node:child_process';
import { mkdirSync, writeFileSync, readFileSync, mkdtempSync, existsSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { parseArgs } from 'node:util';
import { configDir } from '../lib/env.mjs';
import { assembleApp, scriptFiles } from '../lib/assemble.mjs';
import { loadSnapshot } from '../tests/lib/fixture.mjs';
import { loadGasFiles, plain } from '../tests/lib/gas.mjs';
import { APPS } from '../tests/lib/apps.mjs';

const { values: o, positionals } = parseArgs({ allowPositionals: true, options: { 'page-dir': { type: 'string' } } });
const [snap, outDir] = positionals;
if (!snap || !outDir) throw new Error('Usage: node scripts/page-check.mjs <snapshot> <out-dir> [--page-dir <dir>]');
const CHROME = process.env.CHROME || '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome';
if (!existsSync(CHROME)) throw new Error(`Chrome not found at ${CHROME}; set CHROME=<path>`);
const fx = loadSnapshot(path.join(configDir(), 'fixtures', snap));
mkdirSync(outDir, { recursive: true });

// Freeze the clock and stand in for google.script.run (the Margin Board fetches its data with it).
const shim = (served) => `<script>
(function () {
  var T = ${Date.parse(fx.meta.recorded_at)}, RealDate = Date;
  function D(...a) { return a.length ? new RealDate(...a) : new RealDate(T); }
  D.prototype = RealDate.prototype; D.now = function () { return T; }; D.parse = RealDate.parse; D.UTC = RealDate.UTC;
  window.Date = D;
  var served = ${JSON.stringify(served == null ? null : JSON.stringify(served))};
  function runner(ok) { return new Proxy({}, { get: function (_, k) {
    if (k === 'withSuccessHandler') return function (f) { return runner(f); };
    if (k === 'withFailureHandler') return function () { return runner(ok); };
    return function () { setTimeout(function () { ok && ok(k === 'getUrl' ? 'about:blank' : served); }, 0); };
  } }); }
  window.google = { script: { run: runner(null) } };
  // Exercise the page so tabs, charts and detail panels draw: open every tab, then a job, then a work order.
  var steps = [
    function () { document.querySelectorAll('.tab').forEach(function (t, i) { setTimeout(function () { t.click(); }, i * 200); }); },
    function () { var t = document.getElementById('tab-active'); if (t) t.click(); },
    function () { var r = document.querySelector('#board tr[data-key]'); if (r) r.click(); },
    function () { var r = document.querySelector('#ptable tr.click'); if (r) r.click(); },
    function () { var r = document.querySelector('#attn tr.click'); if (r) r.click(); },
  ];
  window.addEventListener('load', function () { steps.forEach(function (s, i) { setTimeout(s, 1500 + i * 1000); }); });
})();
</script>`;

for (const [app, def] of Object.entries(APPS)) {
  const assembled = assembleApp(def.baseline);
  const ctx = loadGasFiles(scriptFiles(assembled));
  const data = def.run(ctx, fx);
  const page = o['page-dir'] ? readFileSync(path.join(o['page-dir'], def.baseline, 'Index.html'), 'utf8') : assembled.files.find((f) => f.name === 'Index.html').content;
  // What each board's server hands its page. Uses the board's own page-data function when it has one.
  const pageData = typeof ctx.pageData_ === 'function' ? plain(ctx.pageData_(data)) : data;
  let html;
  if (app === 'margin-board') {
    pageData.meta = { ...pageData.meta, refreshed_at: fx.meta.recorded_at, stale_after_hours: 3, version: ctx.DATA_VERSION, trigger_installed: true };
    html = page.replace(/<head>/i, '<head>' + shim(pageData));
  } else {
    const safe = JSON.stringify(pageData).replace(/<\//g, '<\\/');
    html = page.replace('__TRACKER_DATA__', () => safe).replace(/<head>/i, '<head>' + shim(null));
  }
  const file = path.join(outDir, app + '.html');
  writeFileSync(file, html);
  const profile = mkdtempSync(path.join(os.tmpdir(), 'page-check-'));
  const dom = execFileSync(CHROME, ['--headless=new', '--disable-gpu', `--user-data-dir=${profile}`, '--window-size=1280,2000',
    '--virtual-time-budget=15000', '--run-all-compositor-stages-before-draw', '--dump-dom', 'file://' + file], { encoding: 'utf8', maxBuffer: 64 << 20 });
  writeFileSync(path.join(outDir, app + '.dom.html'), dom);
  // Visible text, one block per line, scripts and styles removed.
  const text = dom.replace(/<script[\s\S]*?<\/script>/gi, '').replace(/<style[\s\S]*?<\/style>/gi, '')
    .replace(/<(br|\/p|\/div|\/li|\/tr|\/h\d|\/td|\/th)[^>]*>/gi, '\n').replace(/<[^>]+>/g, ' ')
    .replace(/&nbsp;/g, ' ').replace(/&amp;/g, '&').replace(/&lt;/g, '<').replace(/&gt;/g, '>').replace(/&#39;/g, "'").replace(/&quot;/g, '"')
    .split('\n').map((l) => l.replace(/\s+/g, ' ').trim()).filter(Boolean).join('\n');
  writeFileSync(path.join(outDir, app + '.txt'), text + '\n');
  console.log(`${app}: ${text.split('\n').length} lines of text, ${(dom.match(/<svg/g) || []).length} charts → ${path.join(outDir, app + '.txt')}`);
}
