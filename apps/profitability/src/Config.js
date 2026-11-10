// Margin Board settings, taken from the shared ASSUMPTIONS (bundled from SP's assumptions.yaml).
// Only names map here; every value comes from the assumptions file.
var CONFIG = (function (A) {
  var J = A.job_fixes;
  return {
    RATE_DRAFTING: A.labor.rate_drafting,             // $/hr, burdened, drafting department or drafting labor items
    RATE_OTHER: A.labor.rate_other,                   // $/hr, burdened, everyone else
    COST_LINE: A.cost.cogs_share,                     // cost of goods (labor + materials) should stay at or under this share of value
    OVERHEAD_SHARE: A.cost.overhead_share,            // margin = 1 - overhead - cost/value
    MARGIN_TARGET: A.cost.margin_target,
    BILLING_SHEET_ID: A.billing.sheet_id,             // the billing dashboard: source of truth for job values
    BILLING_TAB: A.billing.summary_tab,
    BILLING_MATCH: J.billing_match,                   // {'<project name as written in the billing sheet>': '<Innergy project number>'}
    CO_GAP_MIN: A.billing.co_gap_min,                 // flag when billing and Innergy values differ by more than this and 2%
    FULLY_BILLED_TOLERANCE: A.billing.fully_billed_tolerance,
    RECENT_DAYS: A.board.recent_days,                 // "still logging hours" window for fully billed jobs
    TIMESHEETS_START: A.innergy.timesheets_start,     // first month of timesheets in Innergy
    OVERHEAD_LABOR_ITEMS: A.labor.overhead_items,     // overhead, never job cost, even when booked to a job
    NOT_JOBS: A.innergy.not_jobs,                     // Innergy projects that aren't real jobs
    LOOKBACK_EXCLUDE: A.lookback.exclude,
    LOOKBACK_MIN_CONTRACT: A.lookback.min_contract,
    LOOKBACK_CREATED_FROM: A.lookback.created_from,
    JOB_NOTES: J.job_notes,
    DRAFT_STEP: A.progress.drafting_by_step,          // share of a WO's drafting done, by workflow step; others = 1
    SHOP_STEP: A.progress.shop_by_step,               // share of a WO's shop work done, by workflow step; others = 0
    RANGE_SWING: A.outlook.range_swing,
    UNORDERED_MATERIALS: A.outlook.unordered_materials,
    MIN_SHOP_PROGRESS: A.outlook.min_shop_progress,   // below this, too early to project
    DATA_FILE_NAME: 'SP Margin Board data.json',
    STALE_AFTER_HOURS: A.board.stale_after_hours,
  };
})(ASSUMPTIONS);
