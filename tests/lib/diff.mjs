// Structural differences between two board outputs, with job rows named by job number.

/** Up to `max` paths where a and b differ, e.g. "jobs[P-00-0000].contract: 1200 → 1250". */
export function differences(a, b, max = 25, at = '', out = []) {
  if (out.length >= max) return out;
  if (a === b || (Number.isNaN(a) && Number.isNaN(b))) return out;
  if (typeof a !== 'object' || typeof b !== 'object' || a === null || b === null || Array.isArray(a) !== Array.isArray(b)) {
    out.push(`${at || '(root)'}: ${JSON.stringify(a)} → ${JSON.stringify(b)}`);
    return out;
  }
  if (Array.isArray(a) && a.length !== b.length) out.push(`${at}: length ${a.length} → ${b.length}`);
  for (const k of new Set([...Object.keys(a), ...Object.keys(b)])) {
    const row = Array.isArray(a) ? (a[k] || b[k]) : null;
    const id = row && (row.job || (row.project && row.project.num) || row.n);
    const label = Array.isArray(a) ? `${at}[${id || k}]` : at ? `${at}.${k}` : k;
    differences(a[k], b[k], max, label, out);
  }
  return out;
}

/** Counts of changed values grouped by field path with row ids removed, e.g. "jobs[].shop_cost: 23". */
export function changeSummary(a, b) {
  const all = differences(a, b, Infinity);
  const groups = {};
  for (const d of all) {
    const key = d.split(': ')[0].replace(/\[[^\]]*\]/g, '[]');
    groups[key] = (groups[key] || 0) + 1;
  }
  return { total: all.length, groups, sample: all.slice(0, 15) };
}
