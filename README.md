# Crunchbase Scraper

Pull any Crunchbase Advanced Search into a clean CSV. One line in your browser console —
no install, no API key, nothing to sign up for, no cookie to paste.

You see how many records matched, choose how many you want, watch the table fill in real
time, and download the file.

## Use it

Open your search on Crunchbase while signed in, press <kbd>F12</kbd> → **Console**, paste:

```js
fetch('https://raw.githubusercontent.com/ZieXBT/crunchbase-scraper/main/scraper.js').then(r=>r.text()).then(eval)
```

That's it. A panel opens over the page, pre-filled with the search you are on. You can
also paste a different Crunchbase search URL into the **Search URL** box and hit Load.

```
┌── Review ─────────┐   ┌── Choose ─────────┐   ┌── Export ─────────┐
│ 412 records       │ → │ how many rows     │ → │ live table        │
│ filters decoded   │   │ (all by default)  │   │ download CSV      │
└───────────────────┘   └───────────────────┘   └───────────────────┘
```

Prefer a button? Make a bookmark with that same line prefixed by `javascript:` as the URL,
and it becomes one click on any Crunchbase page.

### Try it without an account

[`index.html`](index.html) is a self-contained demo: 1,250 made-up records, no Crunchbase
call, no login. Open it directly, or serve the folder and visit the root:

```bash
python3 -m http.server 4310 --directory . 
```

Same interface as the real thing, including the CSV download.

## Getting your search URL

Crunchbase → **Advanced Search** → build your filters → the address bar looks like:

```
https://www.crunchbase.com/discover/organization.companies/439877ffd921c234cbca0f281143f6ff
```

Any collection works — companies, people, funding rounds, investors, acquisitions. Just run
the snippet while that page is open.

## Why it runs in the browser

Crunchbase sits behind Cloudflare bot protection that fingerprints the TLS handshake. A
local script or server — Node, Python, curl — gets a `403` challenge no matter how good its
cookie or headers are. Running inside the page means your browser makes the request: right
fingerprint, your own live session, nothing to copy around and nothing to expire.

It also means your credentials never leave your browser. There is no server here to send
them to.

## What you get

Columns follow whatever fields your saved search selected, tidied for spreadsheet use:

- `identifier` split into a readable `name` plus a `crunchbase_url`
- locations split into `city`, `region`, `country`, plus the full path
- enum values title-cased (`micro_vc` → `Micro Vc`)
- money fields resolved to their USD value
- multi-line descriptions collapsed to one line
- quote-escaped, UTF-8 with a BOM so Excel opens it correctly

Identity columns first, `uuid` and long descriptions last.

## It adapts to your account

Crunchbase gates the export path by plan, so the scraper probes what yours allows and tells
you up front rather than failing halfway:

| | Signed out / free | Crunchbase Pro |
|---|---|---|
| Rows per request | 15 | 1,000 |
| Pagination past page 1 | not allowed | allowed |
| website, linkedin, email, phone | not allowed | allowed |

If a field is gated it is dropped from the request and named on the review screen. If
pagination is blocked, you are told before you start that only the first page is reachable.

**Signed out is the common gotcha** — an anonymous session looks like a broken scraper.
If numbers seem capped, check you are actually logged in.

## The 10,000-record ceiling

Crunchbase stops paginating any single sort order at 10,000 rows, even when more match. The
scraper detects that and re-runs the search with the sort reversed, merging on `uuid`, which
reaches roughly 20,000 records on one search.

Past that the tail is genuinely unreachable, and the review screen says so rather than
handing you a short file that looks complete. Split the search into narrower filters — by
location, headcount, or founding year — and run each.

## Notes

- Uses Crunchbase's internal `v4` endpoints, the same ones the site calls in your browser.
  They are not a documented public API and can change.
- Requests are paced deliberately. Pulling tens of thousands of rows takes a few minutes;
  going faster risks a rate limit on your account.
- Scrape what your account can already see, and stay within Crunchbase's terms.

MIT.
