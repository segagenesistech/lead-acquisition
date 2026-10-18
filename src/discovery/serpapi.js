// SerpApi (Google results) — https://serpapi.com
import { config } from '../config.js';
import { apiJson } from '../audit/http.js';

export const isConfigured = () => Boolean(config.serpapiKey);

export async function search(q, { gl, page = 0 }) {
  const params = new URLSearchParams({ engine: 'google', q, num: '20', start: String(page * 20), api_key: config.serpapiKey });
  if (gl) params.set('gl', gl);
  const d = await apiJson(`https://serpapi.com/search.json?${params}`);
  return { urls: (d?.organic_results || []).map((r) => r.link) };
}
