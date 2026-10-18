import http from 'node:http';
import https from 'node:https';
import tls from 'node:tls';
import zlib from 'node:zlib';
import { config } from '../config.js';

const MAX_BYTES = 3 * 1024 * 1024;

function target(url) {
  const u = new URL(url);
  const override = config.hostOverrides[u.hostname];
  const isHttps = u.protocol === 'https:';
  if (!override) return { u, isHttps, host: u.hostname, port: u.port || (isHttps ? 443 : 80) };
  const port = isHttps ? override.https : override.http;
  return { u, isHttps, host: '127.0.0.1', port, servername: u.hostname };
}

function decode(buf, encoding) {
  try {
    if (encoding === 'gzip') return zlib.gunzipSync(buf);
    if (encoding === 'br') return zlib.brotliDecompressSync(buf);
    if (encoding === 'deflate') return zlib.inflateSync(buf);
  } catch { /* fall through with raw bytes */ }
  return buf;
}

export class CookieJar {
  constructor() { this.cookies = new Map(); }
  store(setCookie) {
    for (const c of [].concat(setCookie || [])) {
      const [pair] = c.split(';');
      const i = pair.indexOf('=');
      if (i > 0) this.cookies.set(pair.slice(0, i).trim(), pair.slice(i + 1).trim());
    }
  }
  header() { return [...this.cookies].map(([k, v]) => `${k}=${v}`).join('; '); }
}

function once(url, { method = 'GET', headers = {}, body, timeout = 15000, jar } = {}) {
  return new Promise((resolve) => {
    let t;
    try { t = target(url); } catch (e) { return resolve({ error: 'BAD_URL', message: e.message }); }
    const started = Date.now();
    const lib = t.isHttps ? https : http;
    const reqHeaders = {
      'user-agent': config.userAgent,
      accept: 'text/html,application/json;q=0.9,*/*;q=0.8',
      'accept-encoding': 'gzip, deflate, br',
      host: t.u.host,
      ...headers,
    };
    if (jar?.cookies.size) reqHeaders.cookie = jar.header();
    if (body) reqHeaders['content-length'] = Buffer.byteLength(body);
    const req = lib.request({
      host: t.host, port: t.port, path: t.u.pathname + t.u.search, method, headers: reqHeaders,
      // We still want to read sites with broken certificates; certificate health is reported separately.
      rejectUnauthorized: false, servername: t.servername || t.u.hostname, timeout,
    }, (res) => {
      const ttfb = Date.now() - started;
      const chunks = [];
      let size = 0;
      res.on('data', (c) => { size += c.length; if (size <= MAX_BYTES) chunks.push(c); else res.destroy(); });
      const done = () => {
        jar?.store(res.headers['set-cookie']);
        const raw = decode(Buffer.concat(chunks), res.headers['content-encoding']);
        resolve({
          url, status: res.statusCode, headers: res.headers, body: raw.toString('utf8'),
          ttfb, total: Date.now() - started, bytes: size,
          tls: t.isHttps ? { authorized: res.socket?.authorized, error: res.socket?.authorizationError || null } : null,
        });
      };
      res.on('end', done);
      res.on('close', done);
    });
    req.on('timeout', () => req.destroy(Object.assign(new Error('timeout'), { code: 'TIMEOUT' })));
    req.on('error', (e) => resolve({ url, error: e.code || 'ERROR', message: e.message }));
    if (body) req.write(body);
    req.end();
  });
}

/** Fetch a page on a target site, following redirects. Never throws. */
export async function request(url, opts = {}) {
  const chain = [];
  let current = url;
  for (let i = 0; i <= (opts.maxRedirects ?? 5); i++) {
    const res = await once(current, opts);
    chain.push(current);
    if (res.error || res.status < 300 || res.status >= 400 || !res.headers.location) {
      return { ...res, finalUrl: current, redirects: chain.slice(0, -1) };
    }
    current = new URL(res.headers.location, current).toString();
    if (opts.method && opts.method !== 'GET' && opts.method !== 'HEAD') opts = { ...opts, method: 'GET', body: undefined };
  }
  return { error: 'TOO_MANY_REDIRECTS', finalUrl: current, redirects: chain };
}

/** Inspect the TLS certificate served on :443. */
export function inspectCertificate(hostname, timeout = 10000) {
  return new Promise((resolve) => {
    const o = config.hostOverrides[hostname];
    const socket = tls.connect({
      host: o ? '127.0.0.1' : hostname, port: o ? o.https : 443, servername: hostname,
      rejectUnauthorized: false, timeout,
    }, () => {
      const cert = socket.getPeerCertificate();
      socket.end();
      resolve({
        reachable: true,
        authorized: socket.authorized,
        error: socket.authorizationError ? String(socket.authorizationError) : null,
        validFrom: cert?.valid_from ? new Date(cert.valid_from).toISOString() : null,
        validTo: cert?.valid_to ? new Date(cert.valid_to).toISOString() : null,
        issuer: cert?.issuer?.O || cert?.issuer?.CN || null,
        subject: cert?.subject?.CN || null,
      });
    });
    socket.on('timeout', () => { socket.destroy(); resolve({ reachable: false, error: 'TIMEOUT' }); });
    socket.on('error', (e) => resolve({ reachable: false, error: e.code || e.message }));
  });
}

/** JSON from a third-party API (wordpress.org, RDAP, PageSpeed…). Returns null on any failure. */
export async function apiJson(url, { headers = {}, timeout = 20000 } = {}) {
  try {
    const res = await fetch(url, { headers: { 'user-agent': config.userAgent, accept: 'application/json', ...headers }, signal: AbortSignal.timeout(timeout) });
    if (!res.ok) return null;
    return await res.json();
  } catch {
    return null;
  }
}
