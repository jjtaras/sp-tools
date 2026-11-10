// How each board turns a snapshot into its saved output. These mirror the boards' refresh
// functions minus the Google calls, so the same snapshot always gives the same output.
import { plain } from './gas.mjs';

// The boards run in America/New_York; String(date) and local-date math depend on it.
process.env.TZ = 'America/New_York';

export const APPS = {
  'margin-board': {
    baseline: 'profitability',
    // refreshData(): fetchInnergy_() + readBilling_() -> buildBoard(raw, today)
    run(ctx, fx) {
      let billing, billingError = null;
      try { billing = ctx.parseBillingRows(fx.billing.mstr, fx.billing.tabs); }
      catch (e) { billing = []; billingError = String((e && e.message) || e); }
      const out = plain(ctx.buildBoard({ ...fx.margin, billing }, fx.meta.today));
      out.meta.billing_error = billingError;
      return out;
    },
  },
  'production-tracker': {
    baseline: 'shop-schedule',
    // refresh(): pull_() -> build(raw, {today, asof, settings: SETTINGS, labor: ASSUMPTIONS.labor})
    run(ctx, fx) {
      // Labor items and timesheets are recorded once per snapshot (in innergy-margin.json) and serve both boards.
      const raw = { ...fx.tracker, labors: fx.tracker.labors || fx.margin.labors, timesheets: fx.tracker.timesheets || fx.margin.timesheets };
      return plain(ctx.build(raw, { today: fx.meta.today, asof: fx.meta.asof, settings: ctx.SETTINGS, labor: ctx.ASSUMPTIONS.labor }));
    },
  },
};
