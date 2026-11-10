/**
 * SP Job Margin Board — Google Apps Script web app.
 *
 * Pulls labor hours and POs from Innergy and job values from the SP Billing
 * Dashboard, works out spend and margin risk for every open job, and serves
 * the board as a web page limited to the company domain.
 *
 * Setup (see SETUP.md):
 *   Project Settings > Script properties: INNERGY_API_KEY (required),
 *   INNERGY_BASE_URL (optional, defaults to https://app.innergy.com).
 *   Run setup() once from the editor. It does the first pull and installs the
 *   hourly refresh.
 */


var DATA_VERSION = 4;  // bump when the data shape changes; the page warns when it sees older data

// ---------------------------------------------------------------- web app
function doGet() {
  return HtmlService.createTemplateFromFile('Index').evaluate()
    .setTitle('SP Job Margin Board')
    .addMetaTag('viewport', 'width=device-width, initial-scale=1');
}

/** Called by the page. Returns the latest saved data as a JSON string. */
function getData() {
  var props = PropertiesService.getScriptProperties();
  var id = props.getProperty('DATA_FILE_ID');
  var lastError = props.getProperty('LAST_REFRESH_ERROR');
  if (!id) return JSON.stringify({error: 'No data yet. Run setup() in the script editor.' + (lastError ? ' Last attempt failed: ' + JSON.parse(lastError).message : '')});
  var data = JSON.parse(DriveApp.getFileById(id).getBlob().getDataAsString());
  // Tell the page if refreshes have been failing since this data was saved.
  if (lastError) {
    var e = JSON.parse(lastError);
    if (!data.meta.refreshed_at || e.at > data.meta.refreshed_at) data.meta.last_refresh_error = e;
  }
  data.meta.trigger_installed = ScriptApp.getProjectTriggers().some(function (t) { return t.getHandlerFunction() === 'refreshData'; });
  return JSON.stringify(data);
}

/** Called by the page's Refresh button. */
function refreshNow() {
  refreshData();
  return getData();
}

/** Run once from the editor: first pull plus the hourly refresh. */
function setup() {
  ScriptApp.getProjectTriggers().forEach(function (t) {
    if (t.getHandlerFunction() === 'refreshData') ScriptApp.deleteTrigger(t);
  });
  ScriptApp.newTrigger('refreshData').timeBased().everyHours(1).create();
  refreshData();
  Logger.log('Setup done. Data saved and hourly refresh installed.');
}

// ---------------------------------------------------------------- refresh
function refreshData() {
  var lock = LockService.getScriptLock();
  if (!lock.tryLock(1000)) return;  // a refresh is already running
  var props = PropertiesService.getScriptProperties();
  try {
    var started = new Date();
    var raw = fetchInnergy_();
    // A billing-sheet problem shouldn't stop the Innergy refresh; the page shows the error instead.
    var billingError = null;
    try { raw.billing = readBilling_(); } catch (e) { raw.billing = []; billingError = String(e && e.message || e); }
    var result = buildBoard(raw, Utilities.formatDate(started, 'America/New_York', 'yyyy-MM-dd'));
    result.meta.refreshed_at = started.toISOString();
    result.meta.refresh_seconds = Math.round((new Date() - started) / 1000);
    result.meta.stale_after_hours = CONFIG.STALE_AFTER_HOURS;
    result.meta.version = DATA_VERSION;
    result.meta.billing_error = billingError;
    saveData_(JSON.stringify(result));
    props.deleteProperty('LAST_REFRESH_ERROR');
  } catch (e) {
    // Record the failure so the page can show it, then rethrow so it also lands in the Executions log.
    props.setProperty('LAST_REFRESH_ERROR', JSON.stringify({at: new Date().toISOString(), message: String(e && e.message || e)}));
    throw e;
  } finally {
    lock.releaseLock();
  }
}

function saveData_(text) {
  var props = PropertiesService.getScriptProperties();
  var id = props.getProperty('DATA_FILE_ID');
  if (id) {
    DriveApp.getFileById(id).setContent(text);
  } else {
    var file = DriveApp.createFile(CONFIG.DATA_FILE_NAME, text, MimeType.PLAIN_TEXT);
    props.setProperty('DATA_FILE_ID', file.getId());
  }
}

// ---------------------------------------------------------------- Innergy
function innergyRequest_(path) {
  var props = PropertiesService.getScriptProperties();
  var key = props.getProperty('INNERGY_API_KEY');
  if (!key) throw new Error('Set INNERGY_API_KEY in Project Settings > Script properties.');
  var base = (props.getProperty('INNERGY_BASE_URL') || 'https://app.innergy.com').replace(/\/$/, '');
  return {url: base + path, headers: {'api-key': key}, muteHttpExceptions: true, followRedirects: false};
}

