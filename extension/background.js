const CB = 'https://www.crunchbase.com';

// Toolbar icon opens the app in a full tab (a popup is too small for a table).
chrome.action.onClicked.addListener(() => {
  chrome.tabs.create({ url: chrome.runtime.getURL('app.html') });
});

/* Self-test: proves the extension can reach the Crunchbase API with the user's
   session. Runs entirely in the service worker, where host_permissions apply. */
chrome.runtime.onMessage.addListener((msg, sender, reply) => {
  if (msg && msg.type === 'selftest') { runSelfTest(msg.url).then(reply); return true; }
});

async function runSelfTest(pageUrl) {
  const r = { signedIn:null, count:null, pageSize:null, fields:null, dropped:[], paginate:null, error:null };
  try {
    const m = String(pageUrl).match(/\/discover\/([^/]+)\/([^/?#]+)/);
    if (!m) throw new Error('run this on a /discover/ search page');
    const coll = m[1], slug = m[2].replace(/#.*$/, '');

    const defRes = await fetch(`${CB}/v4/md/searches/${coll}/${slug}`,
      { credentials:'include', headers:{ accept:'application/json' } });
    r.signedIn = defRes.status !== 401 && defRes.status !== 403;
    if (!defRes.ok) throw new Error('definition HTTP ' + defRes.status);
    const def = await defRes.json();

    const post = body => fetch(`${CB}/v4/data/searches/${coll}?source=slug_advanced_search`,
      { method:'POST', credentials:'include',
        headers:{ 'content-type':'application/json', accept:'application/json' },
        body: JSON.stringify(body) });

    const c = await post({ field_ids:['identifier'], order:def.order, query:def.query, limit:1 });
    if (!c.ok) throw new Error('count HTTP ' + c.status);
    r.count = (await c.json()).count;

    for (const n of [1000, 100, 15]) {
      const t = await post({ field_ids:['identifier'], order:def.order, query:def.query, limit:n });
      if (t.ok) { r.pageSize = n; break; }
      const j = await t.json().catch(()=>[]);
      const mm = /cannot exceed (\d+)/.exec((j[0]&&j[0].message)||'');
      if (mm) { r.pageSize = Number(mm[1]); break; }
    }

    let fields = (def.field_ids||['identifier']).slice();
    for (let i = 0; i < 6; i++) {
      const t = await post({ field_ids:fields, order:def.order, query:def.query, limit:1 });
      if (t.ok) break;
      const j = await t.json().catch(()=>[]);
      const bad = [...new Set((Array.isArray(j)?j:[]).filter(e=>e&&e.field_id).map(e=>e.field_id))];
      if (!bad.length) break;
      r.dropped.push(...bad);
      fields = fields.filter(f => !bad.includes(f));
    }
    r.fields = fields.length;

    const p1 = await post({ field_ids:['identifier'], order:def.order, query:def.query, limit:1 });
    const first = p1.ok ? ((await p1.json()).entities||[])[0] : null;
    if (first) {
      const p2 = await post({ field_ids:['identifier'], order:def.order, query:def.query, limit:1, after_id:first.uuid });
      r.paginate = p2.ok;
    }
  } catch (e) { r.error = String(e && e.message || e); }
  return r;
}
