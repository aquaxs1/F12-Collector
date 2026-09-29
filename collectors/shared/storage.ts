// Storage (same for Chrome & Firefox): cookies incl. HttpOnly via the cookies API,
// local/sessionStorage, IndexedDB and Cache Storage from the content script.
import type { Collector } from '@/lib/context';
import { base64ToBytes, errMsg } from '@/lib/fetcher';
import { PathAllocator, isHttpUrl, sanitizeSegment, urlToPath } from '@/lib/paths';
import { REDACTED, isSensitiveHeader, redactDeep, redactRecord } from '@/lib/redact';
import { browser } from 'wxt/browser';
import type { CollectorResult } from '@/lib/types';

async function getCookies(urls: string[], storeId: string | undefined, topUrl: string, warnings: string[]) {
  const all = new Map<string, any>();
  const add = (list: any[]) => {
    for (const c of list) all.set(`${c.name}|${c.domain}|${c.path}|${JSON.stringify(c.partitionKey ?? null)}|${c.storeId ?? ''}`, c);
  };
  for (const url of urls) {
    const base: Record<string, unknown> = { url };
    if (storeId) base.storeId = storeId;
    try {
      add(await browser.cookies.getAll(base as any));
    } catch (e) {
      // Firefox with first-party isolation requires firstPartyDomain
      try {
        add(await browser.cookies.getAll({ ...base, firstPartyDomain: null } as any));
      } catch {
        warnings.push(`Cookies for ${url}: ${errMsg(e)}`);
      }
    }
    // Partitioned cookies (CHIPS)
    try {
      const topLevelSite = new URL(topUrl).origin;
      add(await browser.cookies.getAll({ ...base, partitionKey: { topLevelSite } } as any));
    } catch {
      /* older browsers */
    }
  }
  return Array.from(all.values());
}

export const collectStorage: Collector = async (ctx) => {
  const result: CollectorResult = { files: {}, warnings: [] };
  const redact = ctx.settings.redact;
  const alloc = new PathAllocator();

  // Cookies
  ctx.detail('Cookies');
  const urls = Array.from(new Set([ctx.url, ...ctx.frames.map((f) => f.url)].filter(isHttpUrl)));
  const cookies = await getCookies(urls, ctx.cookieStoreId, ctx.url, result.warnings);
  result.files['storage/cookies.json'] = JSON.stringify(
    cookies.map((c) => ({ ...c, value: redact ? REDACTED : c.value })),
    null,
    2,
  );

  // Web storage per origin
  ctx.detail('local/sessionStorage, IndexedDB, Cache Storage');
  const local: Record<string, unknown> = {};
  const session: Record<string, unknown> = {};
  const seenOrigins = new Set<string>();
  const idbIndex: { origin: string; database: string; version: number; file: string; stores: { name: string; count: number; exported: number }[] }[] = [];
  const cacheIndex: unknown[] = [];

  for (const f of ctx.frames) {
    if (!f.storage) {
      if (f.errors.length) result.warnings.push(`Frame ${f.url}: ${f.errors.join('; ')}`);
      continue;
    }
    const origin = f.origin && f.origin !== 'null' ? f.origin : `${f.url} (opaque origin)`;
    if (seenOrigins.has(origin)) continue;
    seenOrigins.add(origin);
    const s = f.storage;
    const fix = (v: any) => ('__error' in v ? v : redact ? redactRecord(v) : v);
    local[origin] = fix(s.local);
    session[origin] = fix(s.session);
    const originDir = sanitizeSegment(origin.replace(/^https?:\/\//, '').replace(/:/g, '_'));

    if (Array.isArray(s.indexedDB)) {
      for (const db of s.indexedDB) {
        const file = alloc.allocate(`storage/indexeddb/${originDir}/${sanitizeSegment(db.name)}.json`);
        const data = redact ? { ...db, stores: db.stores.map((st) => ({ ...st, records: redactDeep(st.records) })) } : db;
        result.files[file] = JSON.stringify(data, null, 2);
        idbIndex.push({
          origin,
          database: db.name,
          version: db.version,
          file: file.replace(/^storage\/indexeddb\//, ''),
          stores: db.stores.map((st) => ({ name: st.name, count: st.count, exported: st.records.length })),
        });
        if (db.error) result.warnings.push(`IndexedDB "${db.name}" (${origin}): ${db.error}`);
        if (db.stores.some((st) => st.truncated))
          result.warnings.push(`IndexedDB "${db.name}" (${origin}): not all records exported (limit ${ctx.settings.indexedDbMaxRecords} per store).`);
      }
    } else result.warnings.push(`IndexedDB (${origin}): ${s.indexedDB.__error}`);

    if (Array.isArray(s.cache)) {
      for (const cache of s.cache) {
        const dir = `storage/cache/${originDir}/${sanitizeSegment(cache.name)}`;
        const entries = cache.entries.map((e) => {
          let file: string | undefined;
          if (e.body !== undefined) {
            file = alloc.allocate(urlToPath(e.url, `${dir}/files`));
            result.files[file] = e.encoding === 'base64' ? base64ToBytes(e.body) : e.body;
          }
          return {
            url: e.url,
            method: e.method,
            status: e.status,
            statusText: e.statusText,
            headers: e.headers.map(([k, v]) => [k, redact && isSensitiveHeader(k) ? REDACTED : v]),
            size: e.size,
            file: file?.slice(dir.length + 1),
            skipped: e.skipped,
          };
        });
        result.files[alloc.allocate(`${dir}/index.json`)] = JSON.stringify({ origin, cache: cache.name, entries, error: cache.error }, null, 2);
        cacheIndex.push({ origin, cache: cache.name, entries: cache.entries.length, dir: dir.replace(/^storage\/cache\//, '') });
        if (cache.error) result.warnings.push(`Cache "${cache.name}" (${origin}): ${cache.error}`);
      }
    } else if (!/not available/.test(s.cache.__error)) result.warnings.push(`Cache Storage (${origin}): ${s.cache.__error}`);
  }

  if (!seenOrigins.size) result.warnings.push('No content script result – local/sessionStorage, IndexedDB and Cache Storage are missing.');
  result.files['storage/local.json'] = JSON.stringify(local, null, 2);
  result.files['storage/session.json'] = JSON.stringify(session, null, 2);
  result.files['storage/indexeddb/index.json'] = JSON.stringify(idbIndex, null, 2);
  result.files['storage/cache/index.json'] = JSON.stringify(cacheIndex, null, 2);
  return result;
};
