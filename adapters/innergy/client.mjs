// Innergy REST client for Node (GET only). Mirrors how the Apps Script boards call Innergy,
// so a recorded snapshot matches what the boards would have seen at that moment.
import { gunzipSync } from 'node:zlib';

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

/**
 * @param {object} o
 * @param {string} o.apiKey
 * @param {string} [o.baseUrl]   default https://app.innergy.com
 * @param {number} [o.batch]     concurrent requests (Innergy allows only a few per tenant)
 * @param {number} [o.maxTries]
 */
export function innergyClient({ apiKey, baseUrl = 'https://app.innergy.com', batch = 4, maxTries = 6 }) {
  const base = baseUrl.replace(/\/$/, '');

  async function once(path, follow) {
    const resp = await fetch(base + path, {
      method: 'GET',
      redirect: follow ? 'follow' : 'manual',
      headers: { 'Api-Key': apiKey, Accept: 'application/json' },
    });
    const buf = Buffer.from(await resp.arrayBuffer());
    // Some endpoints return a gzip body without a Content-Encoding header; the tracker unzips these by magic bytes.
    const bytes = buf.length > 1 && buf[0] === 0x1f && buf[1] === 0x8b ? gunzipSync(buf) : buf;
    return { status: resp.status, text: bytes.toString('utf8') };
  }

  /**
   * paths -> [{status, text}], a few at a time, retrying 429/5xx with backoff.
   * followRedirects matches UrlFetchApp's option of the same name (Apps Script follows by default).
   */
  async function getAll(paths, { followRedirects = true } = {}) {
    const out = new Array(paths.length);
    let pending = paths.map((_, i) => i);
    for (let attempt = 1; pending.length && attempt <= maxTries; attempt++) {
      const retry = [];
      for (let i = 0; i < pending.length; i += batch) {
        const idx = pending.slice(i, i + batch);
        const res = await Promise.all(idx.map((j) => once(paths[j], followRedirects).catch((e) => ({ status: 599, text: String(e) }))));
        res.forEach((r, k) => (r.status === 429 || r.status >= 500 ? retry.push(idx[k]) : (out[idx[k]] = r)));
        if (retry.length) await sleep(1500);
      }
      pending = retry;
      if (pending.length) await sleep(2000 * attempt);
    }
    if (pending.length) throw new Error(`Innergy kept refusing ${pending.length} requests (rate limit). Try again in a few minutes.`);
    return out;
  }

  return { getAll, get: async (path, opts) => (await getAll([path], opts))[0] };
}

export function qs(params) {
  return '?' + Object.keys(params).map((k) => encodeURIComponent(k) + '=' + encodeURIComponent(params[k])).join('&');
}
