import { REGIONS } from '../config.js';
import { request, inspectCertificate, CookieJar } from './http.js';
import { fingerprint, parseThemeStyle, productStructuredData, mixedContent, versionLag, registrableDomain, isParked } from './detect.js';
import { latestWordPress, pluginInfo, themeInfo, pluginVulnerabilities, domainRegistration, pagespeed, waybackSnapshot, robots } from './sources.js';
import { pluginReleasesBehind } from './releases.js';
import { score } from './scoring.js';

const DAY = 86400e3;
const daysBetween = (a, b) => Math.round((new Date(a) - new Date(b)) / DAY);

export function regionFor(domain, currency, hint) {
  for (const [code, r] of Object.entries(REGIONS)) if (r.tlds.some((t) => domain.endsWith(t))) return code;
  if (currency === 'AUD') return 'AU';
  if (currency === 'CAD') return 'CA';
  if (currency === 'USD' || currency === 'USD?') return hint && hint !== 'US' && currency === 'USD?' ? hint : 'US';
  return hint || null;
}

/**
 * Cheap first pass: is this a reachable WordPress + WooCommerce store, and where is it?
 * Dead or parked domains are checked against the Wayback Machine so lapsed stores still qualify.
 */
export async function prescreen(domain, { regionHint } = {}) {
  const attempts = [`https://${domain}/`, `https://www.${domain}/`, `http://${domain}/`];
  let home = null;
  for (const url of attempts) {
    const res = await request(url, { timeout: 15000 });
    if (!res.error && res.status) { home = res; break; }
    home = res;
  }
  const reachable = Boolean(home && !home.error && home.status && home.status < 500);
  const html = home?.body || '';
  const fp = fingerprint(html, home?.headers);
  const base = { domain, home, fingerprint: fp, reachable, ttfb: home?.ttfb ?? null };

  if (reachable && fp.isWooCommerce && !fp.parked) {
    const origin = new URL(home.finalUrl).origin;
    return { ...base, status: 'live', origin, region: regionFor(new URL(origin).hostname, fp.currency, regionHint) };
  }
  if (reachable && !fp.parked && !fp.criticalError && home.status < 400) return { ...base, status: 'not-woocommerce' };

  // Down, erroring, or parked. Was it a WooCommerce store?
  if (fp.criticalError && fp.isWordPress) {
    return { ...base, status: 'erroring', origin: new URL(home.finalUrl).origin, region: regionFor(domain, fp.currency, regionHint) };
  }
  const snap = await waybackSnapshot(domain);
  const past = snap?.html ? fingerprint(snap.html) : null;
  if (past?.isWooCommerce && !isParked(snap.html)) {
    return { ...base, status: 'offline', archived: { timestamp: snap.timestamp, url: snap.url }, fingerprint: { ...past, parked: fp.parked }, region: regionFor(domain, past.currency, regionHint), pastHtml: snap.html };
  }
  return { ...base, status: 'not-woocommerce' };
}

