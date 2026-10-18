// Full pipeline against local mock stores: discovery (domain list) → prescreen → audit → leads → CSV.
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { startMocks } from './fixtures/mockstore.js';

const root = fileURLToPath(new URL('..', import.meta.url));
let mocks, app, base;

before(async () => {
  mocks = await startMocks();
  const port = 4300 + Math.floor(Math.random() * 600);
  base = `http://127.0.0.1:${port}`;
  app = spawn(process.execPath, ['--disable-warning=ExperimentalWarning', 'src/server.js'], {
    cwd: root, env: { ...process.env, ...mocks.env, PORT: String(port), DB_PATH: ':memory:', HTTPS_PROXY: '', https_proxy: '' }, stdio: ['ignore', 'pipe', 'inherit'],
  });
  await new Promise((resolve) => app.stdout.on('data', (d) => d.toString().includes('running') && resolve()));
});
after(() => { app?.kill(); mocks?.close(); });

const get = async (p) => (await fetch(base + p)).json();

test('scans a domain list end to end', { timeout: 120000 }, async () => {
  const domains = ['lunaroots.test', 'outbackherbals.test', 'maplebloom.test', 'pawfect.test', 'driftwood.test', 'kookaburra.test', 'healthy.test', 'notwoo.test', 'deadstore.test'];
  const res = await fetch(base + '/api/searches', { method: 'POST', headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ domains, regions: ['US', 'AU', 'CA'], industries: ['health-beauty', 'supplements', 'pet-supplies', 'food-drink'], signals: ['expired_ssl', 'domain_expiring', 'outdated_woo', 'broken_checkout', 'slow_mobile', 'abandoned_theme'] }) });
  const search = await res.json();
  assert.equal(res.status, 200, JSON.stringify(search));

  let s;
  for (let i = 0; i < 200; i++) {
    s = await get(`/api/searches/${search.id}`);
    if (['done', 'failed'].includes(s.scan.status)) break;
    await new Promise((r) => setTimeout(r, 300));
  }
  assert.equal(s.scan.status, 'done', s.scan.error);
  assert.equal(s.scan.progress.checked, 9);
  assert.equal(s.scan.progress.woocommerce, 8, 'notwoo.test is excluded');

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
  assert.equal(meta.auditsLeft, meta.quota - 8);
});
