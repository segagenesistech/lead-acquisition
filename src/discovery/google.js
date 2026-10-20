// Google Programmable Search (Custom Search JSON API) — 10 results per call.
import { config } from '../config.js';
import { apiCall } from '../audit/http.js';

export const isConfigured = () => Boolean(config.googleCseKey && config.googleCseCx);
export const supportsInurl = true;

export async function search(q, { gl, page = 0 }) {
  const params = new URLSearchParams({ key: config.googleCseKey, cx: config.googleCseCx, q, num: '10', start: String(page * 10 + 1) });
  if (gl) params.set('gl', gl);
  const r = await apiCall(`https://www.googleapis.com/customsearch/v1?${params}`);
  if (!r.ok) return { error: { ...r, text: r.data?.error?.message || r.text }, urls: [] };
  return { urls: (r.data?.items || []).map((x) => x.link) };
}
