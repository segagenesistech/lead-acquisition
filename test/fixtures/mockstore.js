// Local stand-ins for WooCommerce stores and the third-party APIs an audit calls.
// Used by the end-to-end test and handy for UI work: `node test/fixtures/mockstore.js`.
import http from 'node:http';
import https from 'node:https';
import tls from 'node:tls';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

const here = dirname(fileURLToPath(import.meta.url));
const read = (f) => readFileSync(join(here, f));
const DAY = 86400e3;
const iso = (offsetDays) => new Date(Date.now() + offsetDays * DAY).toISOString();

export const STORES = {
  'lunaroots.test': { title: 'Luna Roots Organic Skincare', currency: 'USD', wc: '6.1.0', wp: '5.9.3', cert: 'expired', checkout: 500, structuredData: false,
    plugins: { 'contact-form-7': '5.1', elementor: '3.0.0' }, theme: 'storefront', products: 64, price: 4200 },
  'outbackherbals.test': { title: 'Outback Herbals | Natural supplements', currency: 'AUD', wc: '9.9.0', wp: '6.8.3', cert: 'expired', plugins: {}, theme: 'storefront', products: 120, price: 3900 },
  'maplebloom.test': { title: 'Maple Bloom natural beauty & skincare', currency: 'CAD', wc: '5.9.0', wp: '6.0', plugins: { 'contact-form-7': '5.0', elementor: '3.1.0', 'yith-woocommerce-wishlist': '2.2.0', 'mailchimp-for-woocommerce': '2.4', 'wordpress-seo': '15.0', 'woocommerce-gateway-stripe': '5.0.0' }, theme: 'storefront', products: 80, price: 3500 },
  'pawfect.test': { title: 'Pawfect Pantry — natural pet supplies', currency: 'USD', wc: '10.1.0', wp: '6.8.3', plugins: {}, theme: 'storefront', products: 200, price: 2900, domainDays: 9 },
  'driftwood.test': { title: 'Driftwood Wellness', currency: 'USD', wc: '10.2.1', wp: '6.8.3', plugins: {}, theme: 'storefront', products: 40, price: 5500, lcp: 6400 },
  'kookaburra.test': { title: 'Kookaburra Tea Co — loose leaf tea', currency: 'AUD', wc: '10.2.1', wp: '6.8.3', plugins: {}, theme: 'kookatheme', products: 30, price: 2400, paymentMethods: [] },
  'healthy.test': { title: 'A healthy skincare store', currency: 'USD', wc: '10.2.1', wp: '6.8.3', plugins: {}, theme: 'storefront', products: 50, price: 3000 },
  'notwoo.test': { title: 'Just a blog', notWoo: true },
};

function homeHtml(s) {
  if (s.notWoo) return `<html><head><title>${s.title}</title><link rel="stylesheet" href="/wp-content/themes/twentytwenty/style.css?ver=1.0"></head><body>blog</body></html>`;
  const plugins = Object.entries(s.plugins).map(([slug, v]) => `<script src="/wp-content/plugins/${slug}/assets/js/main.js?ver=${v}"></script>`).join('\n');
  return `<!doctype html><html><head><title>${s.title}</title>
  <meta name="description" content="${s.title}">
  <meta name="generator" content="WordPress ${s.wp}"><meta name="generator" content="WooCommerce ${s.wc}">
  <meta property="product:price:currency" content="${s.currency}">
  <link rel="stylesheet" href="/wp-content/themes/${s.theme}/style.css?ver=1">
  <link rel="stylesheet" href="/wp-content/plugins/woocommerce/assets/css/woocommerce.css?ver=${s.wc}">
  ${plugins}
  </head><body class="woocommerce-page"><a href="/checkout/">Checkout</a>
  <ul class="products"><li><a href="/product/item-1/" data-product_id="1" class="add_to_cart_button">Add to cart</a>
  <span class="woocommerce-Price-amount amount"><bdi><span class="woocommerce-Price-currencySymbol">$</span>${(s.price / 100).toFixed(2)}</bdi></span></li></ul></body></html>`;
}

