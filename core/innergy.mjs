// Reading Innergy's value formats.

/** Innergy money fields are objects like {Value: 1234.5, ...}. Missing or zero → 0. */
export function amount(x) {
  return (x && x.Value) || 0;
}

/**
 * Innergy durations ("hh:mm:ss", or "d.hh:mm:ss" past a day) → hours.
 *
 * The two boards have always read these slightly differently, and both readings are kept here so
 * neither board's output changes. Unifying them is an assumption decision (log it in the SP config
 * CHANGELOG), not a refactor:
 *  - default (Margin Board): counts seconds. A value without seconds, or anything unparseable,
 *    gives NaN.
 *  - wholeMinutes (Production Tracker): ignores seconds. Anything that doesn't start like a
 *    duration gives 0.
 * Empty values give 0 either way.
 */
export function durationHours(s, { wholeMinutes = false } = {}) {
  if (!s) return 0;
  if (wholeMinutes) {
    const m = /^(?:(\d+)\.)?(\d+):(\d+)/.exec(s);
    return m ? +(m[1] || 0) * 24 + +m[2] + +m[3] / 60 : 0;
  }
  let d = 0;
  const parts = s.split(':');
  if (parts[0].indexOf('.') >= 0) {
    const dp = parts[0].split('.');
    d = +dp[0];
    parts[0] = dp[1];
  }
  return d * 24 + +parts[0] + +parts[1] / 60 + +parts[2] / 3600;
}
