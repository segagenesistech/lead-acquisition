import { test } from 'node:test';
import assert from 'node:assert/strict';
import { fingerprint, pluginVersions, parseThemeStyle, productStructuredData, registrableDomain, versionLag, detectCurrency, countRenderBlocking } from '../src/audit/detect.js';
import { parseRobots, parseWpDate } from '../src/audit/sources.js';
import { countReleasesBehind } from '../src/audit/releases.js';
import { judgeCheckoutPage, regionFor } from '../src/audit/index.js';

const WOO = `<html><head><title>Shop &amp; Co</title>
<meta name="generator" content="WordPress 6.1.1" />
<meta name="generator" content="WooCommerce 7.2.0" />
<link rel='stylesheet' href='https://x.com/wp-content/themes/flatsome-child/style.css?ver=3.0'>
<link rel='stylesheet' href='https://x.com/wp-content/themes/flatsome/assets/css/flatsome.css?ver=3.15.4'>
<link rel='stylesheet' href='https://x.com/wp-content/themes/flatsome/assets/css/other.css?ver=3.15.4'>
<script src='https://x.com/wp-content/plugins/contact-form-7/includes/js/index.js?ver=5.6.4'></script>
<script src='https://x.com/wp-content/plugins/contact-form-7/includes/js/other.js?ver=5.6.4'></script>
<script defer src='https://x.com/wp-content/plugins/elementor/a.js?foo=1&amp;ver=3.8.1'></script>
</head><body class="woocommerce-page">
<span class="woocommerce-Price-currencySymbol">A&#36;</span></body></html>`;

test('fingerprints WordPress, WooCommerce, versions, plugins and themes', () => {
  const fp = fingerprint(WOO);
  assert.equal(fp.isWordPress, true);
  assert.equal(fp.isWooCommerce, true);
  assert.equal(fp.wpVersion, '6.1.1');
  assert.equal(fp.wcVersion, '7.2.0');
  assert.equal(fp.title, 'Shop & Co');
  assert.deepEqual(fp.themes, ['flatsome', 'flatsome-child']);
  assert.equal(fp.plugins['contact-form-7'], '5.6.4');
  assert.equal(fp.plugins.elementor, '3.8.1');
  assert.equal(fp.currency, 'AUD');
});

test('plain WordPress is not WooCommerce; non-WordPress is neither', () => {
  assert.equal(fingerprint('<link href="/wp-content/themes/twentytwenty/style.css">').isWooCommerce, false);
  assert.equal(fingerprint('<div class="woocommerce">fake</div>').isWooCommerce, false);
});

test('falls back to asset versions when generator tags are stripped', () => {
  const html = `<link href="/wp-includes/css/dist/block-library/style.min.css?ver=6.4.2">
    <link href="/wp-content/plugins/woocommerce/assets/css/woocommerce.css?ver=8.4.0">`;
  const fp = fingerprint(html);
  assert.equal(fp.wpVersion, '6.4.2');
  assert.equal(fp.wcVersion, '8.4.0');
});

test('detects fatal errors and parked pages', () => {
  assert.equal(fingerprint('<p>There has been a critical error on this website.</p>').criticalError, true);
  assert.equal(fingerprint('<h1>This domain is for sale!</h1>').parked, true);
});

test('pluginVersions records versionless plugins', () => {
  assert.deepEqual(pluginVersions('<img src="/wp-content/plugins/jetpack/x.png">'), { jetpack: null });
});

test('parses theme style.css header', () => {
  const t = parseThemeStyle('/*\nTheme Name: Flatsome Child\nTemplate: flatsome\nVersion: 3.0\n*/');
  assert.deepEqual(t, { name: 'Flatsome Child', version: '3.0', template: 'flatsome', author: null });
});

