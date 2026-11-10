/**
 * SP Production Tracker — Google Apps Script web app.
 *
 * What it does
 *   refresh()  pulls every open Innergy project (WOs, step dates, job costing), all POs and the
 *              labor kanban, applies the tracker rules (build()), and saves the result to a JSON
 *              file in Drive. Runs on a timer (see setupTriggers) and from the page's Refresh button.
 *   doGet()    serves Index.html with the latest saved data. Deploy as a web app:
 *              Execute as: Me · Who has access: Anyone within your Workspace domain.
 *
 * Setup (once)
 *   1. Project Settings → Script properties → add INNERGY_API_KEY (same key the margin board uses).
 *   2. Run refresh() once from the editor and approve the permissions.
 *   3. Run setupTriggers() once.
 *   4. Deploy → New deployment → Web app (settings above).
 * Rules and per-job fixes live in Settings.gs. Edit there, then Refresh.
 * Read-only: this script only ever sends GET requests to Innergy.
 */

var BASE = 'https://app.innergy.com';
var TZ = 'America/New_York';
var DATA_FILE = 'SP Production Tracker data.json';

/* ------------------------------------------------------------------ web app */
function doGet() {
  var html = HtmlService.createHtmlOutputFromFile('Index').getContent();
  var data = loadData_();
  if (!data) data = JSON.stringify({ empty: true });
  var safe = data.replace(/<\//g, '<\\/');
  // Google strips JS comments from served HTML, so the data goes in a JSON script tag, not a comment marker.
  html = html.replace('__TRACKER_DATA__', function () { return safe; });  // function form: no $-pattern substitution
  return HtmlService.createHtmlOutput(html)
    .setTitle('Shop Production Tracker')
    .addMetaTag('viewport', 'width=device-width, initial-scale=1');
}

/** Run from the editor to check what the web page will get. */
function checkData() {
  var id = PropertiesService.getScriptProperties().getProperty('DATA_FILE_ID');
  var d = loadData_();
  console.log('DATA_FILE_ID: ' + id);
  if (!d) { console.log('No saved data. Run refresh() and check it finishes without an error.'); return; }
  var o = JSON.parse(d);
  console.log('Saved ' + d.length + ' chars; ' + (o.projects || []).length + ' jobs; as of ' + o.asof);
}

/** Web app URL, used by the page to reload itself after a refresh. */
function getUrl() { return ScriptApp.getService().getUrl(); }

/** Called from the page's Refresh button. */
function refreshNow() {
  var lock = LockService.getScriptLock();
  if (!lock.tryLock(5000)) return 'busy';
  try { refresh(); return 'ok'; } finally { lock.releaseLock(); }
}

/* ------------------------------------------------------------------ refresh */
function refresh() {
  var raw = pull_();
  var now = new Date();
  var data = build(raw, {
    today: Utilities.formatDate(now, TZ, 'yyyy-MM-dd'),
    asof: Utilities.formatDate(now, TZ, "EEE MMM d, yyyy '·' h:mm a"),
    settings: SETTINGS,
    labor: ASSUMPTIONS.labor
  });
  saveData_(JSON.stringify(data));
  console.log(data.projects.length + ' projects; skipped ' + data.skipped.length);
}

/** Hourly on weekdays 6am-7pm, plus once at 5am every day. */
function scheduledRefresh() {
  var now = new Date();
  var h = Number(Utilities.formatDate(now, TZ, 'H')), dow = Number(Utilities.formatDate(now, TZ, 'u'));
  if (h === 5 || (dow <= 5 && h >= 6 && h <= 19)) refresh();
}

function setupTriggers() {
  ScriptApp.getProjectTriggers().forEach(function (t) {
    if (t.getHandlerFunction() === 'scheduledRefresh') ScriptApp.deleteTrigger(t);
  });
  ScriptApp.newTrigger('scheduledRefresh').timeBased().everyHours(1).create();
}

/* ------------------------------------------------------------------ Innergy (GET only) */
function key_() {
  var k = PropertiesService.getScriptProperties().getProperty('INNERGY_API_KEY');
  if (!k) throw new Error('Set INNERGY_API_KEY in Project Settings → Script properties.');
  return k;
}
function req_(path, params) {
  var qs = params ? '?' + Object.keys(params).map(function (k) { return encodeURIComponent(k) + '=' + encodeURIComponent(params[k]); }).join('&') : '';
  return { url: BASE + path + qs, method: 'get', muteHttpExceptions: true,
           headers: { 'Api-Key': key_(), 'Accept': 'application/json' } };
}
function parse_(resp, label) {
  var code = resp.getResponseCode();
  if (code === 204) return null;            // no content (e.g. a project with no dated WOs)
  if (code < 200 || code >= 300) throw new Error('Innergy HTTP ' + code + ' for ' + label + ': ' + resp.getContentText().slice(0, 300));
  var blob = resp.getBlob(), bytes = blob.getBytes(), text;
  if (bytes.length > 1 && (bytes[0] & 0xff) === 0x1f && (bytes[1] & 0xff) === 0x8b) {
    text = Utilities.ungzip(blob.setContentType('application/x-gzip')).getDataAsString('UTF-8');
  } else text = resp.getContentText('UTF-8');
  var o = text ? JSON.parse(text) : null;
  return (o && typeof o === 'object' && !Array.isArray(o) && 'Items' in o) ? o.Items : o;
}
var BATCH = 4;          // Innergy allows only a few concurrent requests per tenant
var MAX_TRIES = 6;

function get_(path, params) { return getAll_([[path, params]])[0]; }

/** list of [path, params] -> parsed results, a few at a time, retrying 429/5xx with backoff. */
function getAll_(list) {
  var out = new Array(list.length), pending = list.map(function (_, i) { return i; });
  for (var attempt = 1; pending.length && attempt <= MAX_TRIES; attempt++) {
    var retry = [];
    for (var i = 0; i < pending.length; i += BATCH) {
      var idx = pending.slice(i, i + BATCH);
      var resps = UrlFetchApp.fetchAll(idx.map(function (j) { return req_(list[j][0], list[j][1]); }));
      resps.forEach(function (r, k) {
        var code = r.getResponseCode(), j = idx[k];
        if (code === 429 || code >= 500) retry.push(j);
        else out[j] = parse_(r, list[j][0]);
      });
      if (retry.length) Utilities.sleep(1500);
    }
    pending = retry;
    if (pending.length) Utilities.sleep(2000 * attempt);
  }
  if (pending.length) throw new Error('Innergy kept refusing ' + pending.length + ' requests (rate limit). Try Refresh again in a few minutes.');
  return out;
}

function pull_() {
  var projects = get_('/api/projects').filter(function (p) { return (p.Status || '') !== 'Closed'; });
  var calls = [];
  projects.forEach(function (p) {
    calls.push(['/api/projects/' + p.Number]);
    calls.push(['/api/projects/' + p.Id + '/workOrders']);
    calls.push(['/api/dateManagement/' + p.Id]);
    calls.push(['/api/workOrders/jobCosting', { projectNumber: p.Number }]);
  });
  var res = getAll_(calls), proj = [];
  projects.forEach(function (p, i) {
    if (!res[i * 4]) return;  // project detail came back empty
    proj.push({ detail: res[i * 4], workOrders: res[i * 4 + 1] || [], dates: res[i * 4 + 2], costing: res[i * 4 + 3] || [] });
  });
  // Labor comes from timesheets, counted with the same rules as the Margin Board.
  var months = SPCore.monthsThrough(ASSUMPTIONS.innergy.timesheets_start, new Date()), timesheets = [];
  getAll_(months.map(function (m) { return ['/api/timeTracking/' + m[0] + '/' + m[1]]; }))
    .forEach(function (x) { timesheets = timesheets.concat(x || []); });
  return { projects: proj, purchaseOrders: get_('/api/purchaseOrders') || [], kanban: get_('/api/laborKanbanGridItems') || [],
           labors: get_('/api/labors') || [], timesheets: timesheets };
}

/* ------------------------------------------------------------------ storage */
function saveData_(text) {
  var props = PropertiesService.getScriptProperties(), id = props.getProperty('DATA_FILE_ID'), f = null;
  if (id) { try { f = DriveApp.getFileById(id); } catch (e) { f = null; } }
  if (f) f.setContent(text);
  else { f = DriveApp.createFile(DATA_FILE, text, 'application/json'); props.setProperty('DATA_FILE_ID', f.getId()); }
}
function loadData_() {
  var id = PropertiesService.getScriptProperties().getProperty('DATA_FILE_ID');
  if (!id) return null;
  try { return DriveApp.getFileById(id).getBlob().getDataAsString('UTF-8'); } catch (e) { return null; }
}

/* ------------------------------------------------------------------ rules (pure; no Google services) */
var ACRONYMS = { PTAC: 1, CNC: 1, MDF: 1, AC: 1, TV: 1, HVAC: 1, POS: 1, MG: 1 };
function hrs_(s) { return SPCore.durationHours(s); }
function val_(x) { return SPCore.amount(x); }
function d10_(x) { return x ? String(x).slice(0, 10) : null; }
function suffix_(n) { var p = n.split('-'); return p[p.length - 1]; }
function cap_(w) { return w.charAt(0).toUpperCase() + w.slice(1).toLowerCase(); }
function tc_(s) { return s.replace(/_/g, ' ').split(/\s+/).filter(Boolean).map(function (w) { return ACRONYMS[w.toUpperCase()] ? w : cap_(w); }).join(' '); }
function tidy_(name) {
  var raw = name.trim(), words;
  if (raw.charAt(0) === '[') {
    var parts = raw.split(/[_\[\]]/).filter(function (p) { return p.trim(); });
    var code = parts.length && /^\d{3}[A-Z]?\b/.test(parts[0]) ? parts[0].split(/\s+/)[0] : null;
    words = parts.join(' ');
    if (code) words = words.replace(new RegExp('\\s' + code.replace(/[.*+?^${}()|[\]\\]/g, '\\$&') + '\\s*$'), '');
  } else words = raw;
  return words.split(/\s+/).filter(Boolean).map(function (w) {
    return (ACRONYMS[w.toUpperCase().replace(/^[(),]+|[(),]+$/g, '')] || /^\d/.test(w)) ? w : cap_(w);
  }).join(' ');
}
function instName_(name) {
  var n = name.replace(/^\d+\s*-\s*/, '');
  var m = /Phase\s*(\d+)\s*Install\s*\((.*)\)/i.exec(n);
  if (m) return 'Phase ' + m[1] + ' · ' + m[2].replace(/ & /g, ' + ').replace(', closets', ' + closets');
  if (/^\[?DELIVERY ?\/ ?INSTALL\]?$/i.test(n.trim())) return 'Delivery / Install (contract bucket)';
  return tidy_(n);
}
var DONE_COLS = { 'COMPLETED': 1, 'ARCHIVE': 1, 'CNC APPROVED': 1 };
var NOT_STARTED = { 'TO DO': 1, 'BACKLOG': 1, 'READY TO ASSIGN': 1, 'HARDWARE/MATERIAL CHECK': 1, 'ON HOLD/HARDWARE/MATERIAL CHECK': 1, 'ENGINEERING QUEUE': 1 };
var STAGES = ['drafting', 'cnc', 'fab', 'finishing', 'ready'];
var LANE_LABEL = { draft: 'Drafting', cnc: 'CNC', fab: 'Fab', fin: 'Finishing' };

function kanban_(items) {
  if (!items || !items.length) return null;
  var lane = {};
  items.forEach(function (k) {
    var nm = (k.LaborItemName || '').toUpperCase(), col = (k.LaborItemStepName || '').trim();
    var key = nm.indexOf('DRAFT') >= 0 ? 'draft' : nm.indexOf('CNC') >= 0 ? 'cnc' : nm.indexOf('FABRICATION') >= 0 ? 'fab' : nm.indexOf('FINISH') >= 0 ? 'fin' : null;
    if (!key) return;
    var cu = col.toUpperCase();
    lane[key] = { col: col, done: !!k.LaborIsCompletionStep || !!DONE_COLS[cu], started: !NOT_STARTED[cu],
                  hold: cu.indexOf('HOLD') >= 0 && !NOT_STARTED[cu], entered: d10_(k.DateCompleted || k.LaborStepEnteredDate) };
  });
  if (!lane.cnc && !lane.fab && !lane.fin) return null;
  var g = function (k, f) { return !!(lane[k] && lane[k][f]); };
  var fabOpen = !!lane.fab && !lane.fab.done, st;
  if (g('fin', 'done')) st = 4;
  else if (!fabOpen && (g('fab', 'done') || g('fin', 'started'))) st = 3;   // finishing only once fab is finished
  else if (g('fab', 'started') || g('cnc', 'done')) st = 2;
  else if (g('cnc', 'started') || g('draft', 'done')) st = 1;
  else st = 0;
  var cur = { 4: 'fin', 3: 'fin', 2: 'fab', 1: 'cnc', 0: 'draft' }[st];
  if (!lane[cur]) cur = ['fin', 'fab', 'cnc', 'draft'].filter(function (k) { return lane[k]; })[0] || cur;
  var lanes = {}; Object.keys(lane).forEach(function (k) { lanes[k] = lane[k].col; });
  return { stage: STAGES[st], ord: st, where: lane[cur] ? LANE_LABEL[cur] + ': ' + lane[cur].col : STAGES[st],
           hold: Object.keys(lane).filter(function (k) { return lane[k].hold; }).map(function (k) { return LANE_LABEL[k]; }),
           lanes: lanes, readyDate: st === 4 && lane.fin ? lane.fin.entered : null };
}

var POST_FAB_RX = /FINISH|STAGING|REASSEMBLY/;

/** Actual hours booked to each WO, from timesheets, with the shared labor rules. Overhead is left out. */
function woHours_(timesheets, rules) {
  var by = {};
  (timesheets || []).forEach(function (t) {
    if (!t.WorkOrderNumber) return;
    var kind = SPCore.classifyLabor(t.LaborItemName, t.EmployeeDepartment, rules);
    if (kind === 'overhead') return;
    var h = hrs_(t.ActivityDuration), x = by[t.WorkOrderNumber] = by[t.WorkOrderNumber] || { draft: 0, other: 0, post: 0 };
    if (kind === 'drafting') x.draft += h; else x.other += h;
    if (POST_FAB_RX.test(String(t.LaborItemName || '').toUpperCase())) x.post += h;
  });
  return by;
}

/** Actual hours from timesheets (woHours_); planned hours from Innergy job costing. */
function labor_(woCost, booked) {
  booked = booked || { draft: 0, other: 0, post: 0 };
  var out = { draftAct: booked.draft, prodAct: booked.other, plan: 0, postPlan: 0, postAct: booked.post };
  ((woCost && woCost.LaborItems) || []).forEach(function (li) {
    if (li.JobCosting !== 'Cost To Project') return;
    var p = hrs_(li.PlannedHours);
    out.plan += p;
    if (POST_FAB_RX.test((li.Name || '').toUpperCase())) out.postPlan += p;
  });
  return out;
}

function addDays_(iso, n) { var d = new Date(iso + 'T12:00:00Z'); d.setUTCDate(d.getUTCDate() + n); return d.toISOString().slice(0, 10); }

/** raw = {projects:[{detail,workOrders,dates,costing}], purchaseOrders, kanban, labors, timesheets}; opts = {today, asof, settings, labor} */
function build(raw, opts) {
  var S = opts.settings, TODAY = opts.today;
  var BOOKED = woHours_(raw.timesheets, SPCore.laborRules(raw.labors, opts.labor));
  // POs by WO; project-only lines are "unassigned"
  var poByWo = {}, poUn = {};
  (raw.purchaseOrders || []).forEach(function (po) {
    if (po.Status === 'Canceled') return;
    (po.LineItems || []).forEach(function (li) {
      var amt = val_(li.ExpectedTotal), m = /(P-\d{2}-\d{4}-\d{3}[pi])/.exec(String(li.WorkOrder || ''));
      if (m && String(li.WorkOrder).indexOf(m[1]) === 0) poByWo[m[1]] = (poByWo[m[1]] || 0) + amt;
      else {
        var pm = /^(P-\d{2}-\d{4})/.exec(String(li.Project || ''));
        if (pm) { poUn[pm[1]] = poUn[pm[1]] || {}; poUn[pm[1]][po.Number] = (poUn[pm[1]][po.Number] || 0) + amt; }
      }
    });
  });
  var KB = {};
  (raw.kanban || []).forEach(function (k) { (KB[k.WorkOrderNumber] = KB[k.WorkOrderNumber] || []).push(k); });
  var nonshopRx = new RegExp(S.nonshop_pattern || 'INSTALL|SHIPPING|DELIVERY|FREIGHT|CRATING');
  var PROJECTS = [], SKIPPED = [];
  raw.projects.slice().sort(function (a, b) { return a.detail.Number < b.detail.Number ? -1 : 1; }).forEach(function (d) {
    var det = d.detail, m = /^(\d+)_([^_]+)(?:_(.*))?$/.exec(det.Name || '');
    var extra = (S.extra_jobs || {})[det.Number];
    if (!m && extra) m = /^()([^_]+)(?:_(.*))?$/.exec((det.Name || '').trim());  // no job number in the Innergy name yet: read as CLIENT_SITE
    if (!m) { SKIPPED.push(det.Name); return; }
    var job = m[1] || extra;
    if ((S.exclude_jobs || {})[job]) { SKIPPED.push(det.Name + ' (' + S.exclude_jobs[job] + ')'); return; }
    var dates = {}; ((d.dates && d.dates.WorkOrders) || []).forEach(function (w) { dates[suffix_(w.Number)] = w; });
    var cost = {}; (d.costing || []).forEach(function (b) { (b.WorkOrders || []).forEach(function (w) { cost[suffix_(w.Number)] = w; }); });
    var overrides = (S.value_overrides || {})[job] || {}, instShare = (S.install_included_jobs || {})[job] || 0;
    var ph = (S.critical_placeholders || {})[job];
    var INST = [], PROD = [];
    (d.workOrders || []).forEach(function (w) {
      if (w.Status === 'Closed') return;
      var n = suffix_(w.Number), dm = dates[n], stepsRaw = dm ? dm.Steps : [], step = w.Step || '', sd = w.WorkflowStepEnteredDays || 0;
      if (w.Type === 'Installation') {
        var text = w.Instructions || '';
        var nmCodes = (w.Name.replace(/^\d+\s*-\s*/, '').match(/\b\d{3}[A-Z]?\b/g)) || [];
        var codes = []; nmCodes.concat(text.match(/\b\d{3}[A-Z]?\b/g) || []).forEach(function (c) { if (codes.indexOf(c) < 0) codes.push(c); });
        var hold = [];
        codes.forEach(function (c, i) {
          var rest = codes.slice(i + 1);
          var rx = rest.length ? new RegExp('\\b' + c + '\\b([\\s\\S]*?)(?=\\b(?:' + rest.join('|') + ')\\b|$)') : new RegExp('\\b' + c + '\\b([\\s\\S]*)$');
          var mm = rx.exec(text); if (mm && /HOLD/i.test(mm[1])) hold.push(c);
        });
        var paren = /\((.*)\)/.exec(w.Name), kw = null;
        if (!nmCodes.length && paren) {
          var caps = (paren[1].match(/[A-Za-z]+/g) || []).filter(function (t) { return t === t.toUpperCase() && t.length >= 3; });
          kw = caps[0] || null;
        }
        INST.push({ n: n, name: instName_(w.Name), codes: codes, kw: kw, hold: hold, bucket: !codes.length && !kw,
          ps: d10_(w.PlannedStartDate), pe: d10_(w.PlannedEndDate), si: /^\d\d/.test(step) ? +step.slice(0, 2) - 10 : 0,
          step: step.slice(5), sd: sd, ae: stepsRaw && stepsRaw.length > 2 ? d10_(stepsRaw[2].ActualDate) : null,
          price: val_(w.GrandTotalPrice), act: hrs_(w.ActualLaborHours) });
        return;
      }
      if (w.Type !== 'Production') return;
      var si = /^\d\d/.test(step) ? +step.slice(0, 2) + 1 : 1;
      var steps = stepsRaw && stepsRaw.length === 7 ? stepsRaw.map(function (s) { return [d10_(s.TargetDate) || '', d10_(s.ActualDate) || '']; }) : null;
      var L = labor_(cost[n], BOOKED[w.Number]), price = val_(w.GrandTotalPrice), ov = overrides[n];
      var value = ov != null ? ov : price, po = poByWo[w.Number] || 0;
      var shopValue = value * (1 - instShare), reserve = shopValue * S.material_reserve_pct;
      var budget = Math.max(shopValue * S.cogs_labor_pct - Math.max(reserve, po), 0);
      var spent = SPCore.laborCost(L.draftAct, L.prodAct, { drafting: S.rate_drafting, other: S.rate_production });
      var fc = { value: value, instShare: instShare, shopValue: shopValue, vsrc: ov != null ? 'override' : (price > 0.01 ? 'innergy' : 'none'),
                 po: po, budget: budget, spent: spent, draftH: L.draftAct, prodH: L.prodAct, budgetH: budget / S.rate_production,
                 remH: Math.max(budget - spent, 0) / S.rate_production, over: Math.max(spent - budget, 0), capped: null };
      var kb = kanban_(KB[w.Number]);
      if (kb && kb.ord >= 4 && fc.remH > 0) { fc.capped = { formula: fc.remH, src: 'finishing complete on the kanban' }; fc.remH = 0; }
      var pastFab = kb ? kb.ord >= 3 : si >= 5;
      if (pastFab && fc.remH > 0) {
        var left = Math.max(L.postPlan - L.postAct, 0), share = S.post_fab_fallback_share || 0.15;
        var capH = L.postPlan > 0 ? left : fc.budgetH * share;
        if (capH < fc.remH) { fc.capped = { formula: fc.remH, src: L.postPlan > 0 ? 'finishing + staging hrs left' : Math.round(share * 100) + '% of budget' }; fc.remH = capH; }
      }
      var osd = ((S.outsourced || {})[job] || {})[n];
      if (osd) { fc.capped = { formula: fc.remH, src: 'outsourced' }; fc.remH = (kb && kb.ord >= 3) ? 0 : (osd.shop_hrs || 0); }  // made outside; SP only does the listed scope
      var cd = d10_(w.PlannedCriticalDate) || d10_(w.PlannedEndDate), cdPh = null;
      if (ph && cd === ph.from) { cdPh = cd; cd = ph.to; }
      PROD.push({ n: n, name: tidy_(w.Name), si: si, step: step.slice(5) || '?', sd: sd, ps: d10_(w.PlannedStartDate), 'as': d10_(w.ActualStartDate),
        cd: cd, sa: steps ? (steps[5][1] || null) : null, sx: addDays_(TODAY, -sd), shipped: d10_(w.ActualShipmentDate),
        rem: hrs_(w.RemainingHours), plan: L.plan || null, act: hrs_(w.ActualLaborHours), price: price, cost: val_(w.ActualCost),
        steps: steps, fc: fc, nonshop: nonshopRx.test((w.Name || '').toUpperCase()), kb: kb, cdPlaceholder: cdPh, outsourced: osd ? (osd.scope || 'Outsourced') : null });
    });
    if (!PROD.length) { SKIPPED.push(det.Name); return; }
    var un = poUn[det.Number] || {};
    PROJECTS.push({ project: { num: job, client: tc_(m[2]), site: tc_(m[3] || ''), innergy: det.Number,
        status: (S.hold_jobs || []).indexOf(job) >= 0 ? 'On Hold' : det.Status,
        pm: (det.ProjectManager && det.ProjectManager.FullName) || '—', contract: val_(det.TotalContract),
        step: tc_((det.WorkflowStepName || '').toLowerCase()), firstDelivery: d10_(det.FirstDelivery), subComp: d10_(det.SubstantialCompletion) },
      inst: INST, prod: PROD, installIncluded: instShare,
      unassignedPO: Object.keys(un).filter(function (k) { return un[k] > 0; }).map(function (k) { return { po: k, total: un[k] }; }) });
  });
  var settings = {}; Object.keys(S).forEach(function (k) { if (k !== 'notes' && k !== 'value_overrides') settings[k] = S[k]; });
  return { today: TODAY, asof: opts.asof, settings: settings, projects: PROJECTS, skipped: SKIPPED };
}

if (typeof module !== 'undefined') module.exports = { build: build };