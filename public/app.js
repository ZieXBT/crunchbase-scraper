'use strict';
const $ = id => document.getElementById(id);
const nf = new Intl.NumberFormat('en-US');

const state = { cookie:'', url:'', total:0, cap:10000, rows:[], cols:[], abort:null, t0:0, session:null };

function step(n){
  ['s1','s2','s3'].forEach((id,i)=>$(id).classList.toggle('hidden', i !== n-1));
  document.querySelectorAll('.step').forEach(el=>{
    const s = +el.dataset.step;
    el.classList.toggle('is-on', s === n);
    el.classList.toggle('is-done', s < n);
  });
  window.scrollTo({top:0,behavior:'smooth'});
}
function say(el, text, bad, busy){
  el.textContent = text || '';
  el.classList.toggle('bad', !!bad);
  el.classList.toggle('busy', !!busy);
}

/* ---------- step 1: inspect ---------- */
$('check').addEventListener('click', async () => {
  const cookie = $('cookie').value.trim(), url = $('url').value.trim();
  if (!url)    return say($('s1msg'), 'Paste the search URL first.', true);
  if (!cookie) return say($('s1msg'), 'Paste your Crunchbase cookie first.', true);

  $('check').disabled = true;
  say($('s1msg'), 'Asking Crunchbase…', false, true);
  try {
    const r = await fetch('/api/inspect', {
      method:'POST', headers:{'content-type':'application/json'},
      body: JSON.stringify({ cookie, url })
    });
    const d = await r.json();
    if (!r.ok) throw new Error(d.error || 'Could not read that search.');
    if (!d.count) throw new Error('That search matched 0 records. Widen the filters and try again.');

    Object.assign(state, { cookie, url, total:d.count, cap:d.windowCap, session:d.session });
    $('count').textContent = nf.format(d.count);
    $('ncols').textContent = (d.fields || []).length || '—';
    $('coll').textContent  = d.collection;

    $('filters').innerHTML = (d.filters || []).length
      ? d.filters.map(f =>
          `<tr><td>${esc(f.field)}</td><td class="op">${esc(f.op)}</td><td>${esc(f.values)}</td></tr>`).join('')
      : '<tr><td colspan="3">No filters — this search returns the whole collection.</td></tr>';

    // session countdown — Crunchbase authcookies live ~5 minutes
    const sEl = $('sess'), sw = $('sesswarn');
    if (d.session && Number.isFinite(d.session.secondsLeft)) {
      const left = d.session.secondsLeft;
      sEl.textContent = left > 0 ? mmss(left) : 'expired';
      sEl.classList.toggle('warn', left < 120);
      if (left <= 0) {
        sw.classList.remove('hidden');
        sw.innerHTML = `<b>This cookie has expired.</b> Re-export it from Cookie-Editor and paste it again — Crunchbase sessions last about 5 minutes.`;
      } else sw.classList.add('hidden');
      startTicker(d.session.exp);
    } else { sEl.textContent = 'n/a'; sw.classList.add('hidden'); }

    const reach = Math.min(d.count, d.reachable || d.count);
    const w = $('capwarn');
    if (d.count > d.windowCap) {
      w.classList.remove('hidden');
      w.innerHTML = `Crunchbase caps pagination at <b>${nf.format(d.windowCap)}</b> rows per sort order. ` +
        `This scraper runs the sort in reverse to reach the tail, so it can retrieve about ` +
        `<b>${nf.format(reach)}</b> of the ${nf.format(d.count)} matches. ` +
        `To get everything, split the search into narrower filters.`;
    } else w.classList.add('hidden');

    $('range').max = reach; $('range').value = reach;
    $('amount').max = reach; $('amount').value = reach;
    updateEta();
    say($('s1msg'), '');
    step(2);
  } catch (e) {
    say($('s1msg'), e.message, true);
  } finally { $('check').disabled = false; }
});

