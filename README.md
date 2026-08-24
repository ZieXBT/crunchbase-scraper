# Crunchbase Scraper

Pull any Crunchbase Advanced Search into a clean CSV. Paste your search URL and your
cookie, see how many records matched, choose how many you want, and watch the table
fill up in real time.

Runs entirely on your own machine against your own Crunchbase session. No account to
create, no API key, no data sent to a third party.

```
┌── 1 Connect ──────┐   ┌── 2 Review ───────┐   ┌── 3 Export ───────┐
│ search URL        │ → │ 12,500 records    │ → │ live table        │
│ cookie            │   │ filters decoded   │   │ progress + CSV    │
└───────────────────┘   └───────────────────┘   └───────────────────┘
```

## Run it

Needs Node 18 or newer. No dependencies to install.

```bash
git clone https://github.com/ZieXBT/crunchbase-scraper.git
cd crunchbase-scraper
npm start
```

Open <http://localhost:4300>.

Want to see the interface before you hand over a cookie? `npm run demo` boots the same
app against 12,500 synthetic records.

## Getting your cookie

1. Open Crunchbase in Chrome while signed in.
2. `F12` → **Network** tab → reload the page.
3. Click any request to `crunchbase.com`.
4. Under **Request Headers**, copy the whole `cookie:` value and paste it in.

Your cookie is your login. It is held in memory for the duration of the scrape and is
never written to disk or sent anywhere except Crunchbase. Don't paste it into anything
you didn't start yourself, and don't commit it.

## Getting your search URL

Crunchbase → **Advanced Search** → build your filters → copy the address bar. It looks
like:

```
https://www.crunchbase.com/discover/principal.investors/e290f9ecc71c6841b496090ba9a2ac89
```

Any collection works — organizations, people, funding rounds, investors, acquisitions.

## What you get

The CSV columns follow whichever fields your saved search selected, tidied for
spreadsheet use:

- `identifier` is split into a readable `name` plus a `crunchbase_url`
- location arrays are split into `city`, `region`, `country`, plus the full path
- enum values are title-cased (`micro_vc` → `Micro Vc`)
- money fields resolve to their USD value
- multi-line descriptions are collapsed to one line
- everything is quote-escaped, UTF-8 with a BOM so Excel opens it correctly

Identity columns come first, `uuid` and long descriptions last.

## The 10,000-record ceiling

Crunchbase stops paginating any single sort order at 10,000 rows, even when the search
matches more. This scraper detects that and re-runs the search with the sort reversed,
merging on `uuid`, which reaches roughly 20,000 records on a single search.

Above that, the tail is genuinely unreachable and the app tells you so on the review
screen rather than silently handing you a short file. Split the search into narrower
filters — by location, headcount, or founding year — and run each separately.

## How it works

| File | Role |
|---|---|
| `server.js` | Static host + two endpoints: `/api/inspect`, `/api/scrape` (server-sent events) |
| `crunchbase.js` | Talks to Crunchbase's `v4` endpoints: parsing, retries, cursor pagination, the reverse sweep |
| `flatten.js` | Shape-driven flattening of nested entities into CSV columns |
| `public/` | The three-step interface |
| `test/fake-crunchbase.js` | Stubs `fetch` with a synthetic Crunchbase for `npm run demo` |

Rows stream from Crunchbase → server → browser as they arrive, so the table starts
filling within a second or two and the CSV is assembled client-side.

Requests are paced with backoff and retry on 429 and 5xx. Pulling tens of thousands of
records will take a few minutes; that pacing is deliberate.

## Notes

- This uses Crunchbase's internal web endpoints, the same ones the site calls in your
  browser. They aren't a documented public API and can change.
- You're responsible for staying within Crunchbase's terms and your own plan's limits.
- Scrape what your account can already see.

MIT.
