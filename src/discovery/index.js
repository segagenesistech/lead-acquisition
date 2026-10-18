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

/** Footprint queries: WooCommerce's default /product/ permalink plus an add-to-cart button, per term and region. */
export function buildQueries({ regions = [], keywords = [], industries = [] }) {
  const terms = keywords.length
    ? keywords.map((k) => ({ term: k, industry: guessIndustry(k, industries) }))
    : industries.flatMap((i) => (INDUSTRIES[i]?.terms || []).map((t) => ({ term: t, industry: i })));
  const out = [];
  for (const { term, industry } of terms) {
    for (const region of regions) {
      const geo = region === 'AU' ? ' site:.au' : region === 'CA' ? ' site:.ca' : ' -site:.au -site:.ca -site:.uk';
      out.push({ q: `"${term}" inurl:product "add to cart"${geo}`, term, industry, region });
      out.push({ q: `"${term}" "woocommerce"${geo}`, term, industry, region });
    }
  }
  return out;
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

/**
 * Yields candidate domains as { domain, term, industry, region } until the queries are exhausted.
 */
export async function* discover(params, { onQuery } = {}) {
  const seen = new Set();
  if (params.domains?.length) {
    for (const raw of params.domains) {
      const domain = cleanDomain(raw);
      if (domain && !seen.has(domain)) { seen.add(domain); yield { domain, term: null, industry: null, region: null }; }
    }
    return;
  }
  const provider = PROVIDERS[config.discoveryProvider];
  if (!provider?.isConfigured()) throw new Error(`Discovery provider "${config.discoveryProvider}" is not configured. Set an API key in .env or paste domains.`);
  for (const query of buildQueries(params)) {
    onQuery?.(query);
    for (let page = 0; page < PAGES_PER_QUERY; page++) {
      const { urls } = await provider.search(query.q, { region: query.region, gl: REGIONS[query.region]?.gl, page });
      for (const url of urls) {
        const domain = cleanDomain(url);
        if (domain && !seen.has(domain)) { seen.add(domain); yield { domain, ...query }; }
      }
      if (urls.length < 10) break;
    }
  }
}
