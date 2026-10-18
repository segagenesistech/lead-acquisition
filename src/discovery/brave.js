// Brave Search API — https://api-dashboard.search.brave.com
import { config } from '../config.js';
import { apiJson } from '../audit/http.js';

export const isConfigured = () => Boolean(config.braveKey);

export async function search(q, { gl, page = 0 }) {
  const params = new URLSearchParams({ q, count: '20', offset: String(page), safesearch: 'off' });
  if (gl) params.set('country', gl.toUpperCase());
  const d = await apiJson(`https://api.search.brave.com/res/v1/web/search?${params}`, {
    headers: { 'x-subscription-token': config.braveKey },
  });
  return { urls: (d?.web?.results || []).map((r) => r.url) };
}
