import { test } from 'node:test';
import assert from 'node:assert/strict';
import { score, baselineRevenue, riskLevel } from '../src/audit/scoring.js';

const facts = { domain: 'x.com', industry: 'health-beauty', region: 'US', store: { productCount: 100, medianPrice: 40, currency: 'USD' } };

test('baseline revenue is visits × conversion × order value', () => {
  const { revenue, model } = baselineRevenue(facts);
  assert.equal(model.visits, 8500);
  assert.equal(model.aov, 60);
  assert.equal(revenue, Math.round(8500 * 0.025 * 60));
});

test('foreign prices are converted to USD', () => {
  const aud = baselineRevenue({ ...facts, store: { ...facts.store, currency: 'AUD' } });
  assert.ok(aud.model.aov < 60);
});

test('losses compound and never exceed baseline', () => {
  const findings = [
    { category: 'conversion', severity: 'critical', loss: 0.9, signal: 'broken_checkout', short: 'a' },
    { category: 'security', severity: 'critical', loss: 0.9, signal: 'expired_ssl', short: 'b' },
  ];
  const r = score(findings, facts);
  assert.ok(r.revenueAtRisk <= r.baselineRevenue);
  assert.deepEqual(r.signals.sort(), ['broken_checkout', 'expired_ssl']);
  assert.equal(r.categories.conversion, 25);
  assert.equal(r.categories.seo, 100);
});

test('findings are ranked by revenue and main signal is the top one', () => {
  const r = score([
    { category: 'seo', severity: 'medium', loss: 0.05, short: 'seo' },
    { category: 'conversion', severity: 'critical', loss: 0.35, short: 'checkout' },
  ], facts);
  assert.equal(r.findings[0].short, 'checkout');
  assert.equal(r.mainSignal, 'checkout');
});

test('no findings means full health and no risk', () => {
  const r = score([], facts);
  assert.equal(r.health, 100);
  assert.equal(r.revenueAtRisk, 0);
  assert.equal(riskLevel({ health: r.health, revenue_at_risk: 0 }), 'low');
});

test('critical issues cap overall health', () => {
  const crit = { category: 'conversion', severity: 'critical', loss: 0.35, short: 'c' };
  assert.equal(score([crit], facts).health, 40);
  assert.equal(score([crit, { ...crit, category: 'security' }], facts).health, 30);
  assert.ok(score([{ category: 'seo', severity: 'high', loss: 0.01 }], facts).health <= 65);
  assert.ok(score([crit], { ...facts, status: 'offline' }).health < 10);
});
