// Full pipeline against local mock stores: discovery (domain list) → prescreen → audit → leads → CSV.
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { startMocks } from './fixtures/mockstore.js';

const root = fileURLToPath(new URL('..', import.meta.url));
let mocks;
const apps = [];
let base;

async function startApp(extraEnv = {}) {
  const app = spawn(process.execPath, ['--disable-warning=ExperimentalWarning', 'src/server.js'], {
    cwd: root, env: { ...process.env, ...mocks.env, PORT: '0', DB_PATH: ':memory:', HTTPS_PROXY: '', https_proxy: '', SEARCH_MIN_INTERVAL_MS: '0', ...extraEnv }, stdio: ['ignore', 'pipe', 'inherit'],
  });
  apps.push(app);
  const port = await new Promise((resolve) => app.stdout.on('data', (d) => {
    const m = d.toString().match(/running at http:\/\/localhost:(\d+)/);
    if (m) resolve(m[1]);
  }));
  return `http://127.0.0.1:${port}`;
}

async function runSearch(url, body) {
  const res = await fetch(url + '/api/searches', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) });
  const search = await res.json();
  assert.equal(res.status, 200, JSON.stringify(search));
  let s;
  for (let i = 0; i < 300; i++) {
    s = await (await fetch(`${url}/api/searches/${search.id}`)).json();
    if (['done', 'failed'].includes(s.scan.status)) break;
    await new Promise((r) => setTimeout(r, 300));
  }
  return s;
}

before(async () => {
  mocks = await startMocks();
  base = await startApp();
});
after(() => { apps.forEach((a) => a.kill()); mocks?.close(); });

const get = async (p) => (await fetch(base + p)).json();

test('scans a domain list end to end', { timeout: 120000 }, async () => {
  const domains = ['lunaroots.test', 'outbackherbals.test', 'maplebloom.test', 'pawfect.test', 'driftwood.test', 'kookaburra.test', 'healthy.test', 'notwoo.test', 'deadstore.test', 'blockedstore.test', 'stripped.test'];
  const s = await runSearch(base, { domains, regions: ['US', 'AU', 'CA'], industries: ['health-beauty', 'supplements', 'pet-supplies', 'food-drink'], signals: ['expired_ssl', 'domain_expiring', 'outdated_woo', 'broken_checkout', 'slow_mobile', 'abandoned_theme'] });
  const search = { id: s.id };
  assert.equal(s.scan.status, 'done', s.scan.error);
  assert.equal(s.scan.progress.checked, 11);
  assert.equal(s.scan.progress.woocommerce, 9, 'notwoo.test and blockedstore.test are excluded');
  assert.deepEqual(s.scan.progress.skipped, { 'no-woocommerce': 1, blocked: 1 });

  const log = await get(`/api/scans/${s.scan.id}/candidates`);
  const outcome = Object.fromEntries(log.candidates.map((c) => [c.domain, c]));
  assert.equal(outcome['blockedstore.test'].outcome, 'blocked', 'a live but firewalled store is not reported as offline');
  assert.match(outcome['blockedstore.test'].reason, /403/);
  assert.equal(outcome['notwoo.test'].outcome, 'no-woocommerce');
  assert.equal(outcome['stripped.test'].outcome, 'qualified');
  assert.equal(outcome['healthy.test'].outcome, 'healthy');

  const leads = await get(`/api/searches/${search.id}/leads`);
  const by = Object.fromEntries(leads.map((l) => [l.domain, l]));
  assert.equal(by['healthy.test'], undefined, 'healthy store does not qualify');
  assert.ok(by['lunaroots.test'].signals.includes('broken_checkout'));
  assert.ok(by['lunaroots.test'].signals.includes('expired_ssl'));
  assert.ok(by['lunaroots.test'].signals.includes('outdated_woo'));
  assert.equal(by['outbackherbals.test'].region, 'AU');
  assert.equal(by['maplebloom.test'].region, 'CA');
  assert.ok(by['maplebloom.test'].signals.includes('outdated_woo'));
  assert.match(by['pawfect.test'].mainSignal, /Domain expires in (8|9) days/);
  assert.ok(by['driftwood.test'].signals.includes('slow_mobile'));
  assert.ok(by['kookaburra.test'].signals.includes('abandoned_theme'));
  assert.ok(by['kookaburra.test'].signals.includes('broken_checkout'), 'no payment methods');
  assert.equal(by['deadstore.test'].status, 'offline');
  assert.ok(leads.every((l, i) => i === 0 || leads[i - 1].revenueAtRisk >= l.revenueAtRisk), 'sorted by revenue at risk');

  const audit = await get(`/api/audits/${by['lunaroots.test'].auditId}`);
  assert.equal(audit.findings[0].category, 'conversion');
  assert.ok(audit.findings.some((f) => f.id === 'no-structured-data'));
  assert.ok(audit.facts.plugins.some((p) => p.slug === 'elementor' && p.outdated));
  assert.equal(audit.facts.checkout.method, 'store-api');

  const au = await get(`/api/searches/${search.id}/leads?region=AU`);
  assert.deepEqual(au.map((l) => l.domain).sort(), ['kookaburra.test', 'outbackherbals.test']);

  const csv = await (await fetch(`${base}/api/searches/${search.id}/leads.csv`)).text();
  assert.match(csv.split('\n')[0], /^domain,region,industry/);
  assert.equal(csv.trim().split('\n').length, leads.length + 1);

  const meta = await get('/api/meta');
  assert.equal(meta.auditsLeft, meta.quota - 9);
});

test('discovers stores through the Brave API, retrying rate limits', { timeout: 120000 }, async () => {
  const url = await startApp({ DISCOVERY_PROVIDER: 'brave', BRAVE_API_KEY: 'good-key' });
  const s = await runSearch(url, { regions: ['US'], keywords: ['organic skincare'], industries: ['health-beauty'], signals: ['broken_checkout', 'expired_ssl'] });
  assert.equal(s.scan.status, 'done', s.scan.error);
  assert.equal(s.scan.progress.searchErrors, 0);
  assert.equal(s.scan.progress.candidates, 2, 'amazon.com is excluded');
  const leads = await (await fetch(`${url}/api/searches/${s.id}/leads`)).json();
  assert.deepEqual(leads.map((l) => l.domain), ['lunaroots.test']);
});

test('a rejected search API key fails the scan with a clear message', { timeout: 60000 }, async () => {
  const url = await startApp({ DISCOVERY_PROVIDER: 'brave', BRAVE_API_KEY: 'bad-key' });
  const s = await runSearch(url, { regions: ['US'], keywords: ['organic skincare'], industries: [], signals: [] });
  assert.equal(s.scan.status, 'failed');
  assert.match(s.scan.error, /rejected the key \(HTTP 401\).*SUBSCRIPTION_TOKEN_INVALID/);
});

test('falls back to a looser search when strict queries find nothing', { timeout: 120000 }, async () => {
  const url = await startApp({ DISCOVERY_PROVIDER: 'brave', BRAVE_API_KEY: 'good-key' });
  const s = await runSearch(url, { regions: ['US'], keywords: ['Rare widgets websites in the US'], industries: [], signals: ['broken_checkout'] });
  assert.equal(s.scan.status, 'done', s.scan.error);
  assert.equal(s.scan.progress.queries, 3, 'two strict queries plus one fallback');
  assert.equal(s.scan.progress.emptyQueries.length, 2);
  assert.equal(s.scan.progress.candidates, 2);
});