test('product structured data', () => {
  const ok = '<script type="application/ld+json">{"@graph":[{"@type":"Product","offers":{"@type":"AggregateOffer","offers":[{"price":"9","availability":"InStock"}]}}]}</script>';
  assert.deepEqual(productStructuredData(ok), { hasProduct: true, hasPrice: true, hasAvailability: true });
  assert.equal(productStructuredData('<script type="application/ld+json">{"@type":"Product"}</script>').hasPrice, false);
  assert.equal(productStructuredData('<script type="application/ld+json">{broken</script>').hasProduct, false);
});

test('registrable domains handle two-level suffixes', () => {
  assert.equal(registrableDomain('shop.example.com.au'), 'example.com.au');
  assert.equal(registrableDomain('www.example.ca'), 'example.ca');
  assert.equal(registrableDomain('a.b.example.com'), 'example.com');
});

test('version lag', () => {
  assert.deepEqual(versionLag('6.1.0', '9.3.1'), { major: 3, minor: null, behind: true });
  assert.equal(versionLag('9.3.1', '9.3.1').behind, false);
  assert.equal(versionLag(null, '1.0'), null);
});

test('counts feature releases behind', () => {
  assert.equal(countReleasesBehind(['8.0.0', '8.0.1', '8.1.0', '8.2.0', '9.0.0'], '8.0.3'), 3);
  assert.equal(countReleasesBehind(['8.0.0'], '8.0.0'), 0);
});

test('currency detection', () => {
  assert.equal(detectCurrency('<meta property="product:price:currency" content="CAD">'), 'CAD');
  assert.equal(detectCurrency('<span class="woocommerce-Price-currencySymbol">$</span>'), 'USD?');
});

test('region from TLD, then currency, then hint', () => {
  assert.equal(regionFor('shop.com.au', null, 'US'), 'AU');
  assert.equal(regionFor('shop.ca', 'USD', 'US'), 'CA');
  assert.equal(regionFor('shop.com', 'AUD', 'US'), 'AU');
  assert.equal(regionFor('shop.com', 'USD?', 'CA'), 'CA');
  assert.equal(regionFor('shop.com', 'USD', 'CA'), 'US');
  assert.equal(regionFor('shop.com', null, null), null);
});

test('render-blocking count ignores async/defer and body scripts', () => {
  const r = countRenderBlocking('<head><script src="a.js"></script><script defer src="b.js"></script><link rel="stylesheet" href="c.css"></head><script src="d.js"></script>');
  assert.deepEqual(r, { scripts: 1, styles: 1 });
});

test('robots.txt rules', () => {
  const allowed = parseRobots('User-agent: *\nDisallow: /checkout/\nAllow: /checkout/ok\n\nUser-agent: BadBot\nDisallow: /', 'leadforgebot');
  assert.equal(allowed('/checkout/'), false);
  assert.equal(allowed('/checkout/ok'), true);
  assert.equal(allowed('/product/x'), true);
  assert.equal(parseRobots('User-agent: LeadforgeBot\nDisallow: /', 'leadforgebot')('/x'), false);
});

test('checkout page verdicts', () => {
  const page = (status, body, path = '/checkout/') => ({ status, body, finalUrl: `https://s.com${path}` });
  assert.equal(judgeCheckoutPage(page(500, '')).verdict, 'broken');
  assert.equal(judgeCheckoutPage(page(200, '<form class="woocommerce-checkout">')).verdict, 'ok');
  assert.equal(judgeCheckoutPage(page(200, 'Sorry, it seems that there are no available payment methods')).verdict, 'broken');
  assert.equal(judgeCheckoutPage(page(200, '<p>cart</p>', '/cart/')).verdict, 'inconclusive');
  assert.equal(judgeCheckoutPage(null).verdict, 'inconclusive');
});

test('parses wordpress.org dates', () => {
  assert.equal(parseWpDate('2025-10-01 3:05pm GMT'), '2025-10-01T15:05:00.000Z');
  assert.equal(parseWpDate('2025-10-01 12:00am GMT'), '2025-10-01T00:00:00.000Z');
  assert.equal(parseWpDate('2021-03-01'), '2021-03-01T00:00:00.000Z');
  assert.equal(parseWpDate('garbage'), null);
});
