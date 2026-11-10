// Reading Innergy's value formats.

/** Innergy money fields are objects like {Value: 1234.5, ...}. Missing or zero → 0. */
export function amount(x) {
  return (x && x.Value) || 0;
}

/**
 * Innergy durations ("hh:mm:ss", or "d.hh:mm:ss" past a day) → hours, to the whole minute.
 * Seconds are dropped (owner decision, 2026-11-10, both boards). Empty or unreadable → 0.
 */
export function durationHours(s) {
  const m = /^(?:(\d+)\.)?(\d+):(\d+)/.exec(s || '');
  return m ? +(m[1] || 0) * 24 + +m[2] + +m[3] / 60 : 0;
}

/**
 * [year, month] pairs from a "YYYY-MM" start through the month of `end` (a Date, local time).
 * Innergy serves timesheets a month at a time: /api/timeTracking/<year>/<month>.
 */
export function monthsThrough(start, end) {
  let y = +start.slice(0, 4), m = +start.slice(5, 7);
  const out = [], ey = end.getFullYear(), em = end.getMonth() + 1;
  while (y < ey || (y === ey && m <= em)) {
    out.push([y, m]);
    m++; if (m > 12) { m = 1; y++; }
  }
  return out;
}
