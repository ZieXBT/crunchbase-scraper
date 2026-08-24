'use strict';
/* Preload that replaces global.fetch with a fake Crunchbase.
 * Used only by `npm run demo` / the test harness so the whole flow — pagination,
 * the 10k window cap, dedupe, flattening, SSE — can be exercised without a real cookie.
 *   node --require ./test/fake-crunchbase.js server.js
 */
const TOTAL = Number(process.env.FAKE_TOTAL || 12500);   // > 10k to exercise the reverse sweep
const CAP   = 10000;

const DEF = {
  collection_id: 'principal.investors',
  field_ids: ['identifier','num_investments_funding_rounds','location_identifiers',
              'investor_type','website','short_description','funding_total'],
  order: [{ field_id: 'num_investments_funding_rounds', sort: 'desc' }],
  query: [
    { type:'predicate', field_id:'investor_type', operator_id:'includes',
      values:['venture_capital','micro_vc'] },
    { type:'predicate', field_id:'num_investments_funding_rounds', operator_id:'between', values:[10,300] },
    { type:'sub_query', collection_id:'funding_round.participated_in.forward',
      query:[{ type:'predicate', field_id:'investment_type', operator_id:'includes', values:['seed'] }] },
  ],
};

const CITIES = [['London','England','United Kingdom'],['New York','New York','United States'],
                ['Berlin','Berlin','Germany'],['Singapore','Central Region','Singapore']];

function entity(i){
  const c = CITIES[i % CITIES.length];
  return { uuid: `uuid-${i}`, properties: {
    identifier:{ uuid:`uuid-${i}`, value:`Fake Capital ${i}`, permalink:`fake-capital-${i}`,
                 entity_def_id:'organization' },
    num_investments_funding_rounds: 300 - (i % 290),
    location_identifiers:[{value:c[0],location_type:'city'},{value:c[1],location_type:'region'},
                          {value:c[2],location_type:'country'}],
    investor_type: i % 3 ? ['venture_capital'] : ['micro_vc','venture_capital'],
    website:{ value:`https://fake-capital-${i}.example.com` },
    short_description:`Fake Capital ${i} is a seed-stage fund.\n  Multi-line description.`,
    funding_total:{ value: 1000*i, currency:'GBP', value_usd: 1300*i },
  }};
}

/** Deterministic ordering so asc/desc are true mirrors of each other. */
function slice(order, afterId, limit){
  const desc = !order || order[0].sort === 'desc';
  const ids = Array.from({length: TOTAL}, (_, k) => desc ? k : TOTAL - 1 - k);
  let start = 0;
  if (afterId) {
    const idx = ids.indexOf(Number(String(afterId).replace('uuid-','')));
    if (idx < 0) return [];
    start = idx + 1;
  }
  if (start >= CAP) return [];                    // Crunchbase's hard pagination ceiling
  return ids.slice(start, Math.min(start + limit, CAP)).map(entity);
}

global.fetch = async (url, opts = {}) => {
  const u = String(url);
  const ok = body => ({ ok:true, status:200, json: async () => body });

  if (!(opts.headers && opts.headers.cookie))
    return { ok:false, status:403, json: async () => ({}) };

  if (u.includes('/v4/md/searches/')) return ok(DEF);

  if (u.includes('/v4/data/searches/')){
    const b = JSON.parse(opts.body || '{}');
    if (b.limit === 1 && Array.isArray(b.field_ids) && b.field_ids.length === 1)
      return ok({ count: TOTAL, entities: [entity(0)] });
    return ok({ count: TOTAL, entities: slice(b.order, b.after_id, b.limit || 1000) });
  }
  return { ok:false, status:404, json: async () => ({}) };
};
console.log(`[fake-crunchbase] active — ${TOTAL} synthetic records, ${CAP} window cap`);
