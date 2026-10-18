// Google Programmable Search (Custom Search JSON API) — 10 results per call.
import { config } from '../config.js';
import { apiJson } from '../audit/http.js';

export const isConfigured = () => Boolean(config.googleCseKey && config.googleCseCx);

export async function search(q, { gl, page = 0 }) {
  const params = new URLSearchParams({ key: config.googleCseKey, cx: config.googleCseCx, q, num: '10', start: String(page * 10 + 1) });
  if (gl) params.set('gl', gl);
  const d = await apiJson(`https://www.googleapis.com/customsearch/v1?${params}`);
  return { urls: (d?.items || []).map((r) => r.link) };
}
