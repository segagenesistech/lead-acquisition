import http from 'node:http';
import { readFile } from 'node:fs/promises';
import { join, extname, normalize } from 'node:path';
import { config, ROOT, REGIONS, INDUSTRIES, SIGNALS } from './config.js';
import { getDb, auditsLeft } from './db.js';
import { estimateScope, providerStatus, buildQueries } from './discovery/index.js';
import { startScan, startScheduler } from './scanner.js';
import { riskLevel } from './audit/scoring.js';

const PUBLIC = join(ROOT, 'public');
const MIME = { '.html': 'text/html; charset=utf-8', '.js': 'text/javascript', '.css': 'text/css', '.svg': 'image/svg+xml', '.png': 'image/png', '.ico': 'image/x-icon' };

const send = (res, status, body, type = 'application/json') => {
  res.writeHead(status, { 'content-type': type, 'cache-control': 'no-store' });
  res.end(type === 'application/json' ? JSON.stringify(body) : body);
};
const fail = (res, status, message) => send(res, status, { error: message });

async function readJson(req) {
  let raw = '';
  for await (const c of req) { raw += c; if (raw.length > 1e6) throw new Error('Body too large'); }
  return raw ? JSON.parse(raw) : {};
}

function cleanParams(b) {
  const list = (v, allowed) => [...new Set((Array.isArray(v) ? v : []).map((x) => String(x).trim()).filter((x) => x && (!allowed || allowed.includes(x))))];
  return {
    regions: list(b.regions, Object.keys(REGIONS)),
    keywords: list(b.keywords).slice(0, 20),
    industries: list(b.industries, Object.keys(INDUSTRIES)),
    signals: list(b.signals, Object.keys(SIGNALS)),
    domains: list(b.domains).slice(0, 5000),
  };
}

function searchName(p) {
  const parts = p.keywords.length ? p.keywords.slice(0, 2) : p.industries.slice(0, 2).map((i) => INDUSTRIES[i].label);
  if (!parts.length) return p.domains.length ? `Imported list (${p.domains.length} domains)` : 'Untitled search';
  const s = parts.join(' and ');
  return s[0].toUpperCase() + s.slice(1);
}

function leadRow(r) {
  const facts = JSON.parse(r.facts);
  return {
    auditId: r.audit_id, domain: r.domain, region: r.region, industry: r.industry, industryLabel: INDUSTRIES[r.industry]?.label || null,
    health: r.health, revenueAtRisk: r.revenue_at_risk, mainSignal: r.main_signal, signals: JSON.parse(r.signals),
    risk: riskLevel(r), auditedAt: r.created_at, wcVersion: facts.versions?.woocommerce || null,
    sslExpires: facts.ssl?.validTo || null, domainExpires: facts.domain_registration?.expiresAt || null, status: facts.status,
  };
}

function leads(searchId, q) {
  const rows = getDb().prepare(`SELECT sl.audit_id, s.domain, s.region, s.industry, a.health, a.revenue_at_risk, a.main_signal, a.signals, a.facts, a.created_at
    FROM search_leads sl JOIN stores s ON s.id = sl.store_id JOIN audits a ON a.id = sl.audit_id
    WHERE sl.search_id = ? AND sl.qualified = 1 ORDER BY a.revenue_at_risk DESC, a.health ASC`).all(searchId).map(leadRow);
  return rows.filter((l) => (!q.region || l.region === q.region)
    && (!q.signal || l.signals.includes(q.signal))
    && (!q.risk || l.risk === q.risk)
    && (!q.q || l.domain.includes(q.q.toLowerCase())));
}

