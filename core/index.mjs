// The shared engine. Pure functions only: no I/O, no Apps Script services, no SP values.
// Bundled into each board as the global `SPCore` (see lib/core-bundle.mjs).
export { amount, durationHours, monthsThrough } from './innergy.mjs';
export { laborRules, classifyLabor, laborRate, laborCost } from './labor.mjs';
