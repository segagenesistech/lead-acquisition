// Third-party data sources used during an audit. Every function resolves to null when the source is unavailable.
import { config } from '../config.js';
import { cached } from '../db.js';
import { apiJson, request } from './http.js';

const HOUR = 3600e3;
const DAY = 24 * HOUR;

/** wordpress.org dates look like "2025-10-01 3:00pm GMT" (plugins) or "2025-10-01" (themes). */
export function parseWpDate(s) {
  const m = String(s || '').match(/^(\d{4}-\d{2}-\d{2})(?:\s+(\d{1,2}):(\d{2})\s*(am|pm))?/i);
  if (!m) return null;
  let h = Number(m[2] || 0);
  if (m[4]) h = (h % 12) + (m[4].toLowerCase() === 'pm' ? 12 : 0);
  return new Date(`${m[1]}T${String(h).padStart(2, '0')}:${m[3] || '00'}:00Z`).toISOString();
}

export const latestWordPress = () => cached('wp:core', 12 * HOUR, async () => {
  const d = await apiJson(`${config.api.wporg}/core/version-check/1.7/`);
  return d?.offers?.[0]?.current ?? null;
});

export const pluginInfo = (slug) => cached(`wp:plugin:${slug}`, 12 * HOUR, async () => {
  const d = await apiJson(`${config.api.wporg}/plugins/info/1.2/?action=plugin_information&request[slug]=${encodeURIComponent(slug)}&request[fields][sections]=0`);
  if (!d || d.error) return { found: false };
  return { found: true, version: d.version, lastUpdated: parseWpDate(d.last_updated), name: d.name };
});

export const themeInfo = (slug) => cached(`wp:theme:${slug}`, 2 * DAY, async () => {
  const d = await apiJson(`${config.api.wporg}/themes/info/1.2/?action=theme_information&request[slug]=${encodeURIComponent(slug)}`);
  if (!d || d.error) return { found: false };
  return { found: true, version: d.version, lastUpdated: parseWpDate(d.last_updated), name: d.name };
});

/** Known vulnerabilities for a plugin version (requires WPSCAN_API_TOKEN). */
export async function pluginVulnerabilities(slug, version) {
  if (!config.wpscanToken || !version) return null;
  const d = await cached(`wpscan:${slug}`, DAY, () => apiJson(`${config.api.wpscan}/plugins/${encodeURIComponent(slug)}`, {
    headers: { authorization: `Token token=${config.wpscanToken}` },
  }));
  const vulns = d?.[slug]?.vulnerabilities || [];
  const { compareVersions } = await import('./detect.js');
  return vulns.filter((v) => v.fixed_in && compareVersions(version, v.fixed_in) < 0).map((v) => ({ title: v.title, fixedIn: v.fixed_in }));
}

/** Domain registration status via RDAP. */
export async function domainRegistration(domain) {
  return cached(`rdap:${domain}`, DAY, async () => {
    try {
      const res = await fetch(`${config.api.rdap}/domain/${domain}`, { headers: { accept: 'application/rdap+json' }, signal: AbortSignal.timeout(15000) });
      if (res.status === 404) return { registered: false };
      if (!res.ok) return null;
      const d = await res.json();
      const exp = d.events?.find((e) => e.eventAction === 'expiration')?.eventDate;
      const status = (d.status || []).map((s) => s.toLowerCase());
      return {
        registered: true,
        expiresAt: exp ? new Date(exp).toISOString() : null,
        inRedemption: status.some((s) => /redemption|pending delete/.test(s)),
        onHold: status.some((s) => /hold/.test(s) && !/transfer/.test(s)),
      };
    } catch {
      return null;
    }
  });
}

/** Mobile Lighthouse run from Google PageSpeed Insights. */
export async function pagespeed(url) {
  return cached(`psi:${url}`, 3 * DAY, async () => {
    const q = new URLSearchParams({ url, strategy: 'mobile', category: 'performance' });
    if (config.pagespeedKey) q.set('key', config.pagespeedKey);
    const d = await apiJson(`${config.api.pagespeed}?${q}`, { timeout: 90000 });
    const a = d?.lighthouseResult?.audits;
    if (!a) return null;
    const items = (id) => a[id]?.details?.items?.length || 0;
    return {
      lcpMs: Math.round(d.loadingExperience?.metrics?.LARGEST_CONTENTFUL_PAINT_MS?.percentile ?? a['largest-contentful-paint']?.numericValue ?? 0) || null,
      fieldData: Boolean(d.loadingExperience?.metrics?.LARGEST_CONTENTFUL_PAINT_MS),
      score: d.lighthouseResult.categories?.performance?.score != null ? Math.round(d.lighthouseResult.categories.performance.score * 100) : null,
      renderBlocking: items('render-blocking-resources'),
      unoptimisedImages: items('uses-optimized-images') + items('modern-image-formats') + items('uses-responsive-images'),
    };
  });
}

/** The most recent archived copy of a domain's homepage, used to prove a dead site used to run WooCommerce. */
export async function waybackSnapshot(domain) {
  return cached(`wayback:${domain}`, 7 * DAY, async () => {
    const d = await apiJson(`${config.api.wayback}/wayback/available?url=${encodeURIComponent(domain)}`);
    const snap = d?.archived_snapshots?.closest;
    if (!snap?.available) return null;
    // "id_" asks for the original bytes without the Wayback toolbar.
    const rawUrl = snap.url.replace(/\/web\/(\d+)\//, '/web/$1id_/');
    try {
      const res = await fetch(rawUrl, { signal: AbortSignal.timeout(20000) });
      return { timestamp: snap.timestamp, url: snap.url, html: (await res.text()).slice(0, 1_500_000) };
    } catch {
      return { timestamp: snap.timestamp, url: snap.url, html: '' };
    }
  });
}

/** robots.txt rules that apply to us. Returns a predicate: allowed(path). */
export async function robots(origin) {
  const res = await request(`${origin}/robots.txt`, { timeout: 8000 });
  if (res.error || res.status >= 400 || !res.body) return () => true;
  return parseRobots(res.body, 'leadforgebot');
}

export function parseRobots(txt, agent) {
  const groups = [];
  let current = null;
  for (const raw of txt.split(/\r?\n/)) {
    const line = raw.replace(/#.*/, '').trim();
    const m = line.match(/^([a-z-]+)\s*:\s*(.*)$/i);
    if (!m) continue;
    const [, key, value] = [m[0], m[1].toLowerCase(), m[2].trim()];
    if (key === 'user-agent') {
      if (!current || current.rules.length) groups.push((current = { agents: [], rules: [] }));
      current.agents.push(value.toLowerCase());
    } else if (current && (key === 'allow' || key === 'disallow')) {
      current.rules.push({ allow: key === 'allow', path: value });
    }
  }
  const group = groups.find((g) => g.agents.some((a) => a !== '*' && agent.includes(a))) || groups.find((g) => g.agents.includes('*'));
  const rules = (group?.rules || []).filter((r) => r.path);
  return (path) => {
    let best = null;
    for (const r of rules) {
      const re = new RegExp('^' + r.path.replace(/[.+?^${}()|[\]\\]/g, '\\$&').replace(/\*/g, '.*').replace(/\\\$$/, '$'));
      if (re.test(path) && (!best || r.path.length > best.path.length || (r.path.length === best.path.length && r.allow))) best = r;
    }
    return !best || best.allow;
  };
}