function parseResponse_(resp, path) {
  var code = resp.getResponseCode();
  if (code !== 200) throw new Error('Innergy ' + path + ' returned ' + code + '. Check the API key and that this endpoint is enabled.');
  return JSON.parse(resp.getContentText());
}

function fetchJson_(path) {
  return parseResponse_(UrlFetchApp.fetch(innergyRequest_(path).url, innergyRequest_(path)), path);
}

/** Pages through a v2 grid endpoint 500 rows at a time. */
function fetchGrid_(path) {
  var rows = [], skip = 0;
  while (true) {
    var page = fetchJson_(path + '?take=500&skip=' + skip + '&requireTotalCount=true');
    rows = rows.concat(page.data || []);
    if (!page.data || page.data.length < 500) break;
    skip += 500;
  }
  return rows;
}

function fetchInnergy_() {
  var projects = fetchJson_('/api/projects');
  var labors = fetchJson_('/api/labors');
  var workOrders = fetchGrid_('/api/v2-unstable/project-management/work-orders');
  var poLines = fetchGrid_('/api/v2-unstable/purchasing/purchase-orders/line-items');
  // Timesheets come a month at a time; fetch all months in parallel.
  var months = monthList_(CONFIG.TIMESHEETS_START, new Date());
  var reqs = months.map(function (m) { return innergyRequest_('/api/timeTracking/' + m[0] + '/' + m[1]); });
  var resps = UrlFetchApp.fetchAll(reqs);
  var timesheets = [];
  resps.forEach(function (r, i) { timesheets = timesheets.concat(parseResponse_(r, '/api/timeTracking/' + months[i].join('/'))); });
  return {
    projects: projects.Items || projects,
    labors: labors.Items || labors,
    workOrders: workOrders,
    poLines: poLines,
    timesheets: timesheets,
  };
}

/**
 * Reads the job table on the billing dashboard's MSTR tab. Columns are found by
 * their headings (PROJECT, TOTAL VALUE, PTD, OPEN/OVERDUE, READY TO INVOICE,
 * TO BE INVOICED), so moving columns around won't break it.
 */
function readBilling_() {
  var ss = SpreadsheetApp.openById(CONFIG.BILLING_SHEET_ID);
  var sheet = ss.getSheetByName(CONFIG.BILLING_TAB);
  if (!sheet) throw new Error('Billing dashboard has no "' + CONFIG.BILLING_TAB + '" tab.');
  // Each job tab's own summary table (CONTRACT TOTAL / ADJUSTED TOTAL / PTD ...) sits near the top.
  var tabs = {};
  ss.getSheets().forEach(function (t) {
    if (/^\s*\d+/.test(t.getName())) tabs[t.getName()] = t.getRange(1, 1, 12, 8).getValues();
  });
  return parseBillingRows(sheet.getDataRange().getValues(), tabs);
}

/**
 * Paid-to-date comes from each job tab's own table, not from MSTR. On the tabs,
 * "ADJUSTED PTD" (which MSTR pulls) adds paid change orders on top of a PTD that
 * already includes them, so MSTR double-counts paid COs. Total value, open and
 * ready-to-invoice are read from MSTR.
 */
function parseTabSummary_(values) {
  var norm = function (v) { return String(v == null ? '' : v).trim().toUpperCase(); };
  for (var r = 0; r < values.length - 1; r++) {
    var h = values[r].map(norm);
    if (h.indexOf('ADJUSTED TOTAL') >= 0 && h.indexOf('PTD') >= 0) {
      var v = values[r + 1], o = {};
      h.forEach(function (name, i) { if (name) o[name] = v[i]; });
      return o;
    }
  }
  return null;
}

function parseBillingRows(values, tabs) {
  tabs = tabs || {};
  var lead = function (x) { var m = String(x).match(/^\s*(\d+)/); return m ? m[1] : null; };
  var tabByNumber = {};
  Object.keys(tabs).forEach(function (name) { var n = lead(name); if (n) tabByNumber[n] = {name: name, summary: parseTabSummary_(tabs[name])}; });
  var norm = function (v) { return String(v == null ? '' : v).trim().toUpperCase(); };
  var hdr = -1, col = {};
  for (var r = 0; r < values.length && hdr < 0; r++) {
    var row = values[r].map(norm);
    if (row.indexOf('PROJECT') >= 0 && row.indexOf('TOTAL VALUE') >= 0) {
      hdr = r;
      row.forEach(function (h, i) { col[h] = i; });
    }
  }
  if (hdr < 0) throw new Error('Could not find the PROJECT / TOTAL VALUE table on the billing dashboard.');
  var num = function (v) { var n = typeof v === 'number' ? v : parseFloat(String(v).replace(/[$,]/g, '')); return isNaN(n) ? null : n; };
  var get = function (row, name) { return col[name] === undefined ? null : num(row[col[name]]); };
  var out = [];
  for (var i = hdr + 1; i < values.length; i++) {
    var project = String(values[i][col.PROJECT] || '').trim();
    if (!project) break;  // the job table ends at the first blank row
    var tab = tabByNumber[lead(project)], mstrPaid = get(values[i], 'PTD');
    var tabPaid = tab && tab.summary ? num(tab.summary.PTD) : null;
    out.push({
      project: project, pm: col.PM === undefined ? '' : String(values[i][col.PM] || '').trim(),
      total: get(values[i], 'TOTAL VALUE'),
      paid: tabPaid !== null ? tabPaid : mstrPaid, paid_source: tabPaid !== null ? 'job tab' : 'MSTR',
      mstr_paid: mstrPaid, tab: tab ? tab.name : '',
      open_overdue: get(values[i], 'OPEN/OVERDUE'),
      ready_to_invoice: get(values[i], 'READY TO INVOICE'), to_be_invoiced: get(values[i], 'TO BE INVOICED'),
    });
  }
  return out;
}

