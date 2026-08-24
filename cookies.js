'use strict';
/* Accepts whatever shape the user pastes and returns a `cookie:` header string.
 *
 * Supported:
 *   1. Raw header value      "a=1; b=2"          (DevTools → Network → Request Headers)
 *   2. Cookie-Editor JSON    [{name,value,...}]  (the Export button in the extension)
 *   3. A bare {name: value} object
 *   4. Any of the above prefixed with "cookie:" / "Cookie:"
 */

const WANTED_HOST = /(^|\.)crunchbase\.com$/i;

function fromPairs(pairs) {
  const seen = new Map();               // later duplicates win, matching browser behaviour
  for (const { name, value } of pairs) {
    if (!name) continue;
    seen.set(String(name).trim(), String(value == null ? '' : value));
  }
  return [...seen].map(([k, v]) => `${k}=${v}`).join('; ');
}

function normalizeCookie(input) {
  let raw = String(input == null ? '' : input).trim();
  if (!raw) throw new Error('Paste your Crunchbase cookie first.');
  raw = raw.replace(/^\s*cookie\s*:\s*/i, '').trim();

  if (raw.startsWith('[') || raw.startsWith('{')) {
    let data;
    try { data = JSON.parse(raw); }
    catch {
      throw new Error('That looks like JSON but it is incomplete — make sure you copied ' +
                      'the whole export, including the closing bracket.');
    }

    if (Array.isArray(data)) {
      const entries = data.filter(c => c && typeof c === 'object' && c.name);
      if (!entries.length) throw new Error('No cookies found in that JSON export.');

      // Cookie-Editor exports one domain at a time, but if a multi-domain export is
      // pasted, keep only the crunchbase entries.
      const scoped = entries.filter(c => {
        const d = String(c.domain || '').replace(/^\./, '').trim();
        return !d || WANTED_HOST.test(d);
      });
      const use = scoped.length ? scoped : entries;
      const header = fromPairs(use);
      if (!header) throw new Error('That export had no usable cookie values.');
      return header;
    }

    if (data && typeof data === 'object') {
      const header = fromPairs(Object.entries(data).map(([name, value]) => ({ name, value })));
      if (!header) throw new Error('That JSON object had no cookie values.');
      return header;
    }
    throw new Error('Unrecognised JSON. Paste the Cookie-Editor export array.');
  }

  if (!raw.includes('=')) throw new Error(
    'That does not look like a cookie. Paste either the raw cookie header ' +
    '(name=value; name=value) or the Cookie-Editor JSON export.');

  // strip newlines a wrapped copy/paste can introduce
  return raw.replace(/[\r\n]+/g, ' ').replace(/\s{2,}/g, ' ').trim();
}

/** Warn early when the session cookies Crunchbase actually needs are absent. */
function auditCookie(header) {
  const names = new Set(header.split(';').map(p => p.split('=')[0].trim()).filter(Boolean));
  const missing = ['authcookie', 'trustcookie'].filter(n => !names.has(n));
  return { names: [...names], missing };
}

/** Crunchbase's authcookie is a short-lived JWT. Read its expiry so we can warn
 *  the user before a long scrape dies halfway through. */
function sessionLife(header) {
  const m = /(?:^|;\s*)authcookie=([^;]+)/.exec(header);
  if (!m) return null;
  const parts = m[1].split('.');
  if (parts.length < 2) return null;
  try {
    const pad = parts[1] + '='.repeat((4 - parts[1].length % 4) % 4);
    const claims = JSON.parse(Buffer.from(pad, 'base64url').toString('utf8'));
    if (!claims.exp) return null;
    return { exp: claims.exp, secondsLeft: claims.exp - Math.floor(Date.now() / 1000) };
  } catch { return null; }
}

module.exports = { normalizeCookie, auditCookie, sessionLife };
