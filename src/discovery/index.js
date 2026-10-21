import { config, REGIONS, INDUSTRIES, EXCLUDED_DOMAINS } from '../config.js';
import { getDb } from '../db.js';
import { registrableDomain } from '../audit/detect.js';
import * as brave from './brave.js';
import * as serpapi from './serpapi.js';
import * as google from './google.js';

const PROVIDERS = { brave, serpapi, google };
export const PAGES_PER_QUERY = 5;

export function providerStatus() {
  const name = config.discoveryProvider;
  const p = PROVIDERS[name];
  return { name, ready: name === 'domains' || Boolean(p?.isConfigured()) };
}

// Words that describe the search rather than the products. Region is handled by the region chips.
const FILLER = new Set(['website', 'websites', 'site', 'sites', 'store', 'stores', 'shop', 'shops', 'online', 'ecommerce', 'e-commerce',
  'brand', 'brands', 'business', 'businesses', 'company', 'companies', 'woocommerce', 'wordpress', 'in', 'the', 'for', 'of', 'and', 'with', 'from', 'based',
  'us', 'usa', 'america', 'american', 'united', 'states', 'australia', 'australian', 'aus', 'au', 'canada', 'canadian', 'ca']);

/** "Fashion websites in the US" -> "fashion". Falls back to the original text if nothing is left. */
export function normalizeKeyword(keyword) {
  const words = String(keyword).toLowerCase().replace(/[^a-z0-9&' -]+/g, ' ').split(/\s+/).filter(Boolean);
  const kept = words.filter((w) => !FILLER.has(w));
  return (kept.length ? kept : words).join(' ').trim();
}

// Exact-phrase quotes help short product terms but make longer phrases match almost nothing.
const phrase = (term) => (term.split(' ').length <= 3 ? `"${term}"` : term);
const siteFilter = (region) => (region === 'AU' ? ' site:.au' : region === 'CA' ? ' site:.ca' : '');
const defaultInurl = () => PROVIDERS[config.discoveryProvider]?.supportsInurl ?? true;

/**
 * Footprint queries per term and region. Engines with inurl: target WooCommerce's default /product/ permalinks;
 * others (Brave) rely on shop wording that WooCommerce themes print on every product page.
 */
export function buildQueries({ regions = [], keywords = [], industries = [] }, { inurl = defaultInurl() } = {}) {
  const terms = keywords.length
    ? [...new Set(keywords.map(normalizeKeyword).filter(Boolean))].map((k) => ({ term: k, industry: guessIndustry(k, industries) }))
    : industries.flatMap((i) => (INDUSTRIES[i]?.terms || []).map((t) => ({ term: t, industry: i })));
  const out = [];
  for (const { term, industry } of terms) {
    for (const region of regions) {
      const usExclusions = region === 'US' && inurl ? ' -site:.au -site:.ca -site:.uk' : '';
      const variants = inurl
        ? [`${phrase(term)} inurl:product "add to cart"`, `${phrase(term)} "woocommerce"`]
        : [`${phrase(term)} "add to cart"`, `${phrase(term)} online store "add to cart"`];
      for (const v of variants) out.push({ q: `${v}${siteFilter(region)}${usExclusions}`, term, industry, region, group: `${term}|${region}` });
    }
  }
  return out;
}

/** Looser query used when a term's footprint queries find nothing in a region. */
export function fallbackQuery({ term, industry, region, group }) {
  return { q: `${term} online shop${siteFilter(region)}`, term, industry, region, group, fallback: true };
}

export function guessIndustry(text, allowed = Object.keys(INDUSTRIES)) {
  const t = text.toLowerCase();
  let best = null;
  let bestScore = 0;
  for (const id of allowed.length ? allowed : Object.keys(INDUSTRIES)) {
    const ind = INDUSTRIES[id];
    if (!ind) continue;
    const words = [...ind.terms, ...ind.label.toLowerCase().split(/[^a-z]+/)].flatMap((w) => w.split(' ')).filter((w) => w.length > 2);
    const s = words.reduce((n, w) => n + (t.includes(w.replace(/s$/, '')) ? 1 : 0), 0);
    if (s > bestScore) { best = id; bestScore = s; }
  }
  return best || allowed[0] || null;
}

/** Rough count of distinct candidate domains a scan will examine. Calibrated from past scans when available. */
export function estimateScope(params) {
  if (params.domains?.length) return params.domains.length;
  const queries = buildQueries(params).length;
  const past = getDb().prepare(`SELECT progress FROM scans WHERE status = 'done' ORDER BY id DESC LIMIT 20`).all()
    .map((r) => JSON.parse(r.progress)).filter((p) => p.queries > 0 && p.candidates > 0);
  const perQuery = past.length ? past.reduce((s, p) => s + p.candidates / p.queries, 0) / past.length : PAGES_PER_QUERY * 20 * 0.6;
  return Math.round(queries * perQuery);
}

export function cleanDomain(input) {
  try {
    const host = new URL(/^https?:\/\//.test(input) ? input : `https://${input}`).hostname.toLowerCase();
    if (!host.includes('.')) return null;
    // "amazon." matches any TLD; "etsy.com" matches the domain and its subdomains.
    const excluded = EXCLUDED_DOMAINS.some((d) => (d.endsWith('.')
      ? host.startsWith(d) || host.includes(`.${d}`)
      : host === d || host.endsWith(`.${d}`)));
    if (excluded) return null;
    return registrableDomain(host);
  } catch {
    return null;
  }
}

export class DiscoveryError extends Error {}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
let lastCall = 0;

function describe(err) {
  const body = String(err.text || err.message || '').replace(/\s+/g, ' ').slice(0, 200);
  if (err.status === 401 || err.status === 403) return `Search API rejected the key (HTTP ${err.status}). Check ${config.discoveryProvider.toUpperCase()} key in .env. ${body}`;
  if (err.status === 402) return `Search API plan or credits exhausted (HTTP 402). ${body}`;
  if (err.status === 429) return `Search API rate limit hit (HTTP 429) after retries. ${body}`;
  if (err.status === 0) return `Could not reach the search API (${err.error}: ${err.message}).`;
  return `Search API error (HTTP ${err.status}). ${body}`;
}

/** One provider call with pacing and retries. Throws DiscoveryError when the provider can never succeed. */
async function searchWithRetry(provider, q, opts, onError) {
  for (let attempt = 0; attempt < 4; attempt++) {
    const wait = lastCall + config.searchIntervalMs - Date.now();
    if (wait > 0) await sleep(wait);
    lastCall = Date.now();
    const res = await provider.search(q, opts);
    if (!res.error) return res.urls;
    const { status } = res.error;
    if ([401, 402, 403].includes(status)) throw new DiscoveryError(describe(res.error));
    const retryable = status === 429 || status === 0 || status >= 500;
    if (!retryable || attempt === 3) { onError?.(describe(res.error)); return null; }
    await sleep((res.error.retryAfter || 2 ** attempt) * 1000);
  }
  return null;
}

/**
 * Yields candidate domains as { domain, term, industry, region } until the queries are exhausted.
 */
export async function* discover(params, { onQuery, onError, onResults } = {}) {
  const seen = new Set();
  if (params.domains?.length) {
    for (const raw of params.domains) {
      const domain = cleanDomain(raw);
      if (domain && !seen.has(domain)) { seen.add(domain); yield { domain, term: null, industry: null, region: null }; }
    }
    return;
  }
  const provider = PROVIDERS[config.discoveryProvider];
  if (!provider?.isConfigured()) throw new DiscoveryError(`Discovery provider "${config.discoveryProvider}" is not configured. Set an API key in .env or paste domains.`);
  let calls = 0;
  let failures = 0;
  let lastError = null;
  const found = {};
  const run = async function* (query) {
    onQuery?.(query);
    let raw = 0;
    for (let page = 0; page < PAGES_PER_QUERY; page++) {
      calls++;
      const urls = await searchWithRetry(provider, query.q, { region: query.region, gl: REGIONS[query.region]?.gl, page }, (msg) => { failures++; lastError = msg; onError?.(msg); });
      if (!urls) break;
      raw += urls.length;
      for (const url of urls) {
        const domain = cleanDomain(url);
        if (domain && !seen.has(domain)) {
          seen.add(domain);
          found[query.group] = (found[query.group] || 0) + 1;
          yield { domain, ...query };
        }
      }
      if (urls.length < 10) break;
    }
    onResults?.(query, raw);
  };
  const queries = buildQueries(params);
  for (const [i, query] of queries.entries()) {
    yield* run(query);
    // After the last strict query of a term/region, relax the search if it found nothing.
    const lastOfGroup = queries[i + 1]?.group !== query.group;
    if (lastOfGroup && !found[query.group]) yield* run(fallbackQuery(query));
  }
  if (!seen.size && failures) throw new DiscoveryError(`Every search call failed (${failures}/${calls}). Last error: ${lastError}`);
}