function productHtml(s) {
  const ld = s.structuredData === false ? '' : `<script type="application/ld+json">${JSON.stringify({ '@context': 'https://schema.org', '@graph': [{ '@type': 'Product', name: 'Item 1', offers: [{ '@type': 'Offer', price: (s.price / 100).toFixed(2), priceCurrency: s.currency, availability: 'https://schema.org/InStock' }] }] })}</script>`;
  return `<html><head><title>Item 1</title>${ld}</head><body class="woocommerce">Product</body></html>`;
}

function storeHandler(req, res) {
  const host = (req.headers.host || '').split(':')[0].replace(/^www\./, '');
  const s = STORES[host];
  if (!s) { res.writeHead(404); return res.end('unknown host'); }
  const url = new URL(req.url, `http://${host}`);
  const json = (code, body, headers = {}) => { res.writeHead(code, { 'content-type': 'application/json', ...headers }); res.end(JSON.stringify(body)); };
  const html = (code, body) => { res.writeHead(code, { 'content-type': 'text/html' }); res.end(body); };
  const p = url.pathname;
  if (p === '/') return html(200, homeHtml(s));
  if (p === '/robots.txt') return html(200, 'User-agent: *\nDisallow: /wp-admin/\nAllow: /wp-admin/admin-ajax.php\n');
  if (s.notWoo) return html(404, 'not found');
  if (p === '/wp-json/wc/store/v1/products') {
    const products = Array.from({ length: Math.min(20, s.products) }, (_, i) => ({ id: i + 1, type: 'simple', is_purchasable: true, is_in_stock: true,
      permalink: `https://${host}/product/item-${i + 1}/`, prices: { price: String(s.price + i * 100), currency_code: s.currency, currency_minor_unit: 2 } }));
    return json(200, products, { 'x-wp-total': String(s.products) });
  }
  if (p === '/wp-json/wc/store/v1/cart') return json(200, { items: [] }, { nonce: 'abc123', 'cart-token': 'tok' });
  if (p === '/wp-json/wc/store/v1/cart/add-item') {
    if (req.headers.nonce !== 'abc123') return json(401, { code: 'woocommerce_rest_missing_nonce' });
    return json(201, { items: [{ key: 'k1', id: 1 }], needs_payment: true, payment_methods: s.paymentMethods ?? ['stripe'] }, { 'set-cookie': 'wp_woocommerce_session_x=1; path=/' });
  }
  if (p === '/wp-json/wc/store/v1/cart/remove-item') return json(200, { items: [] });
  if (p === '/checkout/') {
    if (s.checkout === 500) return html(500, '<html><body>There has been a critical error on this website.</body></html>');
    return html(200, '<html><body><form class="woocommerce-checkout checkout">…</form></body></html>');
  }
  if (p.startsWith('/product/')) return html(200, productHtml(s));
  if (p.startsWith('/wp-content/themes/')) return html(200, `/*\nTheme Name: ${s.theme}\nVersion: 1.0\n*/`);
  return html(404, 'not found');
}

const WC_VERSIONS = ['5.9.0', '6.0.0', '6.1.0', '6.2.0', '6.3.0', '6.4.0', '6.5.0', '6.6.0', '6.7.0', '6.8.0', '6.9.0', '7.0.0', '7.5.0', '8.0.0', '8.5.0', '9.0.0', '9.5.0', '9.9.0', '10.0.0', '10.1.0', '10.2.0', '10.2.1'];
const PLUGINS = { woocommerce: '10.2.1', 'contact-form-7': '6.1', elementor: '3.32.0', 'yith-woocommerce-wishlist': '4.9.0', 'mailchimp-for-woocommerce': '5.5', 'wordpress-seo': '26.0', 'woocommerce-gateway-stripe': '9.9.0' };
const THEMES = { storefront: '2025-08-01', kookatheme: '2021-03-01' };

