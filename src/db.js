import { DatabaseSync } from 'node:sqlite';
import { mkdirSync } from 'node:fs';
import { dirname } from 'node:path';
import { config } from './config.js';

let db;

export function getDb() {
  if (db) return db;
  if (config.dbPath !== ':memory:') mkdirSync(dirname(config.dbPath), { recursive: true });
  db = new DatabaseSync(config.dbPath);
  db.exec(`
    PRAGMA journal_mode = WAL;
    PRAGMA foreign_keys = ON;
    CREATE TABLE IF NOT EXISTS searches (
      id INTEGER PRIMARY KEY,
      name TEXT NOT NULL,
      params TEXT NOT NULL,
      recurring INTEGER NOT NULL DEFAULT 0,
      interval_days INTEGER NOT NULL DEFAULT 7,
      created_at TEXT NOT NULL DEFAULT (datetime('now')),
      last_run_at TEXT
    );
    CREATE TABLE IF NOT EXISTS scans (
      id INTEGER PRIMARY KEY,
      search_id INTEGER NOT NULL REFERENCES searches(id) ON DELETE CASCADE,
      status TEXT NOT NULL DEFAULT 'queued',
      progress TEXT NOT NULL DEFAULT '{}',
      error TEXT,
      started_at TEXT NOT NULL DEFAULT (datetime('now')),
      finished_at TEXT
    );
    CREATE TABLE IF NOT EXISTS stores (
      id INTEGER PRIMARY KEY,
      domain TEXT NOT NULL UNIQUE,
      region TEXT,
      industry TEXT,
      first_seen TEXT NOT NULL DEFAULT (datetime('now'))
    );
    CREATE TABLE IF NOT EXISTS audits (
      id INTEGER PRIMARY KEY,
      store_id INTEGER NOT NULL REFERENCES stores(id) ON DELETE CASCADE,
      scan_id INTEGER REFERENCES scans(id) ON DELETE SET NULL,
      created_at TEXT NOT NULL DEFAULT (datetime('now')),
      health INTEGER NOT NULL,
      categories TEXT NOT NULL,
      revenue_at_risk INTEGER NOT NULL,
      baseline_revenue INTEGER NOT NULL,
      main_signal TEXT,
      signals TEXT NOT NULL,
      findings TEXT NOT NULL,
      facts TEXT NOT NULL
    );
    CREATE INDEX IF NOT EXISTS audits_store ON audits(store_id, id);
    CREATE TABLE IF NOT EXISTS search_leads (
      search_id INTEGER NOT NULL REFERENCES searches(id) ON DELETE CASCADE,
      store_id INTEGER NOT NULL REFERENCES stores(id) ON DELETE CASCADE,
      audit_id INTEGER REFERENCES audits(id) ON DELETE SET NULL,
      qualified INTEGER NOT NULL DEFAULT 0,
      PRIMARY KEY (search_id, store_id)
    );
    CREATE TABLE IF NOT EXISTS usage (
      month TEXT PRIMARY KEY,
      audits INTEGER NOT NULL DEFAULT 0
    );
    CREATE TABLE IF NOT EXISTS http_cache (
      key TEXT PRIMARY KEY,
      value TEXT NOT NULL,
      expires_at INTEGER NOT NULL
    );
  `);
  return db;
}

export const month = () => new Date().toISOString().slice(0, 7);

export function auditsLeft() {
  const row = getDb().prepare('SELECT audits FROM usage WHERE month = ?').get(month());
  return Math.max(0, config.monthlyQuota - (row?.audits ?? 0));
}

export function consumeAudit() {
  getDb().prepare(`INSERT INTO usage (month, audits) VALUES (?, 1)
    ON CONFLICT(month) DO UPDATE SET audits = audits + 1`).run(month());
}

export function cacheGet(key) {
  const row = getDb().prepare('SELECT value, expires_at FROM http_cache WHERE key = ?').get(key);
  if (!row || row.expires_at < Date.now()) return undefined;
  return JSON.parse(row.value);
}

export function cacheSet(key, value, ttlMs) {
  getDb().prepare('INSERT OR REPLACE INTO http_cache (key, value, expires_at) VALUES (?, ?, ?)')
    .run(key, JSON.stringify(value), Date.now() + ttlMs);
}

export async function cached(key, ttlMs, fn) {
  const hit = cacheGet(key);
  if (hit !== undefined) return hit;
  const value = await fn();
  if (value !== undefined) cacheSet(key, value, ttlMs);
  return value;
}