/**
 * Matches billing rows to Innergy projects. Billing names start with the job
 * number ("1234_CLIENT_SITE"); Innergy names do too ("1234_CLIENT_SITE").
 * Older jobs carry a leading 1 in billing (1123) that Innergy doesn't (123).
 * An exact number match wins; the 1000-offset is only tried when there's none.
 * Each match also gets a word-overlap check so a wrong pairing stands out.
 */
function matchBilling(billing, projects) {
  var lead = function (s) { var m = String(s).match(/^\s*(\d+)/); return m ? +m[1] : null; };
  var words = function (s) { return String(s).toUpperCase().replace(/^\s*\d+/, '').split(/[^A-Z0-9]+/).filter(function (w) { return w.length > 1; }); };
  var byNumber = {};
  projects.forEach(function (p) { var n = lead(p.Name); if (n !== null) (byNumber[n] = byNumber[n] || []).push(p); });
  var pick = function (list) {
    if (!list || !list.length) return null;
    var open = list.filter(function (p) { return p.Status === 'Open' || p.Status === 'On Hold'; });
    return (open.length ? open : list)[0];
  };
  return billing.map(function (b) {
    var pinned = CONFIG.BILLING_MATCH[b.project], p = null, how = '';
    if (pinned) { p = projects.filter(function (x) { return x.Number === pinned; })[0] || null; how = 'pinned in CONFIG'; }
    else {
      var n = lead(b.project);
      if (n !== null) {
        p = pick(byNumber[n]); how = p ? 'job number' : '';
        if (!p && n >= 1000) { p = pick(byNumber[n - 1000]); how = p ? 'job number without the leading 1' : ''; }
      }
    }
    var bw = words(b.project), shared = p ? words(p.Name).filter(function (w) { return bw.indexOf(w) >= 0; }) : [];
    return {billing_project: b.project, job: p ? p.Number : null, innergy_name: p ? p.Name : null, matched_by: how,
      shared_words: shared.join(' '), confident: !!p && (how === 'job number' || how === 'pinned in CONFIG' || shared.length > 0), row: b};
  });
}

function monthList_(start, end) { return SPCore.monthsThrough(start, end); }

