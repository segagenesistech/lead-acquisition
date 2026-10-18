// Pure HTML fingerprinting. No network access here so it is easy to test.

const first = (re, s) => s.match(re)?.[1] ?? null;

export function fingerprint(html = '', headers = {}) {
  const link = String(headers.link || '');
  const isWordPress = /\/wp-content\/|\/wp-includes\//i.test(html) || /api\.w\.org/i.test(link) || /<meta[^>]+generator[^>]+WordPress/i.test(html);
  const isWooCommerce = /woocommerce|wc-block-|wc_add_to_cart_params|\/wc\/store\//i.test(html);

  const generators = [...html.matchAll(/<meta[^>]+name=["']generator["'][^>]*content=["']([^"']+)["']/gi)].map((m) => m[1])
    .concat([...html.matchAll(/<meta[^>]+content=["']([^"']+)["'][^>]*name=["']generator["']/gi)].map((m) => m[1]));
  const gen = (name) => generators.map((g) => g.match(new RegExp(`^${name}\\s+([0-9][0-9.]*)`, 'i'))?.[1]).find(Boolean) || null;

  const wpVersion = gen('WordPress') || first(/\/wp-includes\/[^"'\s]*\?ver=(\d+\.\d+(?:\.\d+)?)["'&]/i, html);
  const plugins = pluginVersions(html);
  const wcVersion = gen('WooCommerce') || plugins.woocommerce || null;

  return {
    isWordPress,
    isWooCommerce: isWordPress && isWooCommerce,
    wpVersion,
    wcVersion,
    plugins,
    themes: themeSlugs(html),
    currency: detectCurrency(html),
    criticalError: /There has been a critical error on (this|your) website|<b>Fatal error<\/b>|Error establishing a database connection/i.test(html),
    parked: isParked(html),
    title: decodeEntities(first(/<title[^>]*>([^<]*)<\/title>/i, html)?.trim() || ''),
    metaDescription: first(/<meta[^>]+name=["']description["'][^>]*content=["']([^"']*)["']/i, html),
    renderBlocking: countRenderBlocking(html),
  };
}

/** slug -> version from ?ver= query strings on plugin assets. Asset versions usually track the plugin version. */
export function pluginVersions(html) {
  const counts = {};
  for (const m of html.matchAll(/\/wp-content\/plugins\/([a-z0-9_-]+)\/[^"'\s?]*\?(?:[^"'\s]*&(?:amp;)?)?ver=([0-9]+(?:\.[0-9]+){1,3})/gi)) {
    const slug = m[1].toLowerCase();
    (counts[slug] ??= {})[m[2]] = (counts[slug][m[2]] || 0) + 1;
  }
  const out = {};
  for (const [slug, versions] of Object.entries(counts)) {
    out[slug] = Object.entries(versions).sort((a, b) => b[1] - a[1])[0][0];
  }
  // Slugs present without a version still count as installed.
  for (const m of html.matchAll(/\/wp-content\/plugins\/([a-z0-9_-]+)\//gi)) out[m[1].toLowerCase()] ??= null;
  return out;
}

export function themeSlugs(html) {
  const counts = {};
  for (const m of html.matchAll(/\/wp-content\/themes\/([a-z0-9_-]+)\//gi)) counts[m[1].toLowerCase()] = (counts[m[1].toLowerCase()] || 0) + 1;
  return Object.entries(counts).sort((a, b) => b[1] - a[1]).map(([slug]) => slug);
}

export function parseThemeStyle(css = '') {
  const header = css.slice(0, 4000);
  const field = (name) => header.match(new RegExp(`^[\\s*]*${name}:\\s*(.+)$`, 'im'))?.[1]?.trim() || null;
  return { name: field('Theme Name'), version: field('Version'), template: field('Template'), author: field('Author') };
}

export function detectCurrency(html) {
  const code = first(/(?:product:price:currency|og:price:currency)["'][^>]*content=["']([A-Z]{3})/i, html)
    || first(/"(?:currency|currency_code|priceCurrency)"\s*:\s*"([A-Z]{3})"/, html);
  if (code) return code;
  const symbol = first(/woocommerce-Price-currencySymbol["']?>([^<]+)</i, html);
  if (!symbol) return null;
  const s = decodeEntities(symbol).trim();
  if (/^A\$|^AU\$/i.test(s)) return 'AUD';
  if (/^C\$|^CA\$/i.test(s)) return 'CAD';
  if (s === '$') return 'USD?';
  return null;
}

export function isParked(html) {
  return /domain (?:name )?(?:is|may be) for sale|this domain has expired|buy this domain|parkingcrew|sedoparking|domain parking|hugedomains|afternic|this site can.t be reached|account has been suspended|renew (?:your|this) domain/i.test(html);
}

export function countRenderBlocking(html) {
  const head = html.split(/<\/head>/i)[0] || '';
  const scripts = [...head.matchAll(/<script\b[^>]*\bsrc=[^>]*>/gi)].filter((m) => !/\b(async|defer)\b|type=["']module["']/i.test(m[0])).length;
  const styles = [...head.matchAll(/<link\b[^>]*rel=["']stylesheet["'][^>]*>/gi)].filter((m) => !/media=["']print["']/i.test(m[0])).length;
  return { scripts, styles };
}

/** All JSON-LD nodes on the page, with @graph flattened. */
export function jsonLd(html) {
  const nodes = [];
  for (const m of html.matchAll(/<script[^>]+type=["']application\/ld\+json["'][^>]*>([\s\S]*?)<\/script>/gi)) {
    try {
      const data = JSON.parse(m[1].trim());
      for (const d of [].concat(data)) nodes.push(...(d['@graph'] ? d['@graph'] : [d]));
    } catch { /* malformed JSON-LD is itself an SEO finding, handled by the caller */ }
  }
  return nodes;
}

export function productStructuredData(html) {
  const product = jsonLd(html).find((n) => [].concat(n['@type']).includes('Product'));
  if (!product) return { hasProduct: false, hasPrice: false, hasAvailability: false };
  const offers = [].concat(product.offers || []).flatMap((o) => (o.offers ? [].concat(o.offers) : [o]));
  return {
    hasProduct: true,
    hasPrice: offers.some((o) => o.price != null || o.lowPrice != null || o.priceSpecification),
    hasAvailability: offers.some((o) => o.availability),
  };
}

export function mixedContent(html) {
  return [...html.matchAll(/<(?:script|img|link|iframe)\b[^>]+(?:src|href)=["']http:\/\/[^"']+["']/gi)].length;
}

export function decodeEntities(s) {
  return s.replace(/&#(\d+);/g, (_, n) => String.fromCharCode(n)).replace(/&#x([0-9a-f]+);/gi, (_, n) => String.fromCharCode(parseInt(n, 16)))
    .replace(/&amp;/g, '&').replace(/&quot;/g, '"').replace(/&#039;|&apos;/g, "'").replace(/&lt;/g, '<').replace(/&gt;/g, '>').replace(/&nbsp;/g, ' ');
}

/** Registrable domain, e.g. shop.example.com.au -> example.com.au */
export function registrableDomain(host) {
  const h = host.toLowerCase().replace(/^www\./, '').replace(/\.$/, '');
  const parts = h.split('.');
  const twoLevel = /\.(com|net|org|edu|gov|id|asn|co|qc|on|bc|ab)\.(au|ca|us|uk|nz)$/.test(h);
  return parts.slice(twoLevel ? -3 : -2).join('.');
}

export function compareVersions(a, b) {
  const pa = String(a).split('.').map(Number);
  const pb = String(b).split('.').map(Number);
  for (let i = 0; i < Math.max(pa.length, pb.length); i++) {
    const d = (pa[i] || 0) - (pb[i] || 0);
    if (d) return d;
  }
  return 0;
}

/** How far behind a version is: { major, minor } where major counts x in x.y. */
export function versionLag(current, latest) {
  if (!current || !latest) return null;
  const [cM, cm = 0] = current.split('.').map(Number);
  const [lM, lm = 0] = latest.split('.').map(Number);
  return { major: lM - cM, minor: lM === cM ? lm - cm : null, behind: compareVersions(latest, current) > 0 };
}
