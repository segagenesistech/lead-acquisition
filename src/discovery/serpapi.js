// SerpApi (Google results) — https://serpapi.com
import { config } from '../config.js';
import { apiCall } from '../audit/http.js';

export const isConfigured = () => Boolean(config.serpapiKey);
export const supportsInurl = true;

export async function search(q, { gl, page = 0 }) {
  const params = new URLSearchParams({ engine: 'google', q, num: '20', start: String(page * 20), api_key: config.serpapiKey });
  if (gl) params.set('gl', gl);
  const r = await apiCall(`https://serpapi.com/search.json?${params}`);
  // SerpApi reports some failures (bad key, out of credits) as a 200 with an "error" field.
  if (!r.ok || (r.data?.error && !/hasn't returned any results/i.test(r.data.error))) return { error: { ...r, ok: false, text: r.data?.error || r.text }, urls: [] };
  return { urls: (r.data?.organic_results || []).map((x) => x.link) };
}