// ---------------------------------------------------------------- the math
// buildBoard is pure: Innergy data in, board data out. No Apps Script calls.
function buildBoard(raw, asOf) {
  var recentFrom = new Date(Date.parse(asOf) - CONFIG.RECENT_DAYS * 864e5).toISOString().slice(0, 10);
  var C = CONFIG;
  var val = SPCore.amount;
  var hours = function (s) { return SPCore.durationHours(s); };
  var rates = {drafting: C.RATE_DRAFTING, other: C.RATE_OTHER};
  var weekOf = function (iso) {
    var d = new Date(iso.slice(0, 10) + 'T00:00:00Z');
    d.setUTCDate(d.getUTCDate() - ((d.getUTCDay() + 6) % 7));
    return d.toISOString().slice(0, 10);
  };
  var rules = SPCore.laborRules(raw.labors, C.LABOR);

  // Per-project accumulators, keyed by project name (how timesheets and POs refer to projects).
  var acc = {};
  var get = function (name) {
    if (!acc[name]) acc[name] = {draftH: 0, shopH: 0, ohH: 0, pendH: 0, approvedH: 0, recentH: 0, dept: {}, weekly: {}, poRec: 0, poOpen: 0, poFixed: [], first: '', last: ''};
    return acc[name];
  };
  raw.timesheets.forEach(function (t) {
    if (!t.ProjectName) return;
    var a = get(t.ProjectName), h = hours(t.ActivityDuration);
    if (t.ActivityStatus === 'Approved') a.approvedH += h;
    var kind = SPCore.classifyLabor(t.LaborItemName, t.EmployeeDepartment, rules);
    if (kind === 'overhead') { a.ohH += h; return; }
    var isDraft = kind === 'drafting';
    if (isDraft) a.draftH += h; else a.shopH += h;
    if (t.ActivityStatus !== 'Approved') a.pendH += h;
    var dept = isDraft ? 'Drafting' : String(t.EmployeeDepartment || '?').split(' - ').pop().trim();
    a.dept[dept] = (a.dept[dept] || 0) + h;
    var w = weekOf(t.ActivityDate);
    a.weekly[w] = a.weekly[w] || [0, 0];
    a.weekly[w][0] += h * SPCore.laborRate(isDraft, rates);
    if (t.ActivityDate >= recentFrom) a.recentH += h;
    if (!a.first || t.ActivityDate < a.first) a.first = t.ActivityDate;
    if (!a.last || t.ActivityDate > a.last) a.last = t.ActivityDate;
  });
  raw.poLines.forEach(function (x) {
    if (x.PurchaseOrderStatus === 'Canceled') return;
    var name = x.PreferredProjectName && x.PreferredProjectName.DisplayName;
    if (!name) return;
    var a = get(name), e = val(x.ExpectedTotal), r = val(x.ReceivedTotalCost), cost;
    // Receiving error guard: received at more than 3x a real PO amount, and over $5k off.
    if (r > 0 && e >= 100 && r > 3 * e && r - e > 5000) {
      a.poFixed.push(x.PurchaseOrderSequenceIdentifier.DisplayName + ' received at $' + Math.round(r).toLocaleString('en-US') + ' vs ordered $' + Math.round(e).toLocaleString('en-US'));
      a.poRec += e; cost = e;
    } else if (r > 0) { a.poRec += r; cost = r; }
    else { a.poOpen += e; cost = e; }
    var dt = x.CreatedDate && x.CreatedDate.dateTime;
    if (dt) { var w = weekOf(dt); a.weekly[w] = a.weekly[w] || [0, 0]; a.weekly[w][1] += cost; }
  });
  var wosByProject = {};
  raw.workOrders.forEach(function (w) {
    if (w.JobCostingStatus === 'Excluded') return;
    (wosByProject[w.ProjectSequenceIdentifier] = wosByProject[w.ProjectSequenceIdentifier] || []).push(w);
  });

  var notJob = {}; C.NOT_JOBS.forEach(function (n) { notJob[n] = true; });
  var billingMatches = matchBilling(raw.billing || [], raw.projects);
  var billingByJob = {};
  billingMatches.forEach(function (m) { if (m.job) billingByJob[m.job] = m; });
  var lbExclude = {}; C.LOOKBACK_EXCLUDE.forEach(function (n) { lbExclude[n] = true; });
  var round1 = function (x) { return Math.round(x * 10) / 10; };

  var all = raw.projects.map(function (p) {
    var a = get(p.Name), W = wosByProject[p.Number] || [];
    var tc = val(p.TotalContract), innergyValue = tc || val(p.WorkOrdersValue);
    var bm = billingByJob[p.Number], b = bm ? bm.row : null;
    var billingTotal = b && b.total > 0 ? b.total : null;
    var contract = billingTotal || innergyValue;
    var source = billingTotal ? 'billing sheet' : bm ? 'Innergy (billing sheet has no total)' : tc ? 'Innergy (no billing tab)' : 'Innergy work orders (no billing tab or contract)';
    var tv = W.reduce(function (s, w) { return s + val(w.GrandTotalPrice); }, 0);
    var dp = tv ? W.reduce(function (s, w) { var f = C.DRAFT_STEP[w.WorkflowStepName]; return s + val(w.GrandTotalPrice) * (f === undefined ? 1 : f); }, 0) / tv : 0;
    var sp = tv ? W.reduce(function (s, w) { return s + val(w.GrandTotalPrice) * (C.SHOP_STEP[w.WorkflowStepName] || 0); }, 0) / tv : 0;
    var ships = W.map(function (w) { return w.ShipmentDate && w.ShipmentDate.date; }).filter(Boolean).sort();
    var weeks = Object.keys(a.weekly).sort();
    return {
      job: p.Number, name: p.Name, status: p.Status, pm: (p.ProjectManager && p.ProjectManager.FullName) || '—',
      contract: Math.round(contract * 100) / 100, contract_source: source, innergy_value: Math.round(innergyValue * 100) / 100,
      billing_project: bm ? bm.billing_project : '',
      billed_paid: b && b.paid !== null ? Math.round(b.paid) : null,
      billed_open: b && b.open_overdue !== null ? Math.round(b.open_overdue) : null,
      billed_ready: b && b.ready_to_invoice !== null ? Math.round(b.ready_to_invoice) : null,
      billed_remaining: b && b.to_be_invoiced !== null ? Math.round(b.to_be_invoiced) : null,
      fully_billed: contract > 0 && (!b || (b.to_be_invoiced !== null && b.paid !== null &&
        Math.abs(b.to_be_invoiced) <= CONFIG.FULLY_BILLED_TOLERANCE && (b.ready_to_invoice || 0) <= CONFIG.FULLY_BILLED_TOLERANCE)),
      recent_hours: Math.round(a.recentH * 10) / 10,
      // Jobs not on the billing sheet have been fully billed and dropped off it.
      billing_status: b ? 'on billing sheet' : 'fully billed (not on billing sheet)',
      drafting_hours: round1(a.draftH), shop_hours: round1(a.shopH), overhead_hours_excluded: round1(a.ohH), unapproved_hours: round1(a.pendH),
      drafting_cost: Math.round(a.draftH * SPCore.laborRate(true, rates)), shop_cost: Math.round(a.shopH * SPCore.laborRate(false, rates)),
      po_received: Math.round(a.poRec), po_open: Math.round(a.poOpen),
      po_receiving_errors: a.poFixed.length, po_receiving_error_detail: a.poFixed.join('; '),
      drafting_progress: Math.round(dp * 1000) / 1000, shop_progress: Math.round(sp * 1000) / 1000,
      innergy_planned_hours: round1(W.reduce(function (s, w) { return s + (w.PlannedLaborDuration ? w.PlannedLaborDuration.ticks : 0); }, 0) / 36e9),
      first_hours_logged: a.first, last_hours_logged: a.last, schedule_start: weeks[0] || '',
      planned_finish: ships.length ? ships[ships.length - 1] : (p.SubstantialCompletion || ''),
      work_orders: W.length,
      work_orders_delivered: W.filter(function (w) { return w.WorkflowStepName === '06 - Delivered' || w.WorkflowStepName === '14 - Install Completed'; }).length,
      created: String(p.CreatedOn || '').slice(0, 10), closed: String(p.CloseDate || '').slice(0, 10),
      drafting_note: C.JOB_NOTES[p.Number] || '', as_of: asOf,
      _acc: a, _wos: W, _innergyHours: hours(p.ActualLaborItemsTotalHours),
    };
  });

  var board = all.filter(function (j) { return (j.status === 'Open' || j.status === 'On Hold') && !notJob[j.name]; });
  var lookback = all.filter(function (j) {
    return j.status === 'Closed' && j.contract > C.LOOKBACK_MIN_CONTRACT && j.created >= C.LOOKBACK_CREATED_FROM &&
      (j.po_received + j.po_open) > 0 && !lbExclude[j.job];
  });

  var weekly = [];
  board.concat(lookback).forEach(function (j) {
    var cum = 0;
    Object.keys(j._acc.weekly).sort().forEach(function (w) {
      var v = j._acc.weekly[w]; cum += v[0] + v[1];
      weekly.push({job: j.job, week: w, labor: Math.round(v[0] * 100) / 100, po: Math.round(v[1] * 100) / 100, cumulative_cost: Math.round(cum * 100) / 100});
    });
  });

  var lbRows = lookback.map(function (j) {
    return {job: j.job, name: j.name, pm: j.pm, contract: j.innergy_value, contract_source: j.contract_source.indexOf('work orders') >= 0 ? 'work orders (no contract entered)' : 'total contract',
      labor_cost: j.drafting_cost + j.shop_cost, po_cost: j.po_received + j.po_open, drafting_hours: j.drafting_hours, shop_hours: j.shop_hours,
      overhead_hours_excluded: j.overhead_hours_excluded, closed: j.closed, po_correction: j.po_receiving_error_detail};
  });
  var lbMetrics = lookbackMetrics(lbRows, weekly);
  var lbSummary = lookbackSummary(lbRows, lbMetrics);
  var outlook = board.map(function (j) { return outlookFor(j, lbSummary); });
  var flags = flagsFor(board, outlook, lbSummary);
  var summary = boardSummary(board, outlook);

  // Data health: approved hours we pulled against Innergy's own project total (which counts approved hours only).
  var health = [];
  board.concat(lookback).forEach(function (j) {
    var ourH = j._acc.approvedH, theirH = j._innergyHours;
    if (Math.abs(ourH - theirH) > 1) health.push({job: j.job, name: j.name, ours: Math.round(ourH), innergy: Math.round(theirH)});
  });
  var billingCheck = billingMatches.map(function (m) {
    return {billing_project: m.billing_project, job: m.job, innergy_name: m.innergy_name, matched_by: m.matched_by, confident: m.confident,
      billing_total: m.row.total, innergy_value: null, paid: m.row.paid, paid_source: m.row.paid_source, mstr_paid: m.row.mstr_paid};
  });
  billingCheck.forEach(function (c) {
    var j = all.filter(function (x) { return x.job === c.job; })[0];
    if (j) c.innergy_value = j.innergy_value;
  });
  var billingPaidMismatch = billingMatches.filter(function (m) {
    return m.row.paid_source === 'job tab' && m.row.mstr_paid !== null && Math.abs(m.row.mstr_paid - m.row.paid) > 1;
  }).map(function (m) { return {billing_project: m.billing_project, tab_paid: Math.round(m.row.paid), mstr_paid: Math.round(m.row.mstr_paid)}; });
  var unassigned = raw.timesheets.filter(function (t) { return !t.ProjectName; }).reduce(function (s, t) { return s + hours(t.ActivityDuration); }, 0);

  var depts = [], wos = [];
  board.forEach(function (j) {
    Object.keys(j._acc.dept).sort(function (a, b) { return j._acc.dept[b] - j._acc.dept[a]; })
      .forEach(function (k) { depts.push({job: j.job, department: k, hours: round1(j._acc.dept[k])}); });
    j._wos.forEach(function (w) {
      wos.push({job: j.job, work_order: w.SequenceIdentifier.DisplayName, name: w.Name.DisplayName, step: w.WorkflowStepName,
        price: Math.round(val(w.GrandTotalPrice)), planned_hours: round1((w.PlannedLaborDuration ? w.PlannedLaborDuration.ticks : 0) / 36e9),
        actual_hours: round1((w.ActualLaborDuration ? w.ActualLaborDuration.ticks : 0) / 36e9)});
    });
  });

  var strip = function (j) { var o = {}; Object.keys(j).forEach(function (k) { if (k.charAt(0) !== '_') o[k] = j[k]; }); return o; };
  return {
    meta: {as_of: asOf, unassigned_hours: Math.round(unassigned), jobs_checked: board.length + lookback.length, timesheet_entries: raw.timesheets.length, po_lines: raw.poLines.length, work_orders: raw.workOrders.length, projects: raw.projects.length},
    jobs: board.map(strip), outlook: outlook, flags: flags, summary: summary,
    lookback: lbRows, lookback_metrics: lbMetrics, lookback_summary: lbSummary,
    weekly: weekly, departments: depts, work_orders: wos, health: health, billing_check: billingCheck, billing_paid_mismatch: billingPaidMismatch,
  };
}