/** Full audit of a prescreened store. Returns { facts, findings, ...score }. */
export async function audit(pre, { industry } = {}) {
  const { domain } = pre;
  const facts = { domain, status: pre.status, region: pre.region, industry, auditedAt: new Date().toISOString(), archived: pre.archived || null };
  const findings = [];
  const add = (f) => findings.push(f);
  const fp = pre.fingerprint;

  // Domain registration (RDAP)
  const reg = await domainRegistration(registrableDomain(domain));
  facts.domain_registration = reg;
  if (reg && reg.registered === false) {
    add({ id: 'domain-lapsed', category: 'security', severity: 'critical', signal: 'domain_expiring', loss: 0.95, short: 'Domain lapsed',
      title: 'Domain registration has lapsed', detail: 'The domain is no longer registered. The store is offline and the name can be re-registered by anyone.' });
  } else if (reg?.inRedemption || reg?.onHold) {
    add({ id: 'domain-redemption', category: 'security', severity: 'critical', signal: 'domain_expiring', loss: 0.9, short: 'Domain in redemption',
      title: 'Domain expired and is in its redemption period', detail: 'DNS has been suspended by the registry; the store is unreachable until it is renewed.' });
  } else if (reg?.expiresAt) {
    const days = daysBetween(reg.expiresAt, Date.now());
    if (days < 0) add({ id: 'domain-expired', category: 'security', severity: 'critical', signal: 'domain_expiring', loss: 0.9, short: `Domain expired ${-days} days ago`,
      title: `Domain expired ${-days} days ago`, detail: `Registration ended ${reg.expiresAt.slice(0, 10)}. The site will go offline when the registrar's grace period ends.` });
    else if (days <= 30) add({ id: 'domain-expiring', category: 'security', severity: days <= 7 ? 'critical' : 'high', signal: 'domain_expiring', loss: days <= 7 ? 0.2 : 0.1,
      short: `Domain expires in ${days} days`, title: `Domain expires in ${days} days`, detail: `Registration ends ${reg.expiresAt.slice(0, 10)} and auto-renew status is unknown.` });
  }

  if (pre.status === 'offline') {
    add({ id: 'site-offline', category: 'conversion', severity: 'critical', signal: 'domain_expiring', loss: 1, short: 'Store offline',
      title: 'Store is offline', detail: `The site no longer responds (${pre.home?.error || 'HTTP ' + pre.home?.status}). The Wayback Machine shows a WooCommerce store here on ${fmtStamp(pre.archived.timestamp)}.` });
    facts.versions = { wordpress: fp.wpVersion, woocommerce: fp.wcVersion };
    facts.store = storeFromHtml(pre.pastHtml);
    return { facts, findings, ...score(findings, facts) };
  }

  const origin = pre.origin;
  const allowed = await robots(origin);
  facts.origin = origin;

  // Site-wide fatal error
  if (fp.criticalError) {
    add({ id: 'critical-error', category: 'conversion', severity: 'critical', signal: 'broken_checkout', loss: 0.85, short: 'Site showing fatal error',
      title: 'Homepage shows a WordPress fatal error', detail: '"There has been a critical error on this website" is shown to every visitor; nothing can be purchased.' });
  }

  // TLS certificate
  const cert = await inspectCertificate(new URL(origin).hostname);
  facts.ssl = cert;
  if (!cert.reachable) {
    add({ id: 'no-https', category: 'security', severity: 'high', signal: 'expired_ssl', loss: 0.12, short: 'No HTTPS',
      title: 'Store does not serve HTTPS', detail: 'Browsers mark every page "Not secure", including checkout.' });
  } else {
    const days = cert.validTo ? daysBetween(cert.validTo, Date.now()) : null;
    if (days !== null && days < 0) {
      add({ id: 'ssl-expired', category: 'security', severity: 'critical', signal: 'expired_ssl', loss: 0.3, short: `SSL expired ${-days} days`,
        title: `SSL certificate expired ${-days} days ago`, detail: 'Browsers show a full-page warning to every visitor.' });
    } else if (cert.error && /SELF_SIGNED|ALTNAME|UNABLE_TO|CERT_UNTRUSTED/i.test(cert.error)) {
      add({ id: 'ssl-invalid', category: 'security', severity: 'critical', signal: 'expired_ssl', loss: 0.3, short: 'Invalid SSL certificate',
        title: 'SSL certificate is not trusted', detail: `Browsers block the page with a security warning (${cert.error}).` });
    } else if (days !== null && days <= 14) {
      add({ id: 'ssl-expiring', category: 'security', severity: 'high', signal: 'expired_ssl', loss: 0.04, short: `SSL expires in ${days} days`,
        title: `SSL certificate expires in ${days} days`, detail: `Issued by ${cert.issuer || 'unknown'}; renewal does not appear to be automated.` });
    }
  }
  if (origin.startsWith('https:')) {
    const mixed = mixedContent(pre.home.body);
    if (mixed >= 3) add({ id: 'mixed-content', category: 'security', severity: 'medium', loss: 0.015, short: 'Mixed content',
      title: `${mixed} resources loaded over insecure HTTP`, detail: 'Browsers block or warn on mixed content, breaking images and scripts.' });
  }

  // Catalogue via the public WooCommerce Store API
  const store = await storeCatalogue(origin, allowed);
  facts.store = store.products?.length ? summariseStore(store) : storeFromHtml(pre.home.body);
  if (!facts.region && store.currency) facts.region = regionFor(domain, store.currency, pre.region);

  // Checkout
  const checkout = await checkCheckout(origin, store, pre.home.body, allowed);
  facts.checkout = checkout;
  if (checkout.verdict === 'broken') {
    add({ id: 'checkout-broken', category: 'conversion', severity: 'critical', signal: 'broken_checkout', loss: 0.35, short: checkout.short,
      title: checkout.title, detail: checkout.detail });
  }

  // Performance
  const psi = await pagespeed(origin + '/');
  facts.performance = psi ? { ...psi, source: 'pagespeed' } : { source: 'ttfb', ttfbMs: pre.ttfb, renderBlocking: fp.renderBlocking };
  if (psi?.lcpMs) {
    const s = (psi.lcpMs / 1000).toFixed(1);
    const parts = [psi.unoptimisedImages && `${psi.unoptimisedImages} unoptimised images`, psi.renderBlocking && `${psi.renderBlocking} render-blocking resources`].filter(Boolean);
    if (psi.lcpMs > 2500) add({ id: 'slow-lcp', category: 'performance', severity: psi.lcpMs > 4000 ? 'high' : 'medium', signal: psi.lcpMs > 4000 ? 'slow_mobile' : null,
      loss: Math.min(0.25, ((psi.lcpMs - 2500) / 1000) * 0.04), short: `Mobile LCP ${s}s`,
      title: `Mobile LCP ${s}s`, detail: (parts.length ? parts.join(' and ') : 'Largest content paints late') + (psi.fieldData ? ' (real-user data)' : ' (lab data)') + '.' });
  } else if (pre.ttfb > 1800) {
    add({ id: 'slow-ttfb', category: 'performance', severity: 'high', signal: 'slow_mobile', loss: Math.min(0.2, ((pre.ttfb - 800) / 1000) * 0.05),
      short: `Server response ${(pre.ttfb / 1000).toFixed(1)}s`, title: `Server takes ${(pre.ttfb / 1000).toFixed(1)}s to respond`,
      detail: `${fp.renderBlocking.scripts} render-blocking scripts in <head>. Mobile lab data was unavailable for this run.` });
  }

  // Maintenance: core, WooCommerce, plugins, theme
  const [wpLatest, wcInfo] = await Promise.all([latestWordPress(), pluginInfo('woocommerce')]);
  facts.versions = { wordpress: fp.wpVersion, wordpressLatest: wpLatest, woocommerce: fp.wcVersion, woocommerceLatest: wcInfo?.version ?? null };
  const pluginReport = await auditPlugins(fp.plugins);
  facts.plugins = pluginReport;
  const stale = pluginReport.filter((p) => p.outdated);
  const vulnerable = pluginReport.filter((p) => p.vulnerabilities?.length);
  if (fp.wcVersion && wcInfo?.version) {
    const behind = await pluginReleasesBehind('woocommerce', fp.wcVersion);
    const lag = versionLag(fp.wcVersion, wcInfo.version);
    facts.versions.woocommerceReleasesBehind = behind;
    if (lag?.behind && (behind ?? 0) >= 6) {
      const vulnText = vulnerable.length ? `${vulnerable.length} plugin${vulnerable.length > 1 ? 's have' : ' has'} known vulnerabilities` : `latest is ${wcInfo.version}`;
      add({ id: 'woo-outdated', category: 'maintenance', severity: behind >= 12 || vulnerable.length ? 'high' : 'medium', signal: 'outdated_woo',
        loss: vulnerable.length ? 0.12 : 0.06, short: `WooCommerce ${fp.wcVersion}${stale.length ? `, ${stale.length} plugins stale` : ''}`,
        title: `WooCommerce ${fp.wcVersion}${stale.length ? ` and ${stale.length} outdated plugins` : ''}`, detail: `${behind} releases behind; ${vulnText}.` });
    }
  }
  if (!findings.some((f) => f.id === 'woo-outdated') && (vulnerable.length || stale.length >= 5)) {
    add({ id: 'plugins-outdated', category: 'maintenance', severity: vulnerable.length ? 'high' : 'medium', loss: vulnerable.length ? 0.1 : 0.03,
      short: `${stale.length} plugins stale`, title: `${stale.length} outdated plugins`,
      detail: vulnerable.length ? `${vulnerable.map((p) => p.slug).join(', ')} ${vulnerable.length > 1 ? 'have' : 'has'} known vulnerabilities.` : stale.slice(0, 4).map((p) => `${p.slug} ${p.version}→${p.latest}`).join(', ') });
  }
  const wpLag = versionLag(fp.wpVersion, wpLatest);
  if (wpLag?.behind && wpLag.major >= 1) {
    add({ id: 'wp-outdated', category: 'maintenance', severity: 'medium', loss: 0.02, short: `WordPress ${fp.wpVersion}`,
      title: `WordPress ${fp.wpVersion} (latest ${wpLatest})`, detail: 'Core has missed at least one major release and its security fixes.' });
  }
  const theme = await auditTheme(origin, fp.themes, allowed);
  facts.theme = theme;
  if (theme?.abandoned) {
    add({ id: 'theme-abandoned', category: 'maintenance', severity: 'high', signal: 'abandoned_theme', loss: 0.05,
      short: `Abandoned theme, no updates since ${theme.lastUpdated.slice(0, 4)}`, title: `Theme "${theme.name || theme.slug}" abandoned`,
      detail: `No updates since ${theme.lastUpdated.slice(0, 10)}; likely incompatible with current WooCommerce templates.` });
  }

  // SEO
  if (store.sampleProduct && allowed(new URL(store.sampleProduct).pathname)) {
    const page = await request(store.sampleProduct, { timeout: 15000 });
    if (!page.error && page.status < 400) {
      const sd = productStructuredData(page.body);
      facts.seo = { productUrl: store.sampleProduct, ...sd };
      if (!sd.hasProduct || !sd.hasPrice) {
        add({ id: 'no-structured-data', category: 'seo', severity: 'medium', loss: 0.05, short: 'Missing product structured data',
          title: 'Product pages missing structured data', detail: sd.hasProduct ? 'Product markup has no price, so rich results are not shown.' : 'No price or stock markup in search results.' });
      }
    }
  }
  if (!fp.metaDescription) add({ id: 'no-meta-description', category: 'seo', severity: 'low', loss: 0.01, short: 'No meta description',
    title: 'Homepage has no meta description', detail: 'Search engines generate a snippet from page text instead.' });

  return { facts, findings, ...score(findings, facts) };
}