/* ---------- step 2: amount ---------- */
const mmss = s => `${Math.floor(s/60)}:${String(Math.max(0,s%60)).padStart(2,'0')}`;
let ticker = null;
function startTicker(exp){
  clearInterval(ticker);
  ticker = setInterval(() => {
    const left = exp - Math.floor(Date.now()/1000);
    const el = $('sess');
    el.textContent = left > 0 ? mmss(left) : 'expired';
    el.classList.toggle('warn', left < 120);
    if (left <= 0) clearInterval(ticker);
    updateEta();
  }, 1000);
}

const clamp = v => Math.max(1, Math.min(+$('range').max, Number(v) || 1));
function updateEta(){
  const n = clamp($('amount').value);
  const secs = Math.ceil(n / 1000) * 2.2;
  const human = secs < 60 ? Math.max(3, Math.round(secs)) + ' seconds' : Math.round(secs/60) + ' minutes';
  let txt = `${nf.format(n)} of ${nf.format(state.total)} records · roughly ${human}.`;

  // a scrape that outlives the session will die partway through — say so up front
  if (state.session && Number.isFinite(state.session.exp)) {
    const left = state.session.exp - Math.floor(Date.now()/1000);
    if (left > 0 && secs > left)
      txt += `  ⚠ Longer than the ${mmss(left)} left on your session — it will stop early. ` +
             `Scrape fewer records, or re-export a fresh cookie first.`;
  }
  $('etahint').textContent = txt;
}
$('range').addEventListener('input', () => { $('amount').value = $('range').value; updateEta(); });
$('amount').addEventListener('input', () => { $('range').value = clamp($('amount').value); updateEta(); });
$('amount').addEventListener('blur',  () => { $('amount').value = clamp($('amount').value); updateEta(); });
$('all').addEventListener('click', () => { $('amount').value = $('range').max; $('range').value = $('range').max; updateEta(); });
$('back').addEventListener('click', () => step(1));

/* ---------- step 3: scrape ---------- */
$('start').addEventListener('click', () => {
  const want = clamp($('amount').value);
  state.rows = []; state.cols = []; state.t0 = Date.now();
  $('thead').innerHTML = ''; $('tbody').innerHTML = '';
  $('download').disabled = true;
  $('s3err').classList.add('hidden');
  $('again').classList.add('hidden');
  $('stop').classList.remove('hidden');
  $('fill').style.width = '0%';
  document.querySelector('.bar').classList.remove('done');
  $('runtitle').textContent = 'Scraping…';
  $('runsub').textContent = 'Rows appear below as they arrive.';
  $('got').textContent = '0'; $('want').textContent = nf.format(want); $('rate').textContent = '';
  step(3);
  run(want);
});
$('stop').addEventListener('click', () => { if (state.abort) state.abort.abort(); });
$('again').addEventListener('click', () => step(1));

async function run(want){
  const ac = new AbortController(); state.abort = ac;
  try {
    const res = await fetch('/api/scrape', {
      method:'POST', headers:{'content-type':'application/json'},
      body: JSON.stringify({ cookie: state.cookie, url: state.url, limit: want }),
      signal: ac.signal,
    });
    if (!res.ok || !res.body) throw new Error('Server refused the scrape request.');

    const reader = res.body.getReader(), dec = new TextDecoder();
    let buf = '';
    while (true) {
      const { value, done } = await reader.read();
      if (done) break;
      buf += dec.decode(value, { stream:true });
      const chunks = buf.split('\n\n'); buf = chunks.pop();
      for (const c of chunks) {
        const ev = (c.match(/^event: (.+)$/m) || [])[1];
        const dt = (c.match(/^data: (.+)$/m) || [])[1];
        if (!ev || !dt) continue;
        onEvent(ev, JSON.parse(dt));
      }
    }
    if (!ac.signal.aborted) finish();
  } catch (e) {
    if (ac.signal.aborted) { finish(true); return; }
    fail(e.message);
  }
}