function lookbackMetrics(lookback, weekly) {
  return lookback.map(function (j) {
    var c = +j.contract, cost = +j.labor_cost + +j.po_cost;
    var rows = weekly.filter(function (r) { return r.job === j.job; });
    var t0 = Date.parse(rows[0].week), span = (Date.parse(rows[rows.length - 1].week) - t0) / 6048e5 + 1;
    var half = 0, cross = null;
    rows.forEach(function (r) {
      var f = ((Date.parse(r.week) - t0) / 6048e5 + 1) / span, y = r.cumulative_cost / c;
      if (f <= 0.5) half = Math.max(half, y);
      if (cross === null && y > CONFIG.COST_LINE) cross = f;
    });
    var margin = (1 - CONFIG.OVERHEAD_SHARE) - cost / c;
    return {job: j.job, cost_pct: cost / c, margin: margin, hours_per_1k: (+j.drafting_hours + +j.shop_hours) / c * 1000,
      weeks: Math.round(span), cost_at_half_schedule: half, crossed_line_at: cross,
      outcome: margin >= CONFIG.MARGIN_TARGET ? label_('hit') : margin >= 0 ? label_('under') : 'Lost money'};
  });
}

/** Outcome and verdict labels that name the margin target, e.g. "Hit 16%". */
function label_(kind) {
  var t = Math.round(CONFIG.MARGIN_TARGET * 100) + '%';
  return {hit: 'Hit ' + t, under: 'Made money, missed ' + t, missing: 'Likely misses ' + t}[kind];
}

