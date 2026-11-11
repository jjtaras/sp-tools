/**
 * Tracker settings, taken from the shared ASSUMPTIONS (bundled from SP's assumptions.yaml).
 * Change values in assumptions.yaml and redeploy; only names map here.
 * cogs_labor_pct / material_reserve_pct: labor budget = cogs_labor_pct x WO value - max(material_reserve_pct x value, POs on the WO)
 * rate_drafting / rate_production: $/hr used to cost booked hours and convert the budget to shop hours
 * shop_crew x hours_per_week = weekly capacity line
 * exclude_jobs: job number -> reason, left off the tracker. hold_jobs: shown as on hold, out of counts and load.
 * value_overrides: job -> WO suffix -> value to use when the Innergy price is $0 or wrong.
 * install_included_jobs: job -> share of each WO's value that is installation (taken off before the value rule).
 * post_fab_fallback_share: past fabrication, remaining hours are capped at this share of the WO's labor budget.
 * critical_placeholders: job -> {from, to}: WOs dated 'from' are treated as due 'to' and labeled as a placeholder.
 * nonshop_pattern: production WOs whose name matches are field/logistics value, not shop hours.
 * outsourced: job -> WO suffix -> {scope, shop_hrs}: made outside; forecast = shop_hrs until Fab is done, then 0. Flagged on the page.
 * extra_jobs: Innergy project number -> label, for jobs with no job number in their Innergy name yet. Remove once numbered.
 * max_hrs_per_wo_per_day: work not yet in the shop is scheduled as late as possible at this rate per WO.
 */
var SETTINGS = (function (A) {
  var J = A.job_fixes;
  return {
    cogs_labor_pct: A.cost.cogs_share,
    material_reserve_pct: A.shop.material_reserve_share,
    rate_drafting: A.labor.rate_drafting,
    rate_production: A.labor.rate_other,
    shop_crew: A.shop.crew,
    hours_per_week: A.shop.hours_per_week,
    post_fab_fallback_share: A.shop.post_fab_fallback_share,
    value_overrides: J.value_overrides,
    nonshop_pattern: A.shop.nonshop_pattern,
    load_weeks: A.shop.load_weeks,
    max_hrs_per_wo_per_day: A.shop.max_hours_per_wo_per_day,
    exclude_jobs: J.exclude_jobs,
    hold_jobs: J.hold_jobs,
    install_included_jobs: J.install_included_jobs,
    critical_placeholders: J.critical_placeholders,
    outsourced: J.outsourced,
    extra_jobs: J.extra_jobs
  };
})(ASSUMPTIONS);

if (typeof module !== 'undefined') module.exports = { SETTINGS: SETTINGS };
