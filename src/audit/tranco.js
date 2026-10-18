// Optional traffic proxy: drop the Tranco top-1M list (https://tranco-list.eu) at data/tranco.csv ("rank,domain").
import { existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { ROOT } from '../config.js';

let ranks;

export function trancoRank(domain) {
  if (ranks === undefined) {
    ranks = null;
    const file = join(ROOT, 'data', 'tranco.csv');
    if (existsSync(file)) {
      ranks = new Map();
      for (const line of readFileSync(file, 'utf8').split('\n')) {
        const i = line.indexOf(',');
        if (i > 0) ranks.set(line.slice(i + 1).trim(), Number(line.slice(0, i)));
      }
    }
  }
  return ranks?.get(domain.replace(/^www\./, '')) ?? null;
}