function median_(v) { v = v.slice().sort(function (a, b) { return a - b; }); var m = v.length >> 1; return v.length % 2 ? v[m] : (v[m - 1] + v[m]) / 2; }

function lookbackSummary(lookback, metrics) {
  var m = {}; metrics.forEach(function (r) { m[r.job] = r; });
  var hit = metrics.filter(function (r) { return r.outcome === label_('hit'); });
  var lost = metrics.filter(function (r) { return r.outcome === 'Lost money'; });
  var small = lookback.filter(function (j) { return +j.contract < 100000; });
  var hitMaxHalf = Math.max.apply(null, hit.map(function (r) { return r.cost_at_half_schedule; }));
  return {
    jobs: lookback.length, hit: hit.length, lost: lost.length,
    under: metrics.filter(function (r) { return r.outcome === label_('under'); }).length,
    small_jobs: small.length, small_lost: small.filter(function (j) { return m[j.job].outcome === 'Lost money'; }).length,
    hit_max_cost_at_half: hitMaxHalf,
    lost_over_hit_max: lost.filter(function (r) { return r.cost_at_half_schedule > hitMaxHalf; }).length,
    hit_max_hours_per_1k: Math.max.apply(null, hit.map(function (r) { return r.hours_per_1k; })),
    lost_median_hours_per_1k: median_(lost.map(function (r) { return r.hours_per_1k; })),
  };
}

