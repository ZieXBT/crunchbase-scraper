'use strict';
/* Crunchbase saved-search client.
 * Uses the same private v4 endpoints the Crunchbase web app calls, authenticated
 * with the signed-in user's own cookie. No third-party service involved. */

const BASE = 'https://www.crunchbase.com';
const UA = 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 ' +
           '(KHTML, like Gecko) Chrome/126.0.0.0 Safari/537.36';
const PAGE_LIMIT = 1000;   // max rows Crunchbase returns per request
const WINDOW_CAP = 10000;  // hard pagination ceiling per sort order

/** Pull the collection + saved-search slug out of a /discover/ URL. */
function parseSearchUrl(raw) {
  let u;
  try { u = new URL(String(raw).trim()); }
  catch { throw new Error('That does not look like a URL.'); }
  if (!/(^|\.)crunchbase\.com$/i.test(u.hostname))
    throw new Error('URL must be on crunchbase.com.');
  const m = u.pathname.match(/\/discover\/([^/]+)\/([^/?#]+)/);
  if (!m) throw new Error(
    'Use a saved Advanced Search URL — it looks like ' +
    'crunchbase.com/discover/<collection>/<id>');
  return { collection: decodeURIComponent(m[1]), slug: decodeURIComponent(m[2]) };
}

function headers(cookie, json) {
  const h = {
    'cookie': cookie,
    'user-agent': UA,
    'accept': 'application/json, text/plain, */*',
    'accept-language': 'en-US,en;q=0.9',
    'referer': BASE + '/discover/',
    'origin': BASE,
  };
  if (json) h['content-type'] = 'application/json';
  return h;
}

async function call(url, opts, tries = 3) {
  let last;
  for (let a = 0; a < tries; a++) {
    let res;
    try { res = await fetch(url, opts); }
    catch (e) { last = e; await sleep(800 * (a + 1)); continue; }

    if (res.ok) return res.json();
    if (res.status === 401 || res.status === 403)
      throw new Error('Crunchbase rejected the cookie (HTTP ' + res.status +
        '). It has probably expired — grab a fresh one and try again.');
    if (res.status === 404)
      throw new Error('Crunchbase returned 404. Check the search URL is a saved search you can open while logged in.');
    if (res.status === 429) { last = new Error('Rate limited by Crunchbase.'); await sleep(4000 * (a + 1)); continue; }
    if (res.status >= 500) { last = new Error('Crunchbase error ' + res.status); await sleep(1500 * (a + 1)); continue; }
    throw new Error('Crunchbase returned HTTP ' + res.status);
  }
  throw last || new Error('Request failed after retries.');
}

const sleep = ms => new Promise(r => setTimeout(r, ms));

/** Fetch the saved search definition (filters, sort, requested fields). */
function getDefinition(cookie, collection, slug) {
  return call(`${BASE}/v4/md/searches/${encodeURIComponent(collection)}/${encodeURIComponent(slug)}`,
              { headers: headers(cookie, false) });
}

/** One page of results. */
function searchPage(cookie, collection, body) {
  return call(`${BASE}/v4/data/searches/${encodeURIComponent(collection)}?source=slug_advanced_search`,
              { method: 'POST', headers: headers(cookie, true), body: JSON.stringify(body) });
}

/** Total match count, without pulling rows. */
async function getCount(cookie, collection, def) {
  const j = await searchPage(cookie, collection,
    { field_ids: ['identifier'], order: def.order, query: def.query, limit: 1 });
  return j.count || 0;
}

function flipOrder(order) {
  return (order || []).map(o => ({ ...o, sort: o.sort === 'desc' ? 'asc' : 'desc' }));
}

/**
 * Walk a search, emitting batches as they arrive.
 * Crunchbase caps any single sort order at 10,000 rows, so when the caller wants
 * more than that we run the sort in reverse and merge on uuid to reach the tail.
 */
async function* streamSearch(cookie, collection, def, want, pauseMs = 600) {
  const seen = new Set();
  let emitted = 0;

  async function* sweep(order) {
    let after = null;
    while (emitted < want) {
      const body = { field_ids: def.field_ids, order, query: def.query,
                     limit: Math.min(PAGE_LIMIT, want - emitted) };
      if (after) body.after_id = after;
      const j = await searchPage(cookie, collection, body);
      const ents = j.entities || [];
      if (!ents.length) return;
      after = ents[ents.length - 1].uuid;

      const fresh = ents.filter(e => !seen.has(e.uuid));
      fresh.forEach(e => seen.add(e.uuid));
      if (fresh.length) { emitted += fresh.length; yield fresh; }
      if (ents.length < body.limit) return;
      await sleep(pauseMs);
    }
  }

  yield* sweep(def.order);
  if (emitted < want && emitted >= WINDOW_CAP - PAGE_LIMIT) yield* sweep(flipOrder(def.order));
}

module.exports = { parseSearchUrl, getDefinition, getCount, streamSearch, WINDOW_CAP, PAGE_LIMIT };