function fmtStamp(ts) {
  return ts ? `${ts.slice(0, 4)}-${ts.slice(4, 6)}-${ts.slice(6, 8)}` : 'an earlier date';
}

async function storeCatalogue(origin, allowed) {
  if (!allowed('/wp-json/wc/store/v1/products')) return { available: false };
  const res = await request(`${origin}/wp-json/wc/store/v1/products?per_page=20`, { timeout: 15000, headers: { accept: 'application/json' } });
  if (res.error || res.status !== 200) return { available: false };
  let products;
  try { products = JSON.parse(res.body); } catch { return { available: false }; }
  if (!Array.isArray(products)) return { available: false };
  const total = Number(res.headers['x-wp-total']) || products.length;
  const prices = products.map((p) => Number(p.prices?.price) / 10 ** (p.prices?.currency_minor_unit ?? 2)).filter((n) => n > 0);
  const buyable = products.find((p) => p.type === 'simple' && p.is_purchasable !== false && p.is_in_stock !== false);
  return {
    available: true, products, total, prices,
    currency: products[0]?.prices?.currency_code || null,
    sampleProduct: (buyable || products[0])?.permalink || null,
    buyableId: buyable?.id ?? null,
  };
}

function summariseStore(store) {
  const sorted = [...store.prices].sort((a, b) => a - b);
  return { productCount: store.total, currency: store.currency, medianPrice: sorted.length ? sorted[Math.floor(sorted.length / 2)] : null, source: 'store-api' };
}

