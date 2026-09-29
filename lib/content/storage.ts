// Web storage of a frame: localStorage, sessionStorage, IndexedDB, Cache Storage.
import type { CacheDump, IndexedDbDump } from '../types';
import { bytesToBase64, errText, toJsonSafe } from './util';

function readWebStorage(get: () => Storage): Record<string, string> | { __error: string } {
  try {
    const s = get();
    const out: Record<string, string> = {};
    for (let i = 0; i < s.length; i++) {
      const k = s.key(i);
      if (k !== null) out[k] = s.getItem(k) ?? '';
    }
    return out;
  } catch (e) {
    return { __error: errText(e) };
  }
}

function req<T>(r: IDBRequest<T>): Promise<T> {
  return new Promise((resolve, reject) => {
    r.onsuccess = () => resolve(r.result);
    r.onerror = () => reject(r.error);
  });
}

function openDb(name: string): Promise<IDBDatabase> {
  return new Promise((resolve, reject) => {
    const r = indexedDB.open(name);
    // If the DB does not exist (anymore), do not create it
    r.onupgradeneeded = () => r.transaction?.abort();
    r.onsuccess = () => resolve(r.result);
    r.onerror = () => reject(r.error ?? new Error('open failed'));
    r.onblocked = () => reject(new Error('blocked'));
  });
}

async function dumpDb(name: string, maxRecords: number): Promise<IndexedDbDump> {
  const db = await openDb(name);
  const dump: IndexedDbDump = { name, version: db.version, stores: [] };
  try {
    for (const storeName of Array.from(db.objectStoreNames)) {
      const tx = db.transaction(storeName, 'readonly');
      const store = tx.objectStore(storeName);
      const count = await req(store.count());
      const records: { key: unknown; value: unknown }[] = [];
      if (maxRecords > 0) {
        await new Promise<void>((resolve, reject) => {
          const cur = store.openCursor();
          cur.onsuccess = () => {
            const c = cur.result;
            if (!c || records.length >= maxRecords) return resolve();
            records.push({ key: toJsonSafe(c.key), value: toJsonSafe(c.value) });
            c.continue();
          };
          cur.onerror = () => reject(cur.error);
        });
      }
      dump.stores.push({
        name: storeName,
        keyPath: store.keyPath,
        autoIncrement: store.autoIncrement,
        indexes: Array.from(store.indexNames).map((n) => {
          const i = store.index(n);
          return { name: n, keyPath: i.keyPath, unique: i.unique, multiEntry: i.multiEntry };
        }),
        count,
        truncated: count > records.length,
        records,
      });
    }
  } finally {
    db.close();
  }
  return dump;
}

async function readIndexedDb(maxRecords: number): Promise<IndexedDbDump[] | { __error: string }> {
  try {
    if (typeof indexedDB === 'undefined') return { __error: 'IndexedDB not available' };
    if (typeof indexedDB.databases !== 'function') return { __error: 'indexedDB.databases() is not supported' };
    const list = await indexedDB.databases();
    const out: IndexedDbDump[] = [];
    for (const info of list) {
      if (!info.name) continue;
      try {
        out.push(await dumpDb(info.name, maxRecords));
      } catch (e) {
        out.push({ name: info.name, version: info.version ?? 0, stores: [], error: errText(e) });
      }
    }
    return out;
  } catch (e) {
    return { __error: errText(e) };
  }
}

const TEXTY = /^(text\/|application\/(json|javascript|xml|x-javascript|manifest\+json)|image\/svg)|\+json|\+xml/i;

async function readCaches(maxBodyBytes: number): Promise<CacheDump[] | { __error: string }> {
  try {
    if (typeof caches === 'undefined') return { __error: 'Cache Storage not available (not a secure context?)' };
    const names = await caches.keys();
    const out: CacheDump[] = [];
    let totalBodies = 0;
    const totalLimit = Math.max(maxBodyBytes * 5, 50 * 1024 * 1024);
    for (const name of names) {
      const dump: CacheDump = { name, entries: [] };
      try {
        const cache = await caches.open(name);
        const requests = await cache.keys();
        for (const request of requests.slice(0, 2000)) {
          const res = await cache.match(request);
          if (!res) continue;
          const headers: [string, string][] = [];
          res.headers.forEach((v, k) => headers.push([k, v]));
          const entry: CacheDump['entries'][number] = {
            url: request.url,
            method: request.method,
            status: res.status,
            statusText: res.statusText,
            headers,
            size: 0,
          };
          try {
            const blob = await res.blob();
            entry.size = blob.size;
            if (blob.size > maxBodyBytes) entry.skipped = 'larger than limit';
            else if (totalBodies + blob.size > totalLimit) entry.skipped = 'total limit for cache bodies reached';
            else {
              totalBodies += blob.size;
              if (TEXTY.test(blob.type || res.headers.get('content-type') || '')) entry.body = await blob.text();
              else {
                entry.body = bytesToBase64(new Uint8Array(await blob.arrayBuffer()));
                entry.encoding = 'base64';
              }
            }
          } catch (e) {
            entry.skipped = 'body not readable: ' + errText(e);
          }
          dump.entries.push(entry);
        }
        if (requests.length > 2000) dump.error = `only the first 2000 of ${requests.length} entries exported`;
      } catch (e) {
        dump.error = errText(e);
      }
      out.push(dump);
    }
    return out;
  } catch (e) {
    return { __error: errText(e) };
  }
}

export async function collectStorage(maxRecords: number, maxBodyBytes: number) {
  return {
    local: readWebStorage(() => window.localStorage),
    session: readWebStorage(() => window.sessionStorage),
    indexedDB: await readIndexedDb(maxRecords),
    cache: await readCaches(maxBodyBytes),
  };
}
