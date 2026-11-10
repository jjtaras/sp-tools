// Burdened labor: which hours count, at which rate. Rules and rates come from the SP assumptions;
// this file has none of SP's values.

/** @typedef {{ drafting: number, other: number }} LaborRates  $/hr, burdened */

/**
 * The shared labor rules, built once per refresh.
 * @param {{Name: string, Type?: string}[]} laborItems  Innergy /api/labors
 * @param {{ overhead_items: string[], drafting_items: string[], drafting_type_prefix: string,
 *           drafting_department_prefix: string }} a  ASSUMPTIONS.labor
 */
export function laborRules(laborItems, a) {
  const drafting = new Set(a.drafting_items);
  for (const l of laborItems || []) if (String(l.Type || '').indexOf(a.drafting_type_prefix) === 0) drafting.add(l.Name);
  return { overhead: new Set(a.overhead_items), drafting, departmentPrefix: a.drafting_department_prefix };
}

/**
 * One timesheet entry → 'overhead' (never job cost), 'drafting' (drafting rate) or 'other' (everyone else).
 * Overhead wins; otherwise drafting by the person's department or by the labor item.
 */
export function classifyLabor(laborItemName, department, rules) {
  if (rules.overhead.has(laborItemName)) return 'overhead';
  if (String(department || '').indexOf(rules.departmentPrefix) === 0 || rules.drafting.has(laborItemName)) return 'drafting';
  return 'other';
}

/** The rate for one hour: drafting or everyone else. */
export function laborRate(isDrafting, rates) {
  return isDrafting ? rates.drafting : rates.other;
}

/** Dollars for a split of drafting and other (shop) hours. */
export function laborCost(draftingHours, otherHours, rates) {
  return draftingHours * rates.drafting + otherHours * rates.other;
}
