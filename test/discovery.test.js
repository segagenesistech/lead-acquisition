import { test } from 'node:test';
import assert from 'node:assert/strict';
process.env.DB_PATH = ':memory:';
const { buildQueries, cleanDomain, guessIndustry, estimateScope } = await import('../src/discovery/index.js');

test('builds region-scoped footprint queries per keyword', () => {
  const q = buildQueries({ regions: ['US', 'AU'], keywords: ['organic skincare'], industries: ['health-beauty'] });
  assert.equal(q.length, 4);
  assert.ok(q.some((x) => x.region === 'AU' && x.q.includes('site:.au')));
  assert.ok(q.every((x) => x.q.includes('"organic skincare"')));
});

test('falls back to industry terms without keywords', () => {
  const q = buildQueries({ regions: ['CA'], keywords: [], industries: ['pet-supplies'] });
  assert.ok(q.length >= 2 && q.every((x) => x.industry === 'pet-supplies'));
});

test('cleans and excludes domains', () => {
  assert.equal(cleanDomain('https://shop.example.com.au/product/x'), 'example.com.au');
  assert.equal(cleanDomain('www.amazon.com.au'), null);
  assert.equal(cleanDomain('https://www.etsy.com/listing/1'), null);
  assert.equal(cleanDomain('notetsy.com'), 'notetsy.com');
  assert.equal(cleanDomain('localhost'), null);
});

test('guesses industry from text', () => {
  assert.equal(guessIndustry('natural dog treats and pet food'), 'pet-supplies');
  assert.equal(guessIndustry('vitamins and protein powder', ['supplements', 'fashion']), 'supplements');
});

test('scope estimate scales with queries', () => {
  const a = estimateScope({ regions: ['US'], keywords: ['a'], industries: [] });
  const b = estimateScope({ regions: ['US', 'AU', 'CA'], keywords: ['a', 'b'], industries: [] });
  assert.equal(b, a * 6);
  assert.equal(estimateScope({ domains: ['a.com', 'b.com'] }), 2);
});

test('queries avoid inurl: for engines that do not support it', () => {
  const q = buildQueries({ regions: ['US'], keywords: ['tea'], industries: [] }, { inurl: false });
  assert.ok(q.length === 2 && q.every((x) => !x.q.includes('inurl:') && !x.q.includes('-site:')));
});