function onEvent(ev, d){
  if (ev === 'rows'){
    if (d.cols && d.cols.length !== state.cols.length){ state.cols = d.cols; renderHead(); }
    state.rows.push(...d.rows);
    appendRows(d.rows);
    const pct = Math.min(100, Math.round(100 * d.got / d.want));
    $('fill').style.width = pct + '%';
    $('got').textContent = nf.format(d.got);
    const secs = (Date.now() - state.t0) / 1000;
    if (secs > 1) $('rate').textContent = ` · ${Math.round(d.got/secs)} rows/sec`;
  } else if (ev === 'fail'){ fail(d.error); }
}

function renderHead(){
  $('thead').innerHTML = '<tr>' + state.cols.map(c => `<th>${esc(c)}</th>`).join('') + '</tr>';
  // re-render existing body so columns stay aligned when new fields appear
  $('tbody').innerHTML = '';
  appendRows(state.rows.slice(0, 200), true);
}
function appendRows(rows, replacing){
  const shown = $('tbody').children.length;
  if (!replacing && shown >= 200){ updatePreview(); return; }
  const slice = rows.slice(0, 200 - (replacing ? 0 : shown));
  const html = slice.map(r => '<tr>' + state.cols.map(c => {
    const v = r[c] ?? '';
    return `<td title="${esc(v)}">${/^https?:\/\//.test(v)
      ? `<a href="${esc(v)}" target="_blank" rel="noopener">${esc(v.replace(/^https?:\/\/(www\.)?/,''))}</a>`
      : esc(v)}</td>`;
  }).join('') + '</tr>').join('');
  $('tbody').insertAdjacentHTML('beforeend', html);
  updatePreview();
}
function updatePreview(){
  $('preview').textContent = state.rows.length > 200
    ? `Showing the first 200 of ${nf.format(state.rows.length)} rows — the CSV contains all of them.` : '';
}

function finish(stopped){
  state.abort = null;
  document.querySelector('.bar').classList.add('done');
  if (!stopped) $('fill').style.width = '100%';
  $('runtitle').textContent = stopped ? 'Stopped' : 'Done';
  $('runsub').textContent = `${nf.format(state.rows.length)} records · ${state.cols.length} columns · ` +
    `${Math.max(1, Math.round((Date.now()-state.t0)/1000))}s`;
  $('stop').classList.add('hidden');
  $('again').classList.remove('hidden');
  $('download').disabled = state.rows.length === 0;
}
function fail(msg){
  state.abort = null;
  const expired = /expired|rejected the cookie|403|401/i.test(msg || '');
  $('s3err').innerHTML = esc(msg || 'Scrape failed.') + (expired && state.rows.length
    ? ' <b>The rows already retrieved are still complete — download them, then re-export a fresh cookie to get the rest.</b>' : '');
  $('s3err').classList.remove('hidden');
  $('runtitle').textContent = 'Failed';
  $('runsub').textContent = 'Any rows already retrieved are still downloadable.';
  $('stop').classList.add('hidden');
  $('again').classList.remove('hidden');
  $('download').disabled = state.rows.length === 0;
}

/* ---------- csv ---------- */
$('download').addEventListener('click', () => {
  const esc2 = v => { const s = v == null ? '' : String(v);
    return /[",\n\r]/.test(s) ? '"' + s.replace(/"/g,'""') + '"' : s; };
  const csv = [state.cols.join(',')]
    .concat(state.rows.map(r => state.cols.map(c => esc2(r[c])).join(','))).join('\n');
  const url = URL.createObjectURL(new Blob(['﻿'+csv], {type:'text/csv;charset=utf-8'}));
  const a = Object.assign(document.createElement('a'),
    { href:url, download:`crunchbase-${state.rows.length}-rows.csv` });
  document.body.appendChild(a); a.click(); a.remove();
  setTimeout(()=>URL.revokeObjectURL(url), 2000);
});

function esc(s){ return String(s ?? '').replace(/[&<>"']/g, c =>
  ({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c])); }