function outlookFor(j, lb) {
  var C = CONFIG, base = 1 - C.OVERHEAD_SHARE;
  var c = +j.contract, d = +j.drafting_cost, s = +j.shop_cost, po = +j.po_received + +j.po_open;
  var cost = d + s + po, dp = +j.drafting_progress, sp = +j.shop_progress;
  var start = Date.parse(j.schedule_start), end = Date.parse(j.planned_finish), now = Date.parse(j.as_of);
  var row = {job: j.job, cost_to_date: Math.round(cost), cost_pct: c > 0 ? cost / c : null,
    hours_per_1k: c > 0 ? (+j.drafting_hours + +j.shop_hours) / c * 1000 : null,
    schedule_elapsed: start && end && end > start ? Math.max(0, (now - start) / (end - start)) : null,
    progress: 0.2 * dp + 0.8 * sp,
    invoiced_pct: !(c > 0) ? null : j.billed_paid !== null ? (j.billed_paid + (j.billed_open || 0)) / c : j.billing_status.indexOf('fully billed') === 0 ? 1 : null,
    expected_margin: null, low_margin: null, high_margin: null, projected_cost: null, verdict: ''};
  if (!(c > 0)) { row.verdict = 'No job value'; return row; }
  if (cost === 0) { row.verdict = 'Not started'; return row; }
  if (sp < C.MIN_SHOP_PROGRESS) { row.verdict = cost / c > lb.hit_max_cost_at_half ? 'Early warning' : 'Too early to call'; return row; }
  var dEac = dp >= 0.25 ? d / dp : d, sEac = s / sp, remaining = sEac - s, exp = po + dEac + sEac;
  var pess = exp + C.RANGE_SWING * remaining + (sp < 0.8 ? C.UNORDERED_MATERIALS * c : 0);
  var opt = exp - C.RANGE_SWING * remaining;
  row.projected_cost = Math.round(exp);
  row.expected_margin = base - exp / c;
  row.low_margin = base - pess / c;
  row.high_margin = base - opt / c;
  row.verdict = row.expected_margin < 0 ? 'Losing money' : row.expected_margin < C.MARGIN_TARGET ? label_('missing') :
    row.low_margin < C.MARGIN_TARGET ? 'At risk' : 'On track';
  return row;
}