const csvCell = (v) => {
  const s = v == null ? '' : String(v);
  // Prefix formula-looking cells so spreadsheet apps don't execute them.
  const safe = /^[=+\-@\t\r]/.test(s) ? `'${s}` : s;
  return /[",\n]/.test(safe) ? `"${safe.replace(/"/g, '""')}"` : safe;
};

function toCsv(rows, origin) {
  const head = ['domain', 'region', 'industry', 'main_signal', 'signals', 'health', 'revenue_at_risk_usd_month', 'risk', 'woocommerce_version', 'ssl_expires', 'domain_expires', 'audited_at', 'audit_url'];
  const lines = rows.map((l) => [l.domain, l.region, l.industryLabel, l.mainSignal, l.signals.map((s) => SIGNALS[s]?.label).join('; '), l.health, l.revenueAtRisk, l.risk,
    l.wcVersion, l.sslExpires?.slice(0, 10), l.domainExpires?.slice(0, 10), l.auditedAt, `${origin}/#/audit/${l.auditId}`].map(csvCell).join(','));
  return [head.join(','), ...lines].join('\n') + '\n';
}

function searchSummary(s) {
  const db = getDb();
  const scan = db.prepare('SELECT * FROM scans WHERE search_id = ? ORDER BY id DESC LIMIT 1').get(s.id);
  const qualified = db.prepare('SELECT COUNT(*) n FROM search_leads WHERE search_id = ? AND qualified = 1').get(s.id).n;
  return { id: s.id, name: s.name, params: JSON.parse(s.params), recurring: Boolean(s.recurring), intervalDays: s.interval_days, createdAt: s.created_at, lastRunAt: s.last_run_at,
    qualified, scan: scan && { id: scan.id, status: scan.status, progress: JSON.parse(scan.progress), error: scan.error, startedAt: scan.started_at, finishedAt: scan.finished_at } };
}

const routes = [
  ['GET', /^\/api\/meta$/, () => ({ regions: REGIONS, industries: INDUSTRIES, signals: SIGNALS, auditsLeft: auditsLeft(), quota: config.monthlyQuota, auditsPerScan: config.auditsPerScan, provider: providerStatus() })],
  ['POST', /^\/api\/estimate$/, async (req) => {
    const p = cleanParams(await readJson(req));
    return { candidates: estimateScope(p), queries: buildQueries(p).length };
  }],
  ['GET', /^\/api\/searches$/, () => getDb().prepare('SELECT * FROM searches ORDER BY id DESC').all().map(searchSummary)],
  ['POST', /^\/api\/searches$/, async (req) => {
    const body = await readJson(req);
    const p = cleanParams(body);
    if (!p.domains.length && !p.regions.length) throw Object.assign(new Error('Pick at least one region'), { status: 400 });
    if (!p.domains.length && !p.keywords.length && !p.industries.length) throw Object.assign(new Error('Add a keyword or an industry'), { status: 400 });
    if (!p.domains.length && !providerStatus().ready) throw Object.assign(new Error(`Discovery provider "${config.discoveryProvider}" has no API key. Add one to .env, or paste a list of domains.`), { status: 400 });
    const db = getDb();
    const { lastInsertRowid } = db.prepare('INSERT INTO searches (name, params, recurring, interval_days) VALUES (?, ?, ?, ?)')
      .run(String(body.name || '').trim() || searchName(p), JSON.stringify(p), body.recurring ? 1 : 0, Number(body.intervalDays) || 7);
    const id = Number(lastInsertRowid);
    if (body.run !== false) startScan(id);
    return searchSummary(db.prepare('SELECT * FROM searches WHERE id = ?').get(id));
  }],
  ['GET', /^\/api\/searches\/(\d+)$/, (req, [id]) => {
    const s = getDb().prepare('SELECT * FROM searches WHERE id = ?').get(id);
    return s ? searchSummary(s) : null;
  }],
  ['PATCH', /^\/api\/searches\/(\d+)$/, async (req, [id]) => {
    const b = await readJson(req);
    const db = getDb();
    if ('recurring' in b) db.prepare('UPDATE searches SET recurring = ? WHERE id = ?').run(b.recurring ? 1 : 0, id);
    if (b.name) db.prepare('UPDATE searches SET name = ? WHERE id = ?').run(String(b.name), id);
    const s = db.prepare('SELECT * FROM searches WHERE id = ?').get(id);
    return s ? searchSummary(s) : null;
  }],
  ['DELETE', /^\/api\/searches\/(\d+)$/, (req, [id]) => { getDb().prepare('DELETE FROM searches WHERE id = ?').run(id); return { ok: true }; }],
  ['POST', /^\/api\/searches\/(\d+)\/run$/, (req, [id]) => {
    if (!getDb().prepare('SELECT 1 FROM searches WHERE id = ?').get(id)) return null;
    return { scanId: startScan(Number(id)) };
  }],
  ['GET', /^\/api\/searches\/(\d+)\/leads$/, (req, [id], q) => leads(id, q)],
  ['GET', /^\/api\/searches\/(\d+)\/leads\.csv$/, (req, [id], q, res) => {
    const s = getDb().prepare('SELECT name FROM searches WHERE id = ?').get(id);
    if (!s) return null;
    const file = s.name.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '') || 'leads';
    res.writeHead(200, { 'content-type': 'text/csv; charset=utf-8', 'content-disposition': `attachment; filename="${file}.csv"` });
    res.end(toCsv(leads(id, q), `http://${req.headers.host}`));
    return undefined;
  }],
  ['GET', /^\/api\/scans\/(\d+)\/candidates$/, (req, [id]) => {
    const scan = getDb().prepare('SELECT s.*, se.name FROM scans s JOIN searches se ON se.id = s.search_id WHERE s.id = ?').get(id);
    if (!scan) return null;
    const rows = getDb().prepare(`SELECT domain, region, outcome, reason, audit_id auditId FROM scan_candidates WHERE scan_id = ?
      ORDER BY CASE outcome WHEN 'qualified' THEN 0 WHEN 'healthy' THEN 1 WHEN 'woocommerce' THEN 2 WHEN 'not-audited' THEN 3 ELSE 4 END, outcome, domain`).all(id);
    return { scan: { id: scan.id, searchId: scan.search_id, name: scan.name, status: scan.status, error: scan.error, progress: JSON.parse(scan.progress) }, candidates: rows };
  }],
  ['GET', /^\/api\/audits$/, () => getDb().prepare(`SELECT a.id audit_id, s.domain, s.region, s.industry, a.health, a.revenue_at_risk, a.main_signal, a.signals, a.facts, a.created_at
    FROM audits a JOIN stores s ON s.id = a.store_id ORDER BY a.id DESC LIMIT 500`).all().map(leadRow)],
  ['GET', /^\/api\/audits\/(\d+)$/, (req, [id]) => {
    const a = getDb().prepare('SELECT a.*, s.domain, s.region, s.industry FROM audits a JOIN stores s ON s.id = a.store_id WHERE a.id = ?').get(id);
    if (!a) return null;
    return { id: a.id, domain: a.domain, region: a.region, industry: a.industry, industryLabel: INDUSTRIES[a.industry]?.label || null, createdAt: a.created_at,
      health: a.health, categories: JSON.parse(a.categories), revenueAtRisk: a.revenue_at_risk, baselineRevenue: a.baseline_revenue,
      mainSignal: a.main_signal, signals: JSON.parse(a.signals), findings: JSON.parse(a.findings), facts: JSON.parse(a.facts), risk: riskLevel(a) };
  }],
];

async function handle(req, res) {
  const url = new URL(req.url, 'http://localhost');
  if (url.pathname.startsWith('/api/')) {
    for (const [method, re, fn] of routes) {
      const m = url.pathname.match(re);
      if (!m || method !== req.method) continue;
      try {
        const out = await fn(req, m.slice(1), Object.fromEntries(url.searchParams), res);
        if (out === undefined) return;
        return out === null ? fail(res, 404, 'Not found') : send(res, 200, out);
      } catch (e) {
        return fail(res, e.status || (e instanceof SyntaxError ? 400 : 500), e.message);
      }
    }
    return fail(res, 404, 'Not found');
  }
  const path = normalize(url.pathname === '/' ? '/index.html' : url.pathname).replace(/^(\.\.[/\\])+/, '');
  try {
    const body = await readFile(join(PUBLIC, path));
    send(res, 200, body, MIME[extname(path)] || 'application/octet-stream');
  } catch {
    send(res, 404, 'Not found', 'text/plain');
  }
}

export function createServer() {
  getDb();
  return http.createServer(handle);
}

if (process.argv[1] && import.meta.url.endsWith(process.argv[1].replace(/\\/g, '/').split('/').pop())) {
  const server = createServer().listen(config.port, () => {
    const p = providerStatus();
    console.log(`Leadforge running at http://localhost:${server.address().port}`);
    console.log(`Discovery: ${p.name}${p.ready ? '' : ' (no API key — paste domains in the UI or set one in .env)'}`);
  });
  startScheduler();
}
