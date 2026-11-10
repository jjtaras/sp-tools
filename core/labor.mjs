// Burdened labor: hours to dollars. Rates come from the SP config; this file has none.

/** @typedef {{ drafting: number, other: number }} LaborRates  $/hr, burdened */

/** The rate for one hour: drafting or everyone else. */
export function laborRate(isDrafting, rates) {
  return isDrafting ? rates.drafting : rates.other;
}

/** Dollars for a split of drafting and other (shop) hours. */
export function laborCost(draftingHours, otherHours, rates) {
  return draftingHours * rates.drafting + otherHours * rates.other;
}