function flagsFor(jobs, outlook, lb) {
  var o = {}; outlook.forEach(function (r) { o[r.job] = r; });
  var out = [];
  var p = function (x) { return (x * 100).toFixed(0) + '%'; };
  var usd = function (x) { return '$' + Math.round(x).toLocaleString('en-US'); };
  var add = function (job, code, severity, flag, detail) { out.push({id: job + ':' + code, job: job, severity: severity, flag: flag, detail: detail}); };
  jobs.forEach(function (j) {
    var r = o[j.job], c = +j.contract, sp = +j.shop_progress;
    if (!(c > 0)) { add(j.job, 'nocontract', 'high', 'No job value', 'Neither the billing sheet nor Innergy has a value for this job, but ' + usd(r.cost_to_date) + ' is already committed'); return; }
    if (r.cost_to_date === 0) return;
    var line = CONFIG.COST_LINE, budgetUsed = r.cost_pct / line, prog = r.progress;
    if (r.cost_pct > line) add(j.job, 'overline', 'high', 'Past the ' + p(line) + ' cost line', 'Spent ' + p(r.cost_pct) + ' of the job value');
    else if (budgetUsed - prog > 0.2) add(j.job, 'burn', 'high', 'Spending well ahead of progress', p(budgetUsed) + ' of the cost budget used at about ' + p(prog) + ' complete');
    else if (budgetUsed - prog > 0.1) add(j.job, 'burn', 'medium', 'Spending ahead of progress', p(budgetUsed) + ' of the cost budget used at about ' + p(prog) + ' complete');
    // Job value: billing sheet against Innergy. A gap is usually change orders that never made it into Innergy.
    if (j.contract_source === 'billing sheet' && Math.abs(c - j.innergy_value) > Math.max(CONFIG.CO_GAP_MIN, 0.02 * c))
      add(j.job, 'cogap', 'medium', c > j.innergy_value ? 'Billing value above Innergy' : 'Billing value below Innergy',
        'Billing sheet ' + usd(c) + ' vs Innergy ' + usd(j.innergy_value) + (c > j.innergy_value ? '. Likely change orders not entered in Innergy' : '. Check which is right'));
    // Cash: what's been spent against what's been invoiced (paid + open).
    if (j.billed_paid !== null) {
      var invoiced = j.billed_paid + (j.billed_open || 0);
      if (r.cost_to_date > invoiced) add(j.job, 'cash', 'high', 'Spent more than invoiced', 'Spent ' + usd(r.cost_to_date) + ', invoiced ' + usd(invoiced) + '. SP is out of pocket ' + usd(r.cost_to_date - invoiced));
      else if (r.cost_pct - invoiced / c > 0.15) add(j.job, 'cash', 'medium', 'Spending ahead of billing', 'Spent ' + p(r.cost_pct) + ' of the job value, invoiced ' + p(invoiced / c));
      if ((j.billed_open || 0) > 0) add(j.job, 'unpaid', 'low', 'Invoiced, not yet paid', usd(j.billed_open) + ' open or overdue');
    }
    if (r.schedule_elapsed !== null && r.schedule_elapsed <= 0.5 && r.cost_pct > lb.hit_max_cost_at_half)
      add(j.job, 'pace', 'high', 'Spending faster than any winning job', p(r.cost_pct) + ' of contract spent at ' + p(r.schedule_elapsed) + ' of the schedule; no winner had passed ' + p(lb.hit_max_cost_at_half) + ' by halfway');
    if (r.hours_per_1k > lb.lost_median_hours_per_1k) add(j.job, 'hours', 'high', 'Labor at losing-job levels', r.hours_per_1k.toFixed(1) + ' job hours per $1k; median loser used ' + lb.lost_median_hours_per_1k.toFixed(1));
    else if (r.hours_per_1k > lb.hit_max_hours_per_1k) add(j.job, 'hours', 'medium', 'Labor above any winning job', r.hours_per_1k.toFixed(1) + ' job hours per $1k; no winner used more than ' + lb.hit_max_hours_per_1k.toFixed(1));
    if (r.schedule_elapsed !== null && r.schedule_elapsed > 1) add(j.job, 'late', 'medium', 'Past planned finish', 'Latest planned ship date was ' + j.planned_finish);
    if (sp >= 0.95) add(j.job, 'open', 'medium', 'Shipped but still open', 'Last hours logged ' + (j.last_hours_logged || 'n/a'));
    if (+j.po_receiving_errors > 0) add(j.job, 'receiving', 'medium', 'PO receiving error corrected', j.po_receiving_error_detail + '; fix the receipt in Innergy');
    if (+j.po_open > 0) add(j.job, 'po', 'low', 'Open PO commitments', usd(+j.po_open) + ' ordered, not yet received (included in cost)');
    if (+j.unapproved_hours > 0) add(j.job, 'pending', 'low', 'Unapproved hours', Math.round(+j.unapproved_hours) + ' hrs not yet approved (included in cost)');
    var hrs = +j.drafting_hours + +j.shop_hours;
    if (+j.innergy_planned_hours > 0 && hrs > 1.5 * +j.innergy_planned_hours) add(j.job, 'planned', 'low', 'Innergy planned hours are stale', Math.round(hrs).toLocaleString('en-US') + ' hrs logged vs ' + Math.round(+j.innergy_planned_hours).toLocaleString('en-US') + ' planned');
    if (+j.drafting_hours === 0 && !j.drafting_note && +j.drafting_progress >= 0.5) add(j.job, 'nodraft', 'low', 'No drafting hours logged', 'Drafting time is probably landing on another job or overhead');
  });
  return out;
}

function boardSummary(jobs, outlook) {
  var c = {}; jobs.forEach(function (j) { c[j.job] = +j.contract; });
  var sum = function (rows) { return rows.reduce(function (a, r) { return a + (c[r.job] || 0); }, 0); };
  var by = function (v) { return outlook.filter(function (r) { return r.verdict === v; }); };
  var scored = outlook.filter(function (r) { return r.expected_margin !== null; });
  var out = {jobs: outlook.length, contract: sum(outlook),
    projected_margin: scored.length ? (1 - CONFIG.OVERHEAD_SHARE) - scored.reduce(function (a, r) { return a + r.projected_cost; }, 0) / sum(scored) : null};
  [['losing', 'Losing money'], ['missing', label_('missing')], ['at_risk', 'At risk'], ['early_warning', 'Early warning'],
    ['too_early', 'Too early to call'], ['on_track', 'On track'], ['no_contract', 'No job value'], ['not_started', 'Not started']]
    .forEach(function (kv) { out[kv[0]] = by(kv[1]).length; out[kv[0] + '_contract'] = sum(by(kv[1])); });
  return out;
}

// For testing outside Apps Script.
if (typeof module !== 'undefined') module.exports = {buildBoard: buildBoard, CONFIG: CONFIG, monthList_: monthList_, parseBillingRows: parseBillingRows, matchBilling: matchBilling};