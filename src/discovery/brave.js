// Brave Search API — https://api-dashboard.search.brave.com
import { config } from '../config.js';
import { apiCall } from '../audit/http.js';

export const isConfigured = () => Boolean(config.braveKey);
// Brave has no inurl: operator, so these rely on page text plus site:/country targeting.
export const supportsInurl = false;

export async function search(q, { gl, page = 0 }) {
  const params = new URLSearchParams({ q, count: '20', offset: String(page), safesearch: 'off' });
  if (gl) params.set('country', gl.toUpperCase());
  const r = await apiCall(`${config.api.brave}/res/v1/web/search?${params}`, {
    headers: { 'x-subscription-token': config.braveKey, 'accept-encoding': 'gzip' },
  });
  if (!r.ok) return { error: r, urls: [] };
  return { urls: (r.data?.web?.results || []).map((x) => x.url) };
}
