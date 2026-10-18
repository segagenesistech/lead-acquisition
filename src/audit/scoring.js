import { INDUSTRIES, CATEGORIES } from '../config.js';
import { trancoRank } from './tranco.js';

const PENALTY = { critical: 75, high: 45, medium: 22, low: 8 };
const WEIGHTS = { conversion: 0.3, security: 0.25, performance: 0.2, maintenance: 0.15, seo: 0.1 };
const TO_USD = { USD: 1, 'USD?': 1, AUD: 0.66, CAD: 0.73 };
const SEVERITY_ORDER = ['critical', 'high', 'medium', 'low'];

/**
 * Modelled monthly revenue (USD) for a store: estimated visits × industry conversion rate × order value.
 * This is an estimate from public signals, not a measurement.
 */
export function baselineRevenue(facts) {
  const industry = INDUSTRIES[facts.industry] || { conversion: 0.022, aov: 70 };
  const rank = trancoRank(facts.domain);
  const products = facts.store?.productCount || 0;
  const visits = rank
    ? Math.min(2_000_000, Math.round(4e10 / rank))
    : Math.round(2500 + 60 * Math.min(products || 40, 2000));
  const rate = TO_USD[facts.store?.currency] ?? TO_USD[{ AU: 'AUD', CA: 'CAD' }[facts.region]] ?? 1;
  const median = facts.store?.medianPrice ? facts.store.medianPrice * rate : null;
  const aov = median ? Math.min(400, Math.max(20, median * 1.5)) : industry.aov;
  return {
    revenue: Math.round(visits * industry.conversion * aov),
    model: { visits, visitsSource: rank ? 'tranco' : 'catalogue-size', conversion: industry.conversion, aov: Math.round(aov), aovSource: median ? 'catalogue-median' : 'industry' },
  };
}

export function score(findings, facts) {
  const categories = Object.fromEntries(CATEGORIES.map((c) => [c, 100]));
  for (const f of findings) categories[f.category] = Math.max(4, categories[f.category] - PENALTY[f.severity]);
  // Nothing can be measured on a store that is offline.
  if (facts.status === 'offline') for (const c of CATEGORIES) categories[c] = 4;
  // One critical issue makes the whole store unhealthy, however clean the other categories are.
  const criticals = findings.filter((f) => f.severity === 'critical').length;
  const cap = criticals ? Math.max(5, 40 - 10 * (criticals - 1)) : findings.some((f) => f.severity === 'high') ? 65 : 100;
  const health = Math.min(cap, Math.round(CATEGORIES.reduce((s, c) => s + categories[c] * WEIGHTS[c], 0)));

  // Losses compound rather than add, so total risk can never exceed the baseline.
  const { revenue, model } = baselineRevenue(facts);
  const survive = findings.reduce((p, f) => p * (1 - Math.min(1, f.loss || 0)), 1);
  const atRisk = Math.round(revenue * (1 - survive));
  const lossSum = findings.reduce((s, f) => s + (f.loss || 0), 0) || 1;
  const ranked = findings
    .map((f) => ({ ...f, revenue: Math.round((atRisk * (f.loss || 0)) / lossSum / 100) * 100 }))
    .sort((a, b) => b.revenue - a.revenue || SEVERITY_ORDER.indexOf(a.severity) - SEVERITY_ORDER.indexOf(b.severity));
  const signals = [...new Set(ranked.map((f) => f.signal).filter(Boolean))];

  return {
    findings: ranked,
    categories,
    health,
    revenueAtRisk: Math.round(atRisk / 100) * 100,
    baselineRevenue: revenue,
    model,
    signals,
    mainSignal: ranked[0]?.short || null,
  };
}

export function riskLevel(audit) {
  if (audit.health < 45 || audit.revenue_at_risk >= 10000) return 'high';
  if (audit.health < 70 || audit.revenue_at_risk >= 3000) return 'medium';
  return 'low';
}