function apiHandler(apiBase) {
  return (req, res) => {
    const url = new URL(req.url, 'http://x');
    const json = (code, body) => { res.writeHead(code, { 'content-type': 'application/json' }); res.end(JSON.stringify(body)); };
    const p = url.pathname;
    if (p === '/core/version-check/1.7/') return json(200, { offers: [{ current: '6.8.3' }] });
    if (p === '/plugins/info/1.2/') {
      const slug = url.searchParams.get('request[slug]');
      if (!PLUGINS[slug]) return json(404, { error: 'Plugin not found.' });
      const body = { name: slug, version: PLUGINS[slug], last_updated: '2025-10-01 3:00pm GMT' };
      if (url.searchParams.get('request[fields][versions]')) body.versions = Object.fromEntries((slug === 'woocommerce' ? WC_VERSIONS : [PLUGINS[slug]]).map((v) => [v, '']));
      return json(200, body);
    }
    if (p === '/themes/info/1.2/') {
      const slug = url.searchParams.get('request[slug]');
      return THEMES[slug] ? json(200, { name: slug, version: '1.0', last_updated: THEMES[slug] }) : json(404, { error: 'Theme not found' });
    }
    if (p.startsWith('/domain/')) {
      const d = p.slice(8);
      if (d === 'deadstore.test') return json(404, { errorCode: 404 });
      const days = STORES[d]?.domainDays ?? 300;
      return json(200, { status: ['active'], events: [{ eventAction: 'expiration', eventDate: iso(days) }] });
    }
    if (p === '/pagespeed') {
      const host = new URL(url.searchParams.get('url')).hostname.replace(/^www\./, '');
      const lcp = STORES[host]?.lcp ?? 1900;
      return json(200, { lighthouseResult: { categories: { performance: { score: lcp > 4000 ? 0.31 : 0.88 } }, audits: {
        'largest-contentful-paint': { numericValue: lcp }, 'render-blocking-resources': { details: { items: Array(lcp > 4000 ? 14 : 1).fill({}) } },
        'uses-optimized-images': { details: { items: Array(lcp > 4000 ? 6 : 0).fill({}) } } } } });
    }
    if (p === '/wayback/available') {
      const target = url.searchParams.get('url');
      if (target !== 'deadstore.test') return json(200, { archived_snapshots: {} });
      return json(200, { archived_snapshots: { closest: { available: true, timestamp: '20240301000000', url: `${apiBase}/web/20240301000000/deadstore.test` } } });
    }
    if (p.startsWith('/web/20240301000000id_/')) {
      res.writeHead(200, { 'content-type': 'text/html' });
      return res.end(homeHtml({ ...STORES['healthy.test'], title: 'Dead Store skincare', currency: 'USD' }));
    }
    json(404, { error: 'not found' });
  };
}

export async function startMocks() {
  const listen = (srv) => new Promise((r) => srv.listen(0, '127.0.0.1', () => r(srv.address().port)));
  const contexts = {
    good: tls.createSecureContext({ key: read('good.key'), cert: read('good.pem') }),
    expired: tls.createSecureContext({ key: read('expired.key'), cert: read('expired.pem') }),
  };
  const httpsSrv = https.createServer({ key: read('good.key'), cert: read('good.pem'),
    SNICallback: (name, cb) => cb(null, contexts[STORES[name.replace(/^www\./, '')]?.cert || 'good']) }, storeHandler);
  const httpSrv = http.createServer(storeHandler);
  const apiSrv = http.createServer();
  const [httpsPort, httpPort, apiPort] = [await listen(httpsSrv), await listen(httpSrv), await listen(apiSrv)];
  const apiBase = `http://127.0.0.1:${apiPort}`;
  apiSrv.on('request', apiHandler(apiBase));
  const overrides = {};
  for (const d of Object.keys(STORES)) { overrides[d] = { http: httpPort, https: httpsPort }; overrides[`www.${d}`] = overrides[d]; }
  return {
    env: {
      LEADFORGE_HOST_OVERRIDES: JSON.stringify(overrides),
      NODE_EXTRA_CA_CERTS: join(here, 'ca.pem'),
      WPORG_API: apiBase, RDAP_API: apiBase, PAGESPEED_API: `${apiBase}/pagespeed`, WAYBACK_API: apiBase,
      DISCOVERY_PROVIDER: 'domains',
    },
    close: () => [httpsSrv, httpSrv, apiSrv].forEach((s) => s.close()),
  };
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  const m = await startMocks();
  console.log('Mocks running. Start the app with this environment:\n');
  for (const [k, v] of Object.entries(m.env)) console.log(`${k}='${v}'`);
}
