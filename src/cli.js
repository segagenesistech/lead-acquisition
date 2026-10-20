// Diagnostics from the terminal.
//   npm run check -- example.com            prescreen + full audit of one store
//   npm run search-test -- "organic skincare" AU   one call to the configured search provider
import { config, REGIONS } from './config.js';
import { prescreen, audit } from './audit/index.js';
import * as brave from './discovery/brave.js';
import * as serpapi from './discovery/serpapi.js';
import * as google from './discovery/google.js';
import { buildQueries, cleanDomain } from './discovery/index.js';

const [cmd, ...args] = process.argv.slice(2);

if (cmd === 'check') {
  const domain = cleanDomain(args[0] || '');
  if (!domain) { console.error('Usage: npm run check -- example.com'); process.exit(1); }
  console.log(`Prescreening ${domain}…`);
  const p = await prescreen(domain);
  console.log({ status: p.status, reason: p.reason, region: p.region, origin: p.origin, http: p.home?.status ?? p.home?.error,
    wordpress: p.fingerprint.isWordPress, woocommerce: p.fingerprint.isWooCommerce, detectedVia: p.fingerprint.detectedVia, wcVersion: p.fingerprint.wcVersion });
  if (!['live', 'erroring', 'offline'].includes(p.status)) process.exit(0);
  console.log('Auditing (PageSpeed can take up to a minute)…');
  const r = await audit(p, { industry: null });
  console.log({ health: r.health, revenueAtRisk: r.revenueAtRisk, signals: r.signals, categories: r.categories });
  for (const f of r.findings) console.log(` - [${f.severity}] ${f.title} — ${f.detail}`);
  console.log({ checkout: r.facts.checkout, ssl: r.facts.ssl, domain: r.facts.domain_registration, performance: r.facts.performance, versions: r.facts.versions });
} else if (cmd === 'search-test') {
  const providers = { brave, serpapi, google };
  const provider = providers[config.discoveryProvider];
  const region = (args[1] || 'US').toUpperCase();
  if (!provider) { console.error(`DISCOVERY_PROVIDER="${config.discoveryProvider}" has no search API.`); process.exit(1); }
  if (!provider.isConfigured()) { console.error(`No API key set for ${config.discoveryProvider}. Check .env (is it in the project folder?).`); process.exit(1); }
  const [query] = buildQueries({ regions: [region], keywords: [args[0] || 'organic skincare'] });
  console.log(`${config.discoveryProvider}: ${query.q}`);
  const res = await provider.search(query.q, { gl: REGIONS[region]?.gl, page: 0 });
  if (res.error) { console.error('FAILED', res.error.status, res.error.text || res.error.message); process.exit(1); }
  console.log(`${res.urls.length} results`);
  for (const u of res.urls) console.log(` ${cleanDomain(u) ? ' ' : 'x'} ${u}`);
} else {
  console.log('Commands: check <domain> | search-test "<keyword>" [US|AU|CA]');
}
