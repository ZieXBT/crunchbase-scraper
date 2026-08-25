# Crunchbase Scraper

A Chrome extension that turns any Crunchbase Advanced Search into a CSV.

Paste the search link, pick how many records you want, watch the table fill, download the file.
No API key, no cookie to copy, no third-party service — it runs entirely in your browser using
the Crunchbase session you are already signed into.

```
┌── Paste ──────────┐   ┌── Review ─────────┐   ┌── Export ─────────┐
│ search link       │ → │ record count      │ → │ live table        │
│                   │   │ filters decoded   │   │ download CSV      │
└───────────────────┘   └───────────────────┘   └───────────────────┘
```

---

## Requirements

**You need a Crunchbase Pro account, and you must be signed in while using it.**

Crunchbase gates its export API by plan. This is enforced on their servers — no extension can
work around it:

| | Signed out / Free | **Pro (incl. free trial)** |
|---|---|---|
| Rows per request | 15 | **1,000** |
| Pagination past the first page | ❌ blocked | ✅ allowed |
| `website`, `linkedin`, email, phone fields | ❌ blocked | ✅ included |
| Practical maximum per search | ~15 records | **100,000+ records** |

**Crunchbase offers a 7-day free trial of Pro, and this extension works perfectly on it.**
Start the trial, stay signed in, and you get the full 1,000-rows-per-request behaviour.

If you are signed out or on the free tier, the extension still runs — it detects your plan
and tells you exactly what it can and cannot reach, rather than failing silently. You will
just only get the first page.

---

## Install

This is not on the Chrome Web Store, so you load it as an unpacked extension. Takes about
thirty seconds and you only do it once.

**1. Download it**

👉 **[Download crunchbase-scraper.zip](https://github.com/vatsalngiam/crunchbase-scraper/releases/latest/download/crunchbase-scraper.zip)**

Then **unzip it**. You get a folder called `crunchbase-scraper`.

<sub>Prefer git? `git clone https://github.com/vatsalngiam/crunchbase-scraper.git` — then use the
`extension` folder inside it in step 4.</sub>

**2.** Open **`chrome://extensions`** in Chrome.

**3.** Turn on **Developer mode** — the toggle in the top-right corner.

**4.** Click **Load unpacked** and select the unzipped **`crunchbase-scraper`** folder.

> ⚠️ Select the folder that contains `manifest.json`. If Chrome says
> *"Manifest file is missing or unreadable"*, you picked the wrong level — go one folder in.

**5.** The extension appears in your toolbar. Click the 🧩 puzzle icon and pin it so it is
always visible.

> **Updating:** download the latest ZIP, replace the folder, then press ↻ on the extension's
> card in `chrome://extensions`.

Works in any Chromium browser — Chrome, Edge, Brave, Arc, Opera.

---

## Use

1. Sign in to Crunchbase.
2. Build a search: **Crunchbase → Advanced Search →** apply your filters.
3. Copy the address bar. It looks like:
   ```
   https://www.crunchbase.com/discover/organization.companies/439877ffd921c234cbca0f281143f6ff
   ```
4. Click the extension icon, paste the link, hit **Check**.
5. Confirm the record count and filters, choose how many rows, hit **Start scraping**.
6. **Download CSV** when it finishes.

Any collection works — companies, people, investors, funding rounds, acquisitions.

---

## What you get

The CSV columns follow whichever fields your saved search selected, cleaned up for
spreadsheet use:

- `identifier` split into a readable `name` and a `crunchbase_url`
- Locations split into `city`, `region`, `country`, plus the full location path
- Enum values title-cased (`micro_vc` → `Micro Vc`)
- Money fields resolved to their USD value
- Multi-line descriptions collapsed to a single line
- Fully quote-escaped, UTF-8 with a BOM so Excel opens it correctly

Identity columns come first; `uuid` and long descriptions go last.

---

## How many records can it actually pull?

Tested against a live 2.17-million-record company search: **111,000 records retrieved over
112 consecutive requests, zero duplicates and zero errors**, and it was still going when the
test was stopped. There is no hard row cap in practice.

What you should expect:

- **1,000 records per request** on Pro.
- **Deep pagination gets slower.** The first few thousand rows come back in seconds. By
  100,000 rows, requests take roughly a minute each — Crunchbase gets slower the deeper the
  cursor goes, not the extension.
- **Rough timing:** ~10,000 rows in a couple of minutes; ~100,000 rows in about two hours,
  running unattended.

For very large pulls, it is usually faster to split the search into narrower filters (by
location, headcount, or founding year) and run each separately, rather than paginating deep
into a single one.

> Some collections do enforce a 10,000-row limit per sort order. When the extension hits
> one, it re-runs the search with the sort reversed and merges on `uuid`, which roughly
> doubles the reachable window. It detects this automatically — you do not need to do
> anything.

---

## Privacy

- Everything runs locally in your browser. There is no server and no analytics.
- Your Crunchbase cookies are never read, copied, or stored. The browser attaches them
  automatically, exactly as it does when you use the Crunchbase website.
- The extension requests access to `https://www.crunchbase.com/*` and nothing else.
- The CSV is built in memory and saved straight to your downloads folder.

---

## How it works

```
extension/
├── manifest.json    MV3 manifest; host permission for crunchbase.com
├── background.js    opens the app tab when the toolbar icon is clicked
├── app.html         the three-step interface
├── app.js           API calls, plan detection, pagination, flattening, CSV
└── icon.png
```

It calls the same internal `v4` endpoints the Crunchbase website itself uses. Because the
code runs inside an extension with host permission, requests carry your session normally —
which is also why an ordinary web page cannot do this (cross-origin requests to Crunchbase
are blocked and cookies are not attached).

Requests are paced deliberately. Pulling tens of thousands of rows takes a few minutes;
going faster risks a rate limit on your account.

---

## Notes

- These are Crunchbase's internal endpoints, not a documented public API. They can change.
- Scrape only what your account can already see, and stay within
  [Crunchbase's Terms of Service](https://www.crunchbase.com/terms).
- Not affiliated with or endorsed by Crunchbase.

[MIT](LICENSE)