function storeFromHtml(html = '') {
  const prices = [...html.matchAll(/woocommerce-Price-amount[^>]*>(?:<bdi>)?\s*(?:<span[^>]*>[^<]*<\/span>)?\s*([0-9][0-9,]*(?:\.[0-9]{2})?)/g)]
    .map((m) => Number(m[1].replace(/,/g, ''))).filter((n) => n > 0).sort((a, b) => a - b);
  const productCount = new Set([...html.matchAll(/data-product_id=["'](\d+)/g)].map((m) => m[1])).size || null;
  return { productCount, currency: null, medianPrice: prices.length ? prices[Math.floor(prices.length / 2)] : null, source: 'html' };
}

/**
 * Adds one in-stock product to a cart session and loads checkout. Never submits an order or payment.
 */
export async function checkCheckout(origin, store, homeHtml, allowed) {
  const jar = new CookieJar();
  const checkoutPath = (homeHtml.match(/href=["'](?:https?:\/\/[^/"']+)?(\/[^"']*checkout[^"']*)["']/i)?.[1] || '/checkout/').split('#')[0];
  const result = { checkoutPath, method: null, paymentMethods: null };

  if (store.available && store.buyableId != null && allowed('/wp-json/wc/store/v1/cart')) {
    result.method = 'store-api';
    const cart = await request(`${origin}/wp-json/wc/store/v1/cart`, { jar, headers: { accept: 'application/json' } });
    const nonce = cart.headers?.nonce || cart.headers?.['x-wc-store-api-nonce'];
    const token = cart.headers?.['cart-token'];
    const headers = { 'content-type': 'application/json', accept: 'application/json', ...(nonce && { nonce, 'x-wc-store-api-nonce': nonce }), ...(token && { 'cart-token': token }) };
    const added = await request(`${origin}/wp-json/wc/store/v1/cart/add-item`, { method: 'POST', jar, headers, body: JSON.stringify({ id: store.buyableId, quantity: 1 }) });
    if (added.status >= 500) return { ...result, verdict: 'broken', short: 'Add to cart failing', title: 'Add to cart fails', detail: `The cart API returns HTTP ${added.status} when a product is added.` };
    let body = null;
    try { body = JSON.parse(added.body); } catch { /* ignore */ }
    if (added.status === 200 || added.status === 201) {
      result.paymentMethods = body?.payment_methods ?? null;
      const key = body?.items?.[0]?.key;
      if (Array.isArray(body?.payment_methods) && body.payment_methods.length === 0 && body?.needs_payment !== false) {
        await cleanup(origin, jar, headers, key);
        return { ...result, verdict: 'broken', short: 'No payment methods', title: 'Checkout has no payment methods', detail: 'Customers can fill a cart but no payment gateway is available at checkout.' };
      }
      const page = allowed(checkoutPath) ? await request(new URL(checkoutPath, origin).toString(), { jar }) : null;
      await cleanup(origin, jar, headers, key);
      return { ...result, ...judgeCheckoutPage(page) };
    }
    return { ...result, verdict: 'inconclusive', note: `add-item returned HTTP ${added.status || added.error}` };
  }

  // Classic fallback: ?add-to-cart=ID then load checkout with the session cookie.
  const productId = homeHtml.match(/data-product_id=["'](\d+)/)?.[1];
  if (!productId || !allowed(checkoutPath)) return { ...result, verdict: 'inconclusive', note: 'No purchasable product found' };
  result.method = 'classic';
  const added = await request(`${origin}/?add-to-cart=${productId}`, { jar });
  if (added.status >= 500 || fingerprint(added.body || '').criticalError) return { ...result, verdict: 'broken', short: 'Add to cart failing', title: 'Add to cart fails', detail: `Adding a product returns ${added.status >= 500 ? 'HTTP ' + added.status : 'a fatal error'}.` };
  const page = await request(new URL(checkoutPath, origin).toString(), { jar });
  return { ...result, ...judgeCheckoutPage(page) };
}

async function cleanup(origin, jar, headers, key) {
  if (key) await request(`${origin}/wp-json/wc/store/v1/cart/remove-item`, { method: 'POST', jar, headers, body: JSON.stringify({ key }) });
}

export function judgeCheckoutPage(page) {
  if (!page) return { verdict: 'inconclusive', note: 'Checkout disallowed by robots.txt' };
  if (page.error) return { verdict: 'broken', short: 'Checkout not loading', title: 'Checkout page does not load', detail: `Request failed (${page.error}).` };
  if (page.status >= 500) return { verdict: 'broken', short: 'Checkout failing', title: 'Checkout page returns a server error', detail: `HTTP ${page.status} when a customer reaches checkout with an item in their cart.` };
  const html = page.body || '';
  if (fingerprint(html).criticalError) return { verdict: 'broken', short: 'Checkout failing', title: 'Checkout page shows a fatal error', detail: 'A PHP fatal error replaces the checkout form.' };
  if (/no available payment methods|no payment methods available|Please contact us if you require assistance or wish to make alternate arrangements/i.test(html)) {
    return { verdict: 'broken', short: 'No payment methods', title: 'Checkout has no payment methods', detail: 'WooCommerce reports no available payment methods; orders cannot be placed.' };
  }
  if (/\/cart\/?$/.test(new URL(page.finalUrl).pathname) && !/checkout/.test(new URL(page.finalUrl).pathname)) return { verdict: 'inconclusive', note: 'Redirected to cart' };
  if (page.status === 404) return { verdict: 'broken', short: 'Checkout page missing', title: 'Checkout page returns 404', detail: 'The checkout URL linked from the store is not found.' };
  const hasForm = /woocommerce-checkout|wc-block-checkout|wp-block-woocommerce-checkout/i.test(html);
  return hasForm ? { verdict: 'ok' } : { verdict: 'inconclusive', note: 'Checkout form not detected' };
}

async function auditPlugins(plugins) {
  const out = [];
  for (const [slug, version] of Object.entries(plugins).slice(0, 25)) {
    if (slug === 'woocommerce') continue;
    const info = await pluginInfo(slug);
    if (!info?.found) { out.push({ slug, version, onWordPressOrg: false }); continue; }
    const lag = versionLag(version, info.version);
    // Asset ?ver= values occasionally lag a little behind the plugin header, so require a full minor release.
    const outdated = Boolean(lag?.behind && (lag.major > 0 || (lag.minor ?? 0) >= 1));
    const vulnerabilities = outdated ? await pluginVulnerabilities(slug, version) : null;
    out.push({ slug, version, latest: info.version, outdated, onWordPressOrg: true, lastUpdated: info.lastUpdated, vulnerabilities });
  }
  return out;
}

async function auditTheme(origin, slugs, allowed) {
  if (!slugs.length) return null;
  const slug = slugs[0];
  const stylePath = `/wp-content/themes/${slug}/style.css`;
  const style = allowed(stylePath) ? await request(origin + stylePath, { timeout: 10000 }) : null;
  const header = style && !style.error && style.status === 200 ? parseThemeStyle(style.body) : {};
  // A child theme's age is its parent's age.
  const effective = header.template || slug;
  const info = await themeInfo(effective);
  const lastUpdated = info?.found ? info.lastUpdated : null;
  const abandoned = Boolean(lastUpdated && Date.now() - new Date(lastUpdated) > 2 * 365 * DAY);
  return { slug, parent: header.template || null, name: header.name || info?.name || slug, version: header.version, latest: info?.version ?? null, onWordPressOrg: Boolean(info?.found), lastUpdated, abandoned };
}
