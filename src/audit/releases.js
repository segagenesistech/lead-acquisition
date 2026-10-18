import { config } from '../config.js';
import { cached } from '../db.js';
import { apiJson } from './http.js';
import { compareVersions } from './detect.js';

/** Number of x.y feature releases between `current` and the latest release on wordpress.org. */
export async function pluginReleasesBehind(slug, current) {
  const versions = await cached(`wp:versions:${slug}`, 12 * 3600e3, async () => {
    const d = await apiJson(`${config.api.wporg}/plugins/info/1.2/?action=plugin_information&request[slug]=${slug}&request[fields][versions]=1&request[fields][sections]=0`);
    return d?.versions ? Object.keys(d.versions).filter((v) => /^\d+\.\d+(\.\d+)?$/.test(v)) : undefined;
  });
  if (!versions) return null;
  return countReleasesBehind(versions, current);
}

export function countReleasesBehind(versions, current) {
  const minor = (v) => v.split('.').slice(0, 2).join('.');
  const cur = minor(current);
  return new Set(versions.map(minor).filter((m) => compareVersions(m, cur) > 0)).size;
}
