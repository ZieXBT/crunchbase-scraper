'use strict';
/* Turns Crunchbase's nested entity objects into flat, CSV-friendly rows.
 * Field shapes vary by collection, so this is driven by the value's shape
 * rather than a hard-coded column list. */

const TITLE = s => String(s == null ? '' : s)
  .replace(/_/g, ' ')
  .replace(/\b\w/g, c => c.toUpperCase());

/** Crunchbase location arrays carry city/region/country in one list. */
function locationParts(arr) {
  const pick = t => (arr.find(l => l && l.location_type === t) || {}).value || '';
  return { city: pick('city'), region: pick('region'), country: pick('country') };
}

function scalar(v) {
  if (v == null) return '';
  if (typeof v === 'string' || typeof v === 'number' || typeof v === 'boolean') return String(v);
  if (typeof v === 'object') {
    if ('value_usd' in v && v.value_usd != null) return String(v.value_usd);  // money: prefer USD
    if ('value' in v && typeof v.value !== 'object') return String(v.value);
    if ('value' in v) return scalar(v.value);
  }
  return '';
}

/** Expand one entity into { column: value }. */
function flattenEntity(entity) {
  const p = entity.properties || {};
  const out = { uuid: entity.uuid || '' };

  for (const [key, val] of Object.entries(p)) {
    if (val == null) { out[key] = ''; continue; }

    // identifier -> readable name + a permalink we can turn into a URL
    if (key === 'identifier' && typeof val === 'object' && !Array.isArray(val)) {
      out.name = val.value || '';
      out.crunchbase_url = val.permalink
        ? `https://www.crunchbase.com/${val.entity_def_id || 'organization'}/${val.permalink}` : '';
      continue;
    }

    if (Array.isArray(val)) {
      const objs = val.filter(x => x && typeof x === 'object');
      if (key.includes('location') && objs.some(o => o.location_type)) {
        const { city, region, country } = locationParts(objs);
        out.city = city; out.region = region; out.country = country;
        out[key] = objs.map(o => o.value).filter(Boolean).join(', ');
        continue;
      }
      out[key] = val.map(x => (x && typeof x === 'object')
        ? (x.value || x.name || '')
        : TITLE(x)).filter(Boolean).join(', ');
      continue;
    }

    if (typeof val === 'object') { out[key] = scalar(val); continue; }
    out[key] = typeof val === 'string' && /^[a-z0-9]+(_[a-z0-9]+)+$/.test(val) ? TITLE(val) : String(val);
  }

  // collapse whitespace so descriptions don't break the table or the CSV
  for (const k of Object.keys(out)) out[k] = String(out[k] ?? '').replace(/\s+/g, ' ').trim();
  return out;
}

/** Stable, human-friendly column order: identity first, junk last. */
function orderColumns(cols) {
  const FIRST = ['name', 'crunchbase_url', 'city', 'region', 'country', 'website', 'linkedin'];
  const LAST = ['uuid', 'short_description', 'description'];
  const rest = cols.filter(c => !FIRST.includes(c) && !LAST.includes(c)).sort();
  return [...FIRST.filter(c => cols.includes(c)), ...rest, ...LAST.filter(c => cols.includes(c))];
}

const esc = v => {
  const s = v == null ? '' : String(v);
  return /[",\n\r]/.test(s) ? '"' + s.replace(/"/g, '""') + '"' : s;
};

function toCsv(rows, cols) {
  return [cols.join(','), ...rows.map(r => cols.map(c => esc(r[c])).join(','))].join('\n');
}

module.exports = { flattenEntity, orderColumns, toCsv };
