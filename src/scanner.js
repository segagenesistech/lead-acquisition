import { config, INDUSTRIES } from './config.js';
import { getDb, auditsLeft, consumeAudit } from './db.js';
import { discover, buildQueries, guessIndustry } from './discovery/index.js';
import { prescreen, audit } from './audit/index.js';
import { compareVersions } from './audit/detect.js';

const REUSE_AUDIT_MS = 7 * 86400e3;
let queue = Promise.resolve();

export function startScan(searchId) {
  const db = getDb();
  const { lastInsertRowid } = db.prepare('INSERT INTO scans (search_id) VALUES (?)').run(searchId);
  const scanId = Number(lastInsertRowid);
  db.prepare(`UPDATE searches SET last_run_at = datetime('now') WHERE id = ?`).run(searchId);
  queue = queue.then(() => runScan(scanId)).catch((e) => console.error('scan failed', e));
  return scanId;
}

/** Run up to `limit` async tasks at once. */
async function pool(items, limit, fn) {
  const it = items[Symbol.asyncIterator] ? items[Symbol.asyncIterator]() : items[Symbol.iterator]();
  const workers = Array.from({ length: limit }, async () => {
    for (let n = await it.next(); !n.done; n = await it.next()) {
      // One bad site must not sink the whole scan.
      try { await fn(n.value); } catch (e) { console.error('scan item failed', e); }
    }
  });
  await Promise.all(workers);
}

// Quick ordering before full audits, using only what the prescreen saw.
function prescore(p) {
  let s = 0;
  if (p.status === 'offline') s += 60;
  if (p.status === 'erroring') s += 55;
  if (p.home?.tls && !p.home.tls.authorized) s += 40;
  if (p.origin?.startsWith('http:')) s += 20;
  if (p.fingerprint.wcVersion && compareVersions('8.0', p.fingerprint.wcVersion) > 0) s += 25;
  if (p.ttfb > 1500) s += 10;
  return s;
}

export async function runScan(scanId) {
  const db = getDb();
  const scan = db.prepare('SELECT * FROM scans WHERE id = ?').get(scanId);
  const search = db.prepare('SELECT * FROM searches WHERE id = ?').get(scan.search_id);
  if (!search) return;
  const params = JSON.parse(search.params);
  const progress = { phase: 'discovering', queries: params.domains?.length ? 0 : buildQueries(params).length, queriesDone: 0, candidates: 0, checked: 0, woocommerce: 0, audited: 0, reused: 0, qualified: 0, quotaReached: false };
  const save = (status = 'running', error = null) => db.prepare(`UPDATE scans SET status = ?, progress = ?, error = ?, finished_at = CASE WHEN ? IN ('done','failed') THEN datetime('now') END WHERE id = ?`)
    .run(status, JSON.stringify(progress), error, status, scanId);
  save();

  try {
    // 1. Discover candidates and prescreen them as they arrive.
    const stores = [];
    const candidates = discover(params, { onQuery: () => { progress.queriesDone++; save(); } });
    const counted = (async function* () { for await (const c of candidates) { progress.candidates++; yield c; } })();
    await pool(counted, config.concurrency, async (c) => {
      const p = await prescreen(c.domain, { regionHint: c.region });
      progress.checked++;
      if (p.status !== 'not-woocommerce') {
        const inRegion = !p.region || !params.regions?.length || params.regions.includes(p.region);
        if (inRegion) {
          progress.woocommerce++;
          const text = `${p.fingerprint.title} ${p.fingerprint.metaDescription || ''} ${c.term || ''}`;
          p.industry = guessIndustry(text, params.industries?.length ? params.industries : Object.keys(INDUSTRIES)) || c.industry;
          stores.push(p);
        }
      }
      if (progress.checked % 5 === 0) save();
    });

    // 2. Full audits, most promising first, within the scan cap and the monthly quota.
    progress.phase = 'auditing';
    stores.sort((a, b) => prescore(b) - prescore(a));
    const limit = Math.min(config.auditsPerScan, stores.length);
    const wanted = new Set(params.signals || []);
    await pool(stores.slice(0, limit), Math.max(2, Math.floor(config.concurrency / 2)), async (p) => {
      const storeId = upsertStore(p);
      const recent = db.prepare(`SELECT * FROM audits WHERE store_id = ? ORDER BY id DESC LIMIT 1`).get(storeId);
      let row = recent && Date.now() - new Date(recent.created_at + 'Z') < REUSE_AUDIT_MS ? recent : null;
      if (row) progress.reused++;
      else {
        if (auditsLeft() <= 0) { progress.quotaReached = true; return; }
        consumeAudit();
        const result = await audit(p, { industry: p.industry });
        row = saveAudit(storeId, scanId, result);
        progress.audited++;
      }
      const signals = JSON.parse(row.signals);
      const qualified = wanted.size ? signals.some((s) => wanted.has(s)) : signals.length > 0;
      if (qualified) progress.qualified++;
      db.prepare(`INSERT INTO search_leads (search_id, store_id, audit_id, qualified) VALUES (?, ?, ?, ?)
        ON CONFLICT(search_id, store_id) DO UPDATE SET audit_id = excluded.audit_id, qualified = excluded.qualified`)
        .run(search.id, storeId, row.id, qualified ? 1 : 0);
      save();
    });
    progress.phase = 'done';
    save('done');
  } catch (e) {
    progress.phase = 'failed';
    save('failed', e.message);
  }
}

function upsertStore(p) {
  const db = getDb();
  db.prepare(`INSERT INTO stores (domain, region, industry) VALUES (?, ?, ?)
    ON CONFLICT(domain) DO UPDATE SET region = COALESCE(excluded.region, region), industry = COALESCE(excluded.industry, industry)`)
    .run(p.domain, p.region || null, p.industry || null);
  return db.prepare('SELECT id FROM stores WHERE domain = ?').get(p.domain).id;
}

export function saveAudit(storeId, scanId, r) {
  const db = getDb();
  const { lastInsertRowid } = db.prepare(`INSERT INTO audits (store_id, scan_id, health, categories, revenue_at_risk, baseline_revenue, main_signal, signals, findings, facts)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`).run(storeId, scanId, r.health, JSON.stringify(r.categories), r.revenueAtRisk, r.baselineRevenue,
    r.mainSignal, JSON.stringify(r.signals), JSON.stringify(r.findings), JSON.stringify({ ...r.facts, model: r.model }));
  if (r.facts.region) db.prepare('UPDATE stores SET region = ? WHERE id = ?').run(r.facts.region, storeId);
  return db.prepare('SELECT * FROM audits WHERE id = ?').get(Number(lastInsertRowid));
}

/** Re-run any recurring search whose interval has elapsed. */
export function startScheduler(everyMs = 10 * 60e3) {
  const tick = () => {
    const due = getDb().prepare(`SELECT id FROM searches WHERE recurring = 1
      AND (last_run_at IS NULL OR last_run_at <= datetime('now', '-' || interval_days || ' days'))`).all();
    for (const s of due) startScan(s.id);
  };
  tick();
  return setInterval(tick, everyMs).unref();
}
