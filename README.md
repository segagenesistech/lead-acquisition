# Leadforge

Finds WordPress + WooCommerce stores in the **US, Australia and Canada** that have expired or need a rebuild, ranks them by estimated monthly revenue at risk, and produces a per-store audit you can send to the owner.

Zero dependencies: Node.js ≥ 22.13 (uses built-in `node:sqlite`).

```bash
cp .env.example .env     # add a search API key (see below)
npm start                # http://localhost:4310
npm test                 # unit tests + end-to-end scan against local mock stores
```

## How a scan works

1. **Discover**: for every keyword (or industry term) × region it runs two footprint queries through your search provider: `"organic skincare" inurl:product "add to cart" site:.au` on Google/SerpApi, or `"organic skincare" "add to cart" site:.au` on Brave, which has no `inurl:`. Calls are paced and rate-limit responses are retried. Marketplaces (Amazon, Etsy…) are dropped and results are deduplicated to registrable domains (`shop.x.com.au` → `x.com.au`). You can also skip search and paste your own domain list.
2. **Prescreen** (cheap): fetches the homepage, confirms WordPress + WooCommerce (falling back to `/wp-json/` and `/shop/` when an optimisation plugin hides WooCommerce on the homepage), and assigns a region from the ccTLD (`.com.au`, `.ca`), then the store currency, then the search region. Dead or parked domains are checked against the Wayback Machine, so stores that *used* to run WooCommerce still qualify as lapsed leads.
3. **Full audit** (top `AUDITS_PER_SCAN`, within the `MONTHLY_AUDIT_QUOTA`), most promising first. An audit less than 7 days old is reused and does not use quota.
4. **Qualify**: a store becomes a lead if it shows at least one of the rebuild signals you ticked.

## What each signal checks

| Signal | Source | Fires when |
|---|---|---|
| Expired SSL | Direct TLS handshake | Certificate expired, untrusted or self-signed, expiring within 14 days, or no HTTPS at all |
| Domain expiring | RDAP (`rdap.org`) | Expires within 30 days, has already expired, is in redemption, or is unregistered. Also fires for offline stores |
| Outdated WooCommerce | Generator tag / asset `?ver=` vs wordpress.org | 6 or more feature releases behind. Plugins with known CVEs are listed if `WPSCAN_API_TOKEN` is set |
| Broken checkout | WooCommerce Store API + checkout page | Adds one in-stock product to a cart, then loads checkout. Fires on 5xx, PHP fatal errors, no payment gateways, or a missing checkout page. **It never submits an order or payment**, and it removes the item afterwards |
| Slow mobile speed | Google PageSpeed Insights (mobile) | LCP over 4s (real-user data when available). Falls back to server response time if PSI is unavailable |
| Abandoned theme | Theme `style.css` + wordpress.org | The theme (or a child theme's parent) hasn't been updated in 2+ years |

The audit also reports outdated WordPress core, mixed content, missing product structured data (JSON-LD price/availability) and missing meta descriptions.

## Revenue at risk (a model, not a measurement)

`baseline = monthly visits × industry conversion rate × order value` (in USD; AUD and CAD are converted at fixed rates in `src/audit/scoring.js`)

- **Visits**: taken from the [Tranco](https://tranco-list.eu) rank if you put the list at `data/tranco.csv`. Otherwise it is estimated from catalogue size, which is rough. Adding Tranco, or a paid traffic API, is the biggest accuracy improvement available.
- **Order value**: median catalogue price × 1.5, or the industry default.
- Each finding has a loss fraction (for example, an expired SSL certificate is 30% and a broken checkout is 35%). Losses compound rather than add, so the total never exceeds the baseline, and the total is split across findings in proportion to their losses.

Tune the industry benchmarks in `src/config.js` and the loss fractions in `src/audit/index.js`.

## Configuration (`.env`)

| Key | |
|---|---|
| `DISCOVERY_PROVIDER` | `brave` (default), `serpapi`, `google`, or `domains` (paste-only) |
| `BRAVE_API_KEY` / `SERPAPI_KEY` / `GOOGLE_CSE_KEY` + `GOOGLE_CSE_CX` | One is needed for discovery |
| `PAGESPEED_API_KEY` | Optional; keyless PSI is heavily rate-limited, so a key is recommended for scans of any size |
| `WPSCAN_API_TOKEN` | Optional; adds known-vulnerability checks for outdated plugins |
| `MONTHLY_AUDIT_QUOTA`, `AUDITS_PER_SCAN`, `SCAN_CONCURRENCY` | Limits |
| `CONTACT_EMAIL` | Added to the crawler User-Agent so site owners can contact you |
| `SEARCH_MIN_INTERVAL_MS` | Gap between search API calls (default 1100, which suits Brave's free plan; lower it on paid plans) |

Recurring searches re-run weekly. The scheduler checks every 10 minutes while the server is running.

## Troubleshooting a scan with no leads

Every scan has a **Scan log** (link in the progress panel, on the Leads page, and on Exports) listing each website it found and why it was kept or skipped: blocked by bot protection, unreachable, not WordPress, WordPress without WooCommerce, outside your regions, or audited with no rebuild signal. Search API failures (bad key, rate limit, credits used up) are shown there too and fail the scan with the provider's message.

Two terminal checks:

```bash
npm run search-test -- "organic skincare" AU   # is the search key working, and what does it return?
npm run check -- example.com.au                 # what does the prescreen + audit see for one store?
```

## Crawling etiquette and outreach law

- The crawler identifies itself as `LeadforgeBot`, honours `robots.txt` for every path it fetches, and makes only about 10–15 requests per store.
- Contacting these leads is regulated: **CAN-SPAM** (US), the **Spam Act 2003** (AU) and **CASL** (Canada, which requires consent, including implied consent). Check your outreach process against all three. CASL is the strictest.

## Project layout

```
src/server.js            HTTP API + static UI
src/scanner.js           scan pipeline, quota, recurring scheduler
src/discovery/           search providers + query builder
src/audit/index.js       prescreen + full audit (all checks)
src/audit/detect.js      pure HTML fingerprinting
src/audit/sources.js     wordpress.org, RDAP, PageSpeed, Wayback, WPScan, robots.txt
src/audit/scoring.js     health scores + revenue model
public/                  UI (vanilla JS; desktop and mobile layouts)
test/fixtures/mockstore.js  local fake stores + APIs (`node test/fixtures/mockstore.js`)
```

API: `GET /api/meta`, `POST /api/estimate`, `GET|POST /api/searches`, `GET|PATCH|DELETE /api/searches/:id`, `POST /api/searches/:id/run`, `GET /api/searches/:id/leads[.csv]?region=&signal=&risk=`, `GET /api/audits`, `GET /api/audits/:id`.
