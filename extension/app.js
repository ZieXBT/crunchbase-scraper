'use strict';
/* Runs inside the extension, which holds host permission for crunchbase.com.
 * That means fetch() reaches the API cross-origin AND the browser attaches the
 * user's existing Crunchbase cookies — no cookie to paste, no CORS wall. */

const CB = 'https://www.crunchbase.com';
const CAP = 10000;
const $ = id => document.getElementById(id);
const nf = new Intl.NumberFormat('en-US');
const esc = s => String(s ?? '').replace(/[&<>"']/g, c =>
  ({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c]));
const sleep = ms => new Promise(r => setTimeout(r, ms));

let PAGE = 1000;
const S = { def:null, coll:null, total:0, reach:0, fields:null, dropped:[],
            canPaginate:true, rows:[], cols:[], stop:false, t0:0 };

/* ---------------- api ---------------- */
async function api(path, opts = {}) {
  const r = await fetch(CB + path, { credentials:'include', ...opts,
    headers:{ accept:'application/json', ...(opts.body?{'content-type':'application/json'}:{}) }});
  if (r.status === 401 || r.status === 403)
    throw new Error('Crunchbase says you are signed out. Open crunchbase.com, sign in, then try again.');
  if (r.status === 429) throw new Error('Crunchbase is rate limiting this account. Wait a few minutes and retry.');
  if (!r.ok) {
    let d = ''; try { const j = await r.json(); d = (Array.isArray(j)&&j[0]&&j[0].message) || ''; } catch {}
    throw new Error(d || ('Crunchbase returned HTTP ' + r.status));
  }
  return r.json();
}
const search = (coll, body) =>
  api(`/v4/data/searches/${encodeURIComponent(coll)}?source=slug_advanced_search`,
      { method:'POST', body: JSON.stringify(body) });

function parseUrl(raw) {
  let u; try { u = new URL(String(raw).trim()); }
  catch { throw new Error('That does not look like a URL.'); }
  if (!/(^|\.)crunchbase\.com$/i.test(u.hostname)) throw new Error('The link must be on crunchbase.com.');
  const m = u.pathname.match(/\/discover\/([^/]+)\/([^/?#]+)/);
  if (!m) throw new Error('Use a saved Advanced Search link — it looks like crunchbase.com/discover/<collection>/<id>');
  return { collection: decodeURIComponent(m[1]), slug: decodeURIComponent(m[2]) };
}
const flip = o => (o||[]).map(x => ({...x, sort: x.sort === 'desc' ? 'asc' : 'desc'}));

/* Page size and selectable fields both vary by plan — probe rather than assume. */
async function detectPageSize(coll){
  for (const n of [1000, 100, 50, 25, 15]) {
    try {
      const r = await fetch(`${CB}/v4/data/searches/${encodeURIComponent(coll)}?source=slug_advanced_search`,
        { method:'POST', credentials:'include', headers:{'content-type':'application/json',accept:'application/json'},
          body: JSON.stringify({ field_ids:['identifier'], order:S.def.order, query:S.def.query, limit:n }) });
      if (r.ok) return n;
      const j = await r.json().catch(()=>[]);
      const m = /cannot exceed (\d+)/.exec((j[0]&&j[0].message)||'');
      if (m) return Number(m[1]);
    } catch {}
  }
  return 15;
}
async function resolveFields(coll){
  let fields = (S.def.field_ids || ['identifier']).slice();
  const dropped = [];
  for (let i = 0; i < 8; i++) {
    const r = await fetch(`${CB}/v4/data/searches/${encodeURIComponent(coll)}?source=slug_advanced_search`,
      { method:'POST', credentials:'include', headers:{'content-type':'application/json',accept:'application/json'},
        body: JSON.stringify({ field_ids:fields, order:S.def.order, query:S.def.query, limit:1 }) });
    if (r.ok) return { fields, dropped };
    const j = await r.json().catch(()=>[]);
    const bad = [...new Set((Array.isArray(j)?j:[]).filter(e=>e&&e.field_id).map(e=>e.field_id))];
    if (!bad.length) return { fields, dropped };
    dropped.push(...bad);
    fields = fields.filter(f => !bad.includes(f));
    if (!fields.length) fields = ['identifier'];
    await sleep(250);
  }
  return { fields, dropped };
}
async function canPaginate(coll){
  const one = await search(coll, { field_ids:['identifier'], order:S.def.order, query:S.def.query, limit:1 }).catch(()=>null);
  const uuid = one && one.entities && one.entities[0] && one.entities[0].uuid;
  if (!uuid) return true;
  const r = await fetch(`${CB}/v4/data/searches/${encodeURIComponent(coll)}?source=slug_advanced_search`,
    { method:'POST', credentials:'include', headers:{'content-type':'application/json',accept:'application/json'},
      body: JSON.stringify({ field_ids:['identifier'], order:S.def.order, query:S.def.query, limit:1, after_id:uuid }) });
  if (r.ok) return true;
  const j = await r.json().catch(()=>[]);
  return !(Array.isArray(j) && j.some(e => /paginate/i.test(e.message||'')));
}

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
      out.crunchbase_url = v.permalink ? `${CB}/${v.entity_def_id || 'organization'}/${v.permalink}` : '';
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
const orderCols = cols => {
  const F = ['name','crunchbase_url','city','region','country','website','linkedin'];
  const L = ['uuid','short_description','description'];
  return [...F.filter(c=>cols.includes(c)),
          ...cols.filter(c=>!F.includes(c)&&!L.includes(c)).sort(),
          ...L.filter(c=>cols.includes(c))];
};
const q = v => { const s = v == null ? '' : String(v); return /[",\n\r]/.test(s) ? '"'+s.replace(/"/g,'""')+'"' : s; };

/* ---------------- step 1 ---------------- */
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
function show(n){ ['s1','s2','s3'].forEach((id,i)=>$(id).classList.toggle('hidden', i!==n-1)); window.scrollTo({top:0}); }
function say(t, bad){ $('s1msg').textContent = t||''; $('s1msg').classList.toggle('bad', !!bad); }

$('check').addEventListener('click', async () => {
  const url = $('url').value.trim();
  if (!url) return say('Paste a Crunchbase search link first.', true);
  $('check').disabled = true; say('Reading that search…');
  try {
    const { collection, slug } = parseUrl(url);
    S.coll = collection;
    S.def = await api(`/v4/md/searches/${encodeURIComponent(collection)}/${encodeURIComponent(slug)}`);
    if (!S.def || !S.def.query) throw new Error('That link returned no filters. Is it a saved Advanced Search?');
    const c = await search(collection, { field_ids:['identifier'], order:S.def.order, query:S.def.query, limit:1 });
    S.total = c.count || 0;
    if (!S.total) throw new Error('That search matched 0 records.');

    PAGE = await detectPageSize(collection);
    const rf = await resolveFields(collection);
    S.fields = rf.fields; S.dropped = rf.dropped;
    S.canPaginate = await canPaginate(collection);
    S.reach = S.total > CAP ? Math.min(S.total, CAP*2) : S.total;
    if (!S.canPaginate) S.reach = Math.min(S.reach, PAGE);

    $('count').textContent = nf.format(S.total);
    $('ncols').textContent = S.fields.length;
    $('coll').textContent = collection;
    $('filters').innerHTML = describe(S.def).map(r =>
      `<tr><td>${esc(r[0])}</td><td class="op">${esc(r[1])}</td><td>${esc(r[2])}</td></tr>`).join('')
      || '<tr><td colspan="3">No filters — the whole collection.</td></tr>';

    const w = $('warn'); const bits = [];
    if (!S.canPaginate) bits.push(`<b>Your Crunchbase plan does not allow pagination</b>, so only the first
      ${PAGE} of ${nf.format(S.total)} records can be exported. The rest needs Crunchbase Pro.`);
    else if (S.total > CAP) bits.push(`Crunchbase stops paginating at <b>${nf.format(CAP)}</b> rows per sort order.
      Running the sort in reverse reaches about <b>${nf.format(S.reach)}</b> of ${nf.format(S.total)}.
      For the rest, split the search into narrower filters.`);
    if (S.dropped.length) bits.push(`Your plan can't export: <b>${S.dropped.map(esc).join(', ')}</b> — left out.`);
    w.innerHTML = bits.join('<br><br>');
    w.classList.toggle('hidden', !bits.length);
    w.classList.toggle('bad', !S.canPaginate);

    $('range').max = S.reach; $('range').value = S.reach;
    $('amount').max = S.reach; $('amount').value = S.reach;
    updateEta(); say(''); show(2);
  } catch (e) { say(e.message, true); }
  finally { $('check').disabled = false; }
});

const clamp = v => Math.max(1, Math.min(+$('range').max, Number(v)||1));
function updateEta(){
  const n = clamp($('amount').value);
  const s = Math.ceil(n/PAGE) * (PAGE >= 100 ? 2.2 : 0.8);
  $('eta').textContent = `${nf.format(n)} of ${nf.format(S.total)} records · ${PAGE} per request · roughly ` +
    (s<60 ? Math.max(3,Math.round(s))+' seconds' : Math.round(s/60)+' minutes') + '.';
}
$('range').addEventListener('input', ()=>{ $('amount').value = $('range').value; updateEta(); });
$('amount').addEventListener('input', ()=>{ $('range').value = clamp($('amount').value); updateEta(); });
$('all').addEventListener('click', ()=>{ $('amount').value = $('range').max; $('range').value = $('range').max; updateEta(); });
$('back').addEventListener('click', ()=>show(1));
$('again').addEventListener('click', ()=>show(1));
$('stop').addEventListener('click', ()=>{ S.stop = true; });

/* ---------------- step 3 ---------------- */
$('start').addEventListener('click', async () => {
  const want = clamp($('amount').value);
  Object.assign(S, { rows:[], cols:[], stop:false, t0:Date.now() });
  $('thead').innerHTML=''; $('tbody').innerHTML=''; $('preview').textContent='';
  $('download').disabled = true; $('err').classList.add('hidden');
  $('again').classList.add('hidden'); $('stop').classList.remove('hidden');
  $('fill').style.width='0%'; document.querySelector('.bar').classList.remove('done');
  $('title').textContent='Scraping…'; $('subtitle').textContent='Rows appear below as they arrive.';
  $('got').textContent='0'; $('want').textContent=nf.format(want); $('rate').textContent='';
  show(3);

  const seen = new Set(); let got = 0;
  async function sweep(ord){
    let after = null;
    while (got < want && !S.stop) {
      const b = { field_ids:S.fields, order:ord, query:S.def.query, limit:Math.min(PAGE, want-got) };
      if (after) b.after_id = after;
      let j;
      try { j = await search(S.coll, b); }
      catch (err) { if (/paginate/i.test(err.message||'') || after) return; throw err; }
      const ents = j.entities || [];
      if (!ents.length) return;
      after = ents[ents.length-1].uuid;
      const fresh = ents.filter(e => !seen.has(e.uuid));
      fresh.forEach(e => seen.add(e.uuid));
      if (fresh.length) {
        const rows = fresh.map(flat);
        rows.forEach(r => Object.keys(r).forEach(k => { if (!S.cols.includes(k)) S.cols.push(k); }));
        S.cols = orderCols(S.cols);
        S.rows.push(...rows); got += rows.length;
        paint(rows);
        $('fill').style.width = Math.min(100, Math.round(100*got/want)) + '%';
        $('got').textContent = nf.format(got);
        const secs = (Date.now()-S.t0)/1000;
        if (secs > 1) $('rate').textContent = ` · ${Math.round(got/secs)} rows/sec`;
      }
      if (ents.length < b.limit) return;
      await sleep(PAGE >= 100 ? 600 : 200);
    }
  }
  function paint(rows){
    const th = $('thead'), tb = $('tbody');
    if (th.querySelectorAll('th').length !== S.cols.length)
      th.innerHTML = '<tr>' + S.cols.map(c=>`<th>${esc(c)}</th>`).join('') + '</tr>';
    if (tb.children.length >= 200) {
      $('preview').textContent = `Showing the first 200 of ${nf.format(S.rows.length)} rows — the CSV has all of them.`;
      return;
    }
    tb.insertAdjacentHTML('beforeend', rows.slice(0, 200-tb.children.length).map(r =>
      '<tr>' + S.cols.map(c=>`<td title="${esc(r[c]??'')}">${esc(r[c]??'')}</td>`).join('') + '</tr>').join(''));
  }

  try {
    await sweep(S.def.order);
    if (got < want && !S.stop && S.canPaginate && got >= CAP - PAGE) await sweep(flip(S.def.order));
    $('title').textContent = S.stop ? 'Stopped' : 'Done';
    if (!S.stop) $('fill').style.width = '100%';
    document.querySelector('.bar').classList.add('done');
  } catch (e) {
    $('err').innerHTML = esc(e.message) + (S.rows.length ? ' <b>Rows already retrieved are still downloadable.</b>' : '');
    $('err').classList.remove('hidden');
    $('title').textContent = 'Failed';
  }
  $('subtitle').textContent = `${nf.format(S.rows.length)} records · ${S.cols.length} columns · ` +
    `${Math.max(1,Math.round((Date.now()-S.t0)/1000))}s`;
  $('stop').classList.add('hidden'); $('again').classList.remove('hidden');
  $('download').disabled = S.rows.length === 0;
});

$('download').addEventListener('click', () => {
  const csv = [S.cols.join(',')].concat(S.rows.map(r => S.cols.map(c => q(r[c])).join(','))).join('\n');
  const url = URL.createObjectURL(new Blob(['﻿'+csv], {type:'text/csv;charset=utf-8'}));
  const a = Object.assign(document.createElement('a'), { href:url, download:`crunchbase-${S.rows.length}-rows.csv` });
  document.body.appendChild(a); a.click(); a.remove();
  setTimeout(()=>URL.revokeObjectURL(url), 3000);
});
