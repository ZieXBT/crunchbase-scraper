/* Crunchbase Scraper — runs inside the Crunchbase tab.
 *
 * Crunchbase sits behind Cloudflare bot protection that fingerprints the TLS
 * handshake, so requests from Node/curl are refused with a 403 challenge no matter
 * how good the cookie or headers are. Running in the page means the browser makes
 * the request: right fingerprint, right cookies, nothing to paste, nothing to expire.
 *
 * Paste into DevTools console on any crunchbase.com page, or use it as a bookmarklet.
 */
(() => {
  'use strict';
  if (window.__cbScraper) { window.__cbScraper.open(); return; }

  const BASE = location.origin;
  let PAGE = 1000; const CAP = 10000;
  const nf = new Intl.NumberFormat('en-US');
  const S = { def:null, coll:null, total:0, reach:0, rows:[], cols:[], stop:false, t0:0, fields:null, dropped:[], canPaginate:true };

  /* ---------------- api ---------------- */
  const api = async (path, opts={}) => {
    const r = await fetch(BASE + path, { credentials:'include', ...opts,
      headers:{ 'accept':'application/json', ...(opts.body?{'content-type':'application/json'}:{}) , ...(opts.headers||{}) }});
    if (r.status === 401 || r.status === 403) throw new Error('Crunchbase says you are signed out. Reload the page, sign in, and run this again.');
    if (!r.ok) {
      let detail = '';
      try { const j = await r.json(); detail = (Array.isArray(j)&&j[0]&&j[0].message) || ''; } catch {}
      throw new Error(detail || ('Crunchbase returned HTTP ' + r.status));
    }
    return r.json();
  };
  const parseUrl = (raw) => {
    const m = String(raw).match(/\/discover\/([^/]+)\/([^/?#]+)/);
    if (!m) throw new Error('Open a saved Advanced Search first — the URL should look like /discover/<collection>/<id>.');
    return { collection: decodeURIComponent(m[1]), slug: decodeURIComponent(m[2]) };
  };
  const search = (coll, body) => api(`/v4/data/searches/${encodeURIComponent(coll)}?source=slug_advanced_search`,
    { method:'POST', body: JSON.stringify(body) });

  // Crunchbase caps page size per plan (Pro allows 1000; a plain account allows 15).
  // Probe once, largest first, and use whatever the account permits.
  async function detectPageSize(coll){
    for (const n of [1000, 100, 50, 25, 15]){
      try {
        const r = await fetch(`${BASE}/v4/data/searches/${encodeURIComponent(coll)}?source=slug_advanced_search`,
          { method:'POST', credentials:'include', headers:{'content-type':'application/json','accept':'application/json'},
            body: JSON.stringify({ field_ids:['identifier'], order:S.def.order, query:S.def.query, limit:n }) });
        if (r.ok) return n;
        const j = await r.json().catch(()=>[]);
        const m = /cannot exceed (\d+)/.exec((j[0]&&j[0].message)||'');
        if (m) return Number(m[1]);          // server told us the exact cap
      } catch {}
    }
    return 15;
  }

  // A non-Pro account can't select Pro-gated fields (website, linkedin, …). The API
  // names the offending field_ids in its 400, so drop them and retry until it passes.
  async function resolveFields(coll){
    let fields = (S.def.field_ids || ['identifier']).slice();
    const dropped = [];
    for (let i = 0; i < 8; i++){
      const r = await fetch(`${BASE}/v4/data/searches/${encodeURIComponent(coll)}?source=slug_advanced_search`,
        { method:'POST', credentials:'include', headers:{'content-type':'application/json','accept':'application/json'},
          body: JSON.stringify({ field_ids:fields, order:S.def.order, query:S.def.query, limit:1 }) });
      if (r.ok) return { fields, dropped };
      const j = await r.json().catch(()=>[]);
      const bad = [...new Set((Array.isArray(j)?j:[]).filter(e=>e&&e.field_id).map(e=>e.field_id))];
      if (!bad.length) return { fields, dropped };            // 400 for some other reason; let the scrape surface it
      dropped.push(...bad);
      fields = fields.filter(f => !bad.includes(f));
      if (!fields.length) fields = ['identifier'];
      await sleep(300);
    }
    return { fields, dropped };
  }

  // Non-Pro accounts return a single page and reject after_id with a 'paginate' 403.
  // Probe once so we can tell the user upfront instead of failing mid-scrape.
  async function canPaginate(coll){
    const one = await search(coll, { field_ids:['identifier'], order:S.def.order, query:S.def.query, limit:1 })
      .catch(()=>null);
    const uuid = one && one.entities && one.entities[0] && one.entities[0].uuid;
    if (!uuid) return true;                       // inconclusive; assume yes
    const r = await fetch(`${BASE}/v4/data/searches/${encodeURIComponent(coll)}?source=slug_advanced_search`,
      { method:'POST', credentials:'include', headers:{'content-type':'application/json','accept':'application/json'},
        body: JSON.stringify({ field_ids:['identifier'], order:S.def.order, query:S.def.query, limit:1, after_id:uuid }) });
    if (r.ok) return true;
    const j = await r.json().catch(()=>[]);
    return !(Array.isArray(j) && j.some(e => /paginate/i.test(e.message||'')));
  }
  const sleep = ms => new Promise(r => setTimeout(r, ms));
  const flip = o => (o||[]).map(x => ({...x, sort: x.sort === 'desc' ? 'asc' : 'desc'}));

  /* ---------------- flatten ---------------- */
  const TITLE = s => String(s ?? '').replace(/_/g,' ').replace(/\b\w/g, c => c.toUpperCase());
  const scalar = v => {
    if (v == null) return '';
    if (typeof v !== 'object') return String(v);
    if (v.value_usd != null) return String(v.value_usd);
    if ('value' in v && typeof v.value !== 'object') return String(v.value);
    if ('value' in v) return scalar(v.value);
    return '';
  };
  function flat(e){
    const p = e.properties || {}, out = { uuid: e.uuid || '' };
    for (const [k,v] of Object.entries(p)) {
      if (v == null) { out[k] = ''; continue; }
      if (k === 'identifier' && !Array.isArray(v) && typeof v === 'object') {
        out.name = v.value || '';
        out.crunchbase_url = v.permalink ? `${BASE}/${v.entity_def_id || 'organization'}/${v.permalink}` : '';
        continue;
      }
      if (Array.isArray(v)) {
        const objs = v.filter(x => x && typeof x === 'object');
        if (k.includes('location') && objs.some(o => o.location_type)) {
          const pick = t => (objs.find(o => o.location_type === t) || {}).value || '';
          out.city = pick('city'); out.region = pick('region'); out.country = pick('country');
        }
        out[k] = v.map(x => (x && typeof x === 'object') ? (x.value || x.name || '') : TITLE(x)).filter(Boolean).join(', ');
        continue;
      }
      if (typeof v === 'object') { out[k] = scalar(v); continue; }
      out[k] = (typeof v === 'string' && /^[a-z0-9]+(_[a-z0-9]+)+$/.test(v)) ? TITLE(v) : String(v);
    }
    for (const k in out) out[k] = String(out[k] ?? '').replace(/\s+/g,' ').trim();
    return out;
  }
  const order = cols => {
    const F = ['name','crunchbase_url','city','region','country','website','linkedin'];
    const L = ['uuid','short_description','description'];
    return [...F.filter(c=>cols.includes(c)),
            ...cols.filter(c=>!F.includes(c)&&!L.includes(c)).sort(),
            ...L.filter(c=>cols.includes(c))];
  };
  const q = v => { const s = v == null ? '' : String(v); return /[",\n\r]/.test(s) ? '"'+s.replace(/"/g,'""')+'"' : s; };

  /* ---------------- ui ---------------- */
  const el = (t, a={}, kids=[]) => { const n = document.createElement(t);
    for (const [k,v] of Object.entries(a)) k === 'style' ? n.style.cssText = v : (k === 'html' ? n.innerHTML = v : n.setAttribute(k,v));
    kids.forEach(c => n.appendChild(c)); return n; };

  const CSS = `
  #cbs-root,#cbs-root *{box-sizing:border-box;font-family:ui-sans-serif,system-ui,-apple-system,"Segoe UI",Roboto,sans-serif}
  #cbs-root{position:fixed;inset:0;z-index:2147483647;background:rgba(9,12,16,.78);display:flex;align-items:center;justify-content:center;padding:24px}
  #cbs-card{background:#151b22;color:#e7edf2;border:1px solid #263039;border-radius:10px;width:min(1000px,100%);max-height:92vh;
    display:flex;flex-direction:column;box-shadow:0 24px 70px rgba(0,0,0,.5)}
  #cbs-card header{display:flex;justify-content:space-between;align-items:center;padding:16px 22px;border-bottom:1px solid #263039}
  #cbs-card h2{margin:0;font-size:17px;font-weight:650;letter-spacing:-.01em}
  #cbs-body{padding:22px;overflow:auto}
  .cbs-x{background:none;border:0;color:#8b96a2;font-size:22px;cursor:pointer;line-height:1;padding:0 4px}
  .cbs-stats{display:grid;grid-template-columns:repeat(auto-fit,minmax(130px,1fr));gap:1px;background:#263039;border:1px solid #263039;border-radius:6px;overflow:hidden;margin-bottom:18px}
  .cbs-stat{background:#151b22;padding:14px}
  .cbs-stat b{display:block;font-size:23px;font-variant-numeric:tabular-nums;letter-spacing:-.02em}
  .cbs-stat span{display:block;font-size:10.5px;text-transform:uppercase;letter-spacing:.08em;color:#7d8b98;margin-top:4px}
  .cbs-note{border:1px solid #6b5526;background:#241f14;border-radius:6px;padding:11px 14px;font-size:13px;margin-bottom:16px;line-height:1.5}
  .cbs-note.bad{border-color:#7d3427;background:#2a1a17;color:#f0937c}
  .cbs-h3{font-size:11px;text-transform:uppercase;letter-spacing:.09em;color:#7d8b98;margin:0 0 9px;font-weight:600}
  .cbs-f{width:100%;border-collapse:collapse;font-size:13px;margin-bottom:18px}
  .cbs-f td{padding:7px 11px;border-bottom:1px solid #1e262e}
  .cbs-f td:first-child{font-weight:600;white-space:nowrap;width:1%}
  .cbs-f td.op{color:#7d8b98;white-space:nowrap;width:1%;font-size:12px}
  .cbs-amt{display:flex;gap:12px;align-items:center;margin-bottom:8px;flex-wrap:wrap}
  .cbs-amt input[type=range]{flex:1;min-width:180px;accent-color:#4d9bf0}
  .cbs-amt input[type=number]{width:110px;padding:8px 10px;border-radius:5px;border:1px solid #33404c;background:#0f1418;color:#e7edf2;font-variant-numeric:tabular-nums}
  .cbs-btn{padding:9px 17px;border-radius:5px;border:1px solid transparent;font-weight:600;font-size:13.5px;cursor:pointer}
  .cbs-p{background:#4d9bf0;color:#0e1216}.cbs-p:disabled{opacity:.45;cursor:not-allowed}
  .cbs-g{background:transparent;border-color:#33404c;color:#a3b0bd}
  .cbs-row{display:flex;gap:9px;align-items:center;flex-wrap:wrap;margin-top:6px}
  .cbs-bar{height:6px;background:#263039;border-radius:99px;overflow:hidden;margin:14px 0 7px}
  .cbs-bar i{display:block;height:100%;width:0;background:#4d9bf0;transition:width .25s}
  .cbs-bar.ok i{background:#4cc38a}
  .cbs-hint{font-size:12.5px;color:#7d8b98;margin:0 0 4px}
  .cbs-wrap{max-height:44vh;overflow:auto;border:1px solid #263039;border-radius:6px;margin-top:14px}
  .cbs-t{border-collapse:collapse;width:100%;font-size:12.5px}
  .cbs-t th{position:sticky;top:0;background:#151b22;text-align:left;padding:8px 11px;border-bottom:1px solid #33404c;
    font-size:10.5px;text-transform:uppercase;letter-spacing:.07em;color:#7d8b98;white-space:nowrap}
  .cbs-t td{padding:7px 11px;border-bottom:1px solid #1e262e;white-space:nowrap;max-width:250px;overflow:hidden;text-overflow:ellipsis}
  `;

  let root, body;
  function open(){
    if (root) { root.style.display='flex'; return; }
    document.head.appendChild(el('style',{html:CSS}));
    body = el('div',{id:'cbs-body'});
    const close = el('button',{class:'cbs-x'}); close.textContent='×';
    close.onclick = () => { S.stop = true; root.style.display='none'; };
    const card = el('div',{id:'cbs-card'},[
      el('header',{},[ (()=>{const h=el('h2');h.textContent='Crunchbase Scraper';return h;})(), close ]),
      body ]);
    root = el('div',{id:'cbs-root'},[card]);
    root.addEventListener('click', e => { if (e.target === root) close.onclick(); });
    document.body.appendChild(root);
    review();
  }

  const esc = s => String(s ?? '').replace(/[&<>"']/g, c => ({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c]));

  function describe(def){
    const out = [];
    (function walk(qs){ (qs||[]).forEach(p => {
      if (p.type === 'sub_query') return walk(p.query);
      if (!p.field_id) return;
      const vals = (p.values||[]).map(v => (v && typeof v === 'object') ? (v.value ?? v.name ?? '') : v);
      out.push([String(p.field_id).replace(/_/g,' '), String(p.operator_id||'').replace(/_/g,' '),
                vals.slice(0,6).join(', ') + (vals.length>6?` +${vals.length-6} more`:'')]);
    }); })(def.query);
    return out;
  }

  async function review(){
    body.innerHTML = '<p class="cbs-hint">Reading this search…</p>';
    try {
      const { collection, slug } = parseUrl(location.pathname);
      S.coll = collection;
      S.def = await api(`/v4/md/searches/${encodeURIComponent(collection)}/${encodeURIComponent(slug)}`);
      const c = await search(collection, { field_ids:['identifier'], order:S.def.order, query:S.def.query, limit:1 });
      S.total = c.count || 0;
      PAGE = await detectPageSize(collection);
      const rf = await resolveFields(collection);
      S.fields = rf.fields; S.dropped = rf.dropped;
      S.canPaginate = await canPaginate(collection);
      if (!S.canPaginate) S.reach = Math.min(S.reach, PAGE);
      if (!S.total) throw new Error('This search matched 0 records.');
      S.reach = S.total > CAP ? Math.min(S.total, CAP*2) : S.total;

      body.innerHTML = `
        <div class="cbs-stats">
          <div class="cbs-stat"><b>${nf.format(S.total)}</b><span>Records found</span></div>
          <div class="cbs-stat"><b>${(S.fields||S.def.field_ids||[]).length}</b><span>Columns</span></div>
          <div class="cbs-stat"><b style="font-size:14px;font-family:ui-monospace,monospace;padding-top:6px">${esc(collection)}</b><span>Collection</span></div>
        </div>
        ${!S.canPaginate ? `<div class="cbs-note bad">Your Crunchbase plan does not allow pagination, so only the
          first <b>${PAGE}</b> of ${nf.format(S.total)} records can be exported. Fetching the rest requires
          <b>Crunchbase Pro</b>.</div>`
        : (S.total > CAP ? `<div class="cbs-note">Crunchbase stops paginating at <b>${nf.format(CAP)}</b> rows per sort order.
          Running the sort in reverse reaches about <b>${nf.format(S.reach)}</b> of the ${nf.format(S.total)} matches.
          For the rest, split the search into narrower filters.</div>` : '')}
        ${S.dropped.length ? `<div class="cbs-note">Your Crunchbase plan can't export ${S.dropped.length} field${S.dropped.length>1?'s':''}
          (<b>${S.dropped.map(esc).join(', ')}</b>). They'll be left out. A Pro plan includes them.</div>` : ''}
        <p class="cbs-h3">Filters on this search</p>
        <table class="cbs-f"><tbody>${
          describe(S.def).map(r=>`<tr><td>${esc(r[0])}</td><td class="op">${esc(r[1])}</td><td>${esc(r[2])}</td></tr>`).join('')
          || '<tr><td colspan="3">No filters — the whole collection.</td></tr>'}</tbody></table>
        <p class="cbs-h3">How many records?</p>
        <div class="cbs-amt">
          <input id="cbs-range" type="range" min="1" max="${S.reach}" value="${S.reach}">
          <input id="cbs-num" type="number" min="1" max="${S.reach}" value="${S.reach}">
          <button class="cbs-btn cbs-g" id="cbs-all">All</button>
        </div>
        <p class="cbs-hint" id="cbs-eta"></p>
        <div class="cbs-row"><button class="cbs-btn cbs-p" id="cbs-go">Start scraping</button></div>`;

      const rg = body.querySelector('#cbs-range'), nu = body.querySelector('#cbs-num');
      const perReq = PAGE >= 100 ? 2.2 : 0.65;   // big pages are slower per call but far fewer
      const eta = () => { const n = Math.max(1, Math.min(S.reach, +nu.value||1));
        const s = Math.ceil(n/PAGE)*perReq;
        const t = s<60?Math.max(3,Math.round(s))+' seconds':Math.round(s/60)+' minutes';
        body.querySelector('#cbs-eta').textContent =
          `${nf.format(n)} of ${nf.format(S.total)} records · ${PAGE} per request · roughly ${t}.`; };
      rg.oninput = () => { nu.value = rg.value; eta(); };
      nu.oninput = () => { rg.value = Math.max(1, Math.min(S.reach, +nu.value||1)); eta(); };
      body.querySelector('#cbs-all').onclick = () => { nu.value = S.reach; rg.value = S.reach; eta(); };
      body.querySelector('#cbs-go').onclick = () => run(Math.max(1, Math.min(S.reach, +nu.value||1)));
      eta();
    } catch (e) {
      body.innerHTML = `<div class="cbs-note bad">${esc(e.message)}</div>`;
    }
  }

  async function run(want){
    S.rows = []; S.cols = []; S.stop = false; S.t0 = Date.now();
    body.innerHTML = `
      <div class="cbs-row" style="justify-content:space-between">
        <div><b id="cbs-title" style="font-size:16px">Scraping…</b>
        <p class="cbs-hint" id="cbs-sub" style="margin:4px 0 0">Rows appear below as they arrive.</p></div>
        <div class="cbs-row">
          <button class="cbs-btn cbs-p" id="cbs-dl" disabled>Download CSV</button>
          <button class="cbs-btn cbs-g" id="cbs-stop">Stop</button>
        </div>
      </div>
      <div class="cbs-bar"><i id="cbs-fill"></i></div>
      <p class="cbs-hint"><b id="cbs-got">0</b> of <b>${nf.format(want)}</b> records<span id="cbs-rate"></span></p>
      <div id="cbs-err"></div>
      <div class="cbs-wrap"><table class="cbs-t"><thead id="cbs-th"></thead><tbody id="cbs-tb"></tbody></table></div>
      <p class="cbs-hint" id="cbs-prev"></p>`;
    const $ = s => body.querySelector(s);
    $('#cbs-stop').onclick = () => { S.stop = true; };
    $('#cbs-dl').onclick = download;

    const seen = new Set();
    let got = 0;
    async function sweep(ord){
      let after = null;
      while (got < want && !S.stop) {
        const b = { field_ids:S.fields || S.def.field_ids, order:ord, query:S.def.query, limit:Math.min(PAGE, want-got) };
        if (after) b.after_id = after;
        let j;
        try { j = await search(S.coll, b); }
        catch (err) {
          if (/paginate/i.test(err.message||'') || after) return; // plan blocks pagination, or a later page failed: keep what we have
          throw err;                                              // first page failed for a real reason
        }
        const ents = j.entities || [];
        if (!ents.length) return;
        after = ents[ents.length-1].uuid;
        const fresh = ents.filter(e => !seen.has(e.uuid));
        fresh.forEach(e => seen.add(e.uuid));
        if (fresh.length){
          const rows = fresh.map(flat);
          rows.forEach(r => Object.keys(r).forEach(k => { if (!S.cols.includes(k)) S.cols.push(k); }));
          S.cols = order(S.cols);
          S.rows.push(...rows); got += rows.length;
          paint(rows);
          $('#cbs-fill').style.width = Math.min(100, Math.round(100*got/want)) + '%';
          $('#cbs-got').textContent = nf.format(got);
          const secs = (Date.now()-S.t0)/1000;
          if (secs > 1) $('#cbs-rate').textContent = ` · ${Math.round(got/secs)} rows/sec`;
        }
        if (ents.length < b.limit) return;
        await sleep(PAGE >= 100 ? 600 : 150);
      }
    }
    function paint(rows){
      const th = $('#cbs-th'), tb = $('#cbs-tb');
      if (th.children.length === 0 || th.querySelectorAll('th').length !== S.cols.length){
        th.innerHTML = '<tr>' + S.cols.map(c=>`<th>${esc(c)}</th>`).join('') + '</tr>';
      }
      if (tb.children.length >= 200){ $('#cbs-prev').textContent =
        `Showing the first 200 of ${nf.format(S.rows.length)} rows — the CSV has all of them.`; return; }
      tb.insertAdjacentHTML('beforeend', rows.slice(0, 200-tb.children.length).map(r =>
        '<tr>'+S.cols.map(c=>`<td title="${esc(r[c]??'')}">${esc(r[c]??'')}</td>`).join('')+'</tr>').join(''));
    }

    try {
      await sweep(S.def.order);
      if (got < want && !S.stop && got >= CAP - PAGE) await sweep(flip(S.def.order));
      $('#cbs-title').textContent = S.stop ? 'Stopped' : 'Done';
      if (!S.stop) $('#cbs-fill').style.width = '100%';
      body.querySelector('.cbs-bar').classList.add('ok');
    } catch (e) {
      $('#cbs-err').innerHTML = `<div class="cbs-note bad">${esc(e.message)}${
        S.rows.length ? ' <b>Rows already retrieved are still downloadable.</b>' : ''}</div>`;
      $('#cbs-title').textContent = 'Failed';
    }
    $('#cbs-sub').textContent = `${nf.format(S.rows.length)} records · ${S.cols.length} columns · ${Math.max(1,Math.round((Date.now()-S.t0)/1000))}s`;
    $('#cbs-stop').style.display = 'none';
    $('#cbs-dl').disabled = S.rows.length === 0;
  }

  function download(){
    const csv = [S.cols.join(',')].concat(S.rows.map(r => S.cols.map(c => q(r[c])).join(','))).join('\n');
    const url = URL.createObjectURL(new Blob(['﻿'+csv], {type:'text/csv;charset=utf-8'}));
    const a = Object.assign(document.createElement('a'), { href:url, download:`crunchbase-${S.rows.length}-rows.csv` });
    document.body.appendChild(a); a.click(); a.remove();
    setTimeout(()=>URL.revokeObjectURL(url), 3000);
  }

  window.__cbScraper = { open };
  open();
})();
