'use strict';
const http = require('http');
const fs = require('fs');
const path = require('path');
const cb = require('./crunchbase');
const { flattenEntity, orderColumns } = require('./flatten');

const PORT = process.env.PORT || 4300;
const PUBLIC = path.join(__dirname, 'public');
const MIME = { '.html':'text/html; charset=utf-8', '.js':'text/javascript; charset=utf-8',
               '.css':'text/css; charset=utf-8', '.svg':'image/svg+xml', '.ico':'image/x-icon' };

const readBody = req => new Promise((resolve, reject) => {
  let b = ''; let n = 0;
  req.on('data', c => { n += c.length; if (n > 2e6) { reject(new Error('Body too large')); req.destroy(); } b += c; });
  req.on('end', () => { try { resolve(JSON.parse(b || '{}')); } catch { reject(new Error('Invalid JSON body')); } });
  req.on('error', reject);
});

const json = (res, code, obj) => {
  res.writeHead(code, { 'content-type': 'application/json; charset=utf-8' });
  res.end(JSON.stringify(obj));
};

/** Turn the saved-search definition into something readable in the UI. */
function describe(def) {
  const parts = [];
  const walk = q => (q || []).forEach(p => {
    if (p.type === 'sub_query') { walk(p.query); return; }
    if (!p.field_id) return;
    const vals = (p.values || []).map(v =>
      (v && typeof v === 'object') ? (v.value ?? v.name ?? JSON.stringify(v)) : v);
    parts.push({
      field: String(p.field_id).replace(/_/g, ' '),
      op: String(p.operator_id || '').replace(/_/g, ' '),
      values: vals.slice(0, 6).join(', ') + (vals.length > 6 ? ` +${vals.length - 6} more` : ''),
    });
  });
  walk(def.query);
  return parts;
}

async function handleInspect(req, res) {
  const { cookie, url } = await readBody(req);
  if (!cookie || !String(cookie).trim()) return json(res, 400, { error: 'Paste your Crunchbase cookie first.' });
  if (!url || !String(url).trim()) return json(res, 400, { error: 'Paste a Crunchbase search URL first.' });

  const { collection, slug } = cb.parseSearchUrl(url);
  const def = await cb.getDefinition(cookie, collection, slug);
  if (!def || !def.query) throw new Error('That search returned no filter definition. Is it a saved Advanced Search?');
  const count = await cb.getCount(cookie, collection, def);

  json(res, 200, {
    collection, slug, count,
    fields: def.field_ids || [],
    order: def.order || [],
    filters: describe(def),
    windowCap: cb.WINDOW_CAP,
    reachable: count > cb.WINDOW_CAP ? Math.min(count, cb.WINDOW_CAP * 2) : count,
  });
}

async function handleScrape(req, res) {
  const { cookie, url, limit } = await readBody(req);
  const { collection, slug } = cb.parseSearchUrl(url);

  res.writeHead(200, {
    'content-type': 'text/event-stream; charset=utf-8',
    'cache-control': 'no-cache, no-transform',
    'connection': 'keep-alive',
    'x-accel-buffering': 'no',
  });
  const send = (event, data) => res.write(`event: ${event}\ndata: ${JSON.stringify(data)}\n\n`);

  let closed = false;
  req.on('close', () => { closed = true; });

  try {
    const def = await cb.getDefinition(cookie, collection, slug);
    const total = await cb.getCount(cookie, collection, def);
    const want = Math.max(1, Math.min(Number(limit) || total, total));
    send('meta', { total, want, collection });

    let cols = [];
    let got = 0;
    for await (const batch of cb.streamSearch(cookie, collection, def, want)) {
      if (closed) return;
      const rows = batch.map(flattenEntity);
      for (const r of rows) for (const k of Object.keys(r)) if (!cols.includes(k)) cols.push(k);
      cols = orderColumns(cols);
      got += rows.length;
      send('rows', { rows, cols, got, want });
    }
    send('done', { got });
  } catch (e) {
    send('fail', { error: e.message || String(e) });
  } finally {
    if (!closed) res.end();
  }
}

const server = http.createServer(async (req, res) => {
  try {
    if (req.method === 'POST' && req.url === '/api/inspect') return await handleInspect(req, res);
    if (req.method === 'POST' && req.url === '/api/scrape')  return await handleScrape(req, res);

    // static files
    const rel = req.url === '/' ? 'index.html' : decodeURIComponent(req.url.split('?')[0]).replace(/^\/+/, '');
    const file = path.join(PUBLIC, rel);
    if (!file.startsWith(PUBLIC)) { res.writeHead(403); return res.end('Forbidden'); }
    const buf = await fs.promises.readFile(file).catch(() => null);
    if (!buf) { res.writeHead(404); return res.end('Not found'); }
    res.writeHead(200, { 'content-type': MIME[path.extname(file)] || 'application/octet-stream' });
    res.end(buf);
  } catch (e) {
    if (!res.headersSent) json(res, 400, { error: e.message || 'Something went wrong.' });
    else res.end();
  }
});

server.listen(PORT, () => {
  console.log(`\n  Crunchbase Scraper running at  http://localhost:${PORT}\n`);
});
