import { readFileSync, existsSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

export const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');

// Minimal .env loader so the app runs with zero dependencies.
const envFile = join(ROOT, '.env');
if (existsSync(envFile)) {
  for (const line of readFileSync(envFile, 'utf8').split('\n')) {
    const m = line.match(/^\s*([A-Z0-9_]+)\s*=\s*(.*?)\s*(#.*)?$/);
    if (m && process.env[m[1]] === undefined) process.env[m[1]] = m[2].replace(/^["']|["']$/g, '');
  }
}

const env = (k, d) => (process.env[k] === undefined || process.env[k] === '' ? d : process.env[k]);
const json = (k, d) => { try { return JSON.parse(env(k, '')) ?? d; } catch { return d; } };

export const config = {
  port: Number(env('PORT', 4310)),
  dbPath: env('DB_PATH', join(ROOT, 'data', 'leadforge.db')),
  discoveryProvider: env('DISCOVERY_PROVIDER', 'brave'),
  braveKey: env('BRAVE_API_KEY', ''),
  serpapiKey: env('SERPAPI_KEY', ''),
  googleCseKey: env('GOOGLE_CSE_KEY', ''),
  googleCseCx: env('GOOGLE_CSE_CX', ''),
  pagespeedKey: env('PAGESPEED_API_KEY', ''),
  wpscanToken: env('WPSCAN_API_TOKEN', ''),
  monthlyQuota: Number(env('MONTHLY_AUDIT_QUOTA', 500)),
  auditsPerScan: Number(env('AUDITS_PER_SCAN', 300)),
  concurrency: Number(env('SCAN_CONCURRENCY', 8)),
  userAgent: `Mozilla/5.0 (compatible; LeadforgeBot/1.0${env('CONTACT_EMAIL', '') ? '; +mailto:' + env('CONTACT_EMAIL') : ''})`,
  // External API bases are configurable so tests can point them at a local mock.
  api: {
    wporg: env('WPORG_API', 'https://api.wordpress.org'),
    rdap: env('RDAP_API', 'https://rdap.org'),
    pagespeed: env('PAGESPEED_API', 'https://www.googleapis.com/pagespeedonline/v5/runPagespeed'),
    wayback: env('WAYBACK_API', 'https://archive.org'),
    wpscan: env('WPSCAN_API', 'https://wpscan.com/api/v3'),
  },
  // Test-only: { "store.test": { "http": 5001, "https": 5443 } } routes a domain to localhost.
  hostOverrides: json('LEADFORGE_HOST_OVERRIDES', {}),
};

export const REGIONS = {
  US: { label: 'United States', tlds: ['.us'], currency: 'USD', gl: 'us' },
  AU: { label: 'Australia', tlds: ['.com.au', '.net.au', '.org.au', '.au'], currency: 'AUD', gl: 'au' },
  CA: { label: 'Canada', tlds: ['.ca'], currency: 'CAD', gl: 'ca' },
};

// conversion: industry benchmark e-commerce conversion rate; aov: fallback average order value (USD)
export const INDUSTRIES = {
  'health-beauty': { label: 'Health & beauty', terms: ['skincare', 'beauty', 'cosmetics'], conversion: 0.025, aov: 62 },
  supplements: { label: 'Supplements', terms: ['supplements', 'vitamins', 'protein'], conversion: 0.028, aov: 58 },
  fashion: { label: 'Fashion', terms: ['clothing', 'apparel', 'boutique'], conversion: 0.019, aov: 85 },
  'home-garden': { label: 'Home & garden', terms: ['homewares', 'garden supplies', 'home decor'], conversion: 0.016, aov: 95 },
  'pet-supplies': { label: 'Pet supplies', terms: ['pet supplies', 'dog treats', 'pet food'], conversion: 0.024, aov: 55 },
  'food-drink': { label: 'Food & drink', terms: ['coffee', 'tea', 'gourmet food'], conversion: 0.029, aov: 48 },
  outdoor: { label: 'Outdoor', terms: ['camping gear', 'outdoor gear', 'hiking'], conversion: 0.017, aov: 120 },
};

export const SIGNALS = {
  expired_ssl: { label: 'Expired SSL', category: 'security' },
  outdated_woo: { label: 'Outdated WooCommerce', category: 'maintenance' },
  domain_expiring: { label: 'Domain expiring', category: 'security' },
  broken_checkout: { label: 'Broken checkout', category: 'conversion' },
  slow_mobile: { label: 'Slow mobile speed', category: 'performance' },
  abandoned_theme: { label: 'Abandoned theme', category: 'maintenance' },
};

export const CATEGORIES = ['conversion', 'security', 'performance', 'maintenance', 'seo'];

// Marketplaces and platforms that show up in search results but are never leads.
export const EXCLUDED_DOMAINS = [
  'amazon.', 'ebay.', 'etsy.com', 'walmart.com', 'target.com', 'facebook.com', 'instagram.com', 'pinterest.',
  'youtube.com', 'reddit.com', 'wikipedia.org', 'tiktok.com', 'linkedin.com', 'x.com', 'twitter.com',
  'woocommerce.com', 'wordpress.org', 'wordpress.com', 'shopify.com', 'google.', 'bing.com', 'yelp.',
  'trustpilot.', 'quora.com', 'medium.com', 'bunnings.com.au', 'catch.com.au', 'canadiantire.ca', 'costco.',
];
