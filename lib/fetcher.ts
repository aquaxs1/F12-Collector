// Ressourcen neu laden (Firefox-Fallback, Source Maps, Cross-Origin-Stylesheets).
// Wird im Background ausgeführt – dort gelten die Host-Permissions, CORS ist kein Problem.

export interface FetchedResource {
  ok: boolean;
  status: number;
  contentType: string;
  bytes?: Uint8Array;
  size: number;
  skippedReason?: string;
  error?: string;
}

export async function fetchResource(url: string, maxBytes: number, timeoutMs = 20000): Promise<FetchedResource> {
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), timeoutMs);
  try {
    const res = await fetch(url, { credentials: 'include', cache: 'force-cache', signal: ctrl.signal, redirect: 'follow' });
    const contentType = res.headers.get('content-type') ?? '';
    const declared = Number(res.headers.get('content-length') ?? NaN);
    if (Number.isFinite(declared) && declared > maxBytes) {
      ctrl.abort();
      return { ok: false, status: res.status, contentType, size: declared, skippedReason: `größer als Limit (${formatBytes(declared)})` };
    }
    const bytes = await readLimited(res, maxBytes);
    if (!bytes) {
      return { ok: false, status: res.status, contentType, size: maxBytes + 1, skippedReason: `größer als Limit (> ${formatBytes(maxBytes)})` };
    }
    return { ok: res.ok, status: res.status, contentType, bytes, size: bytes.byteLength };
  } catch (e) {
    return { ok: false, status: 0, contentType: '', size: 0, error: ctrl.signal.aborted ? 'Timeout' : String((e as Error)?.message ?? e) };
  } finally {
    clearTimeout(timer);
  }
}

async function readLimited(res: Response, maxBytes: number): Promise<Uint8Array | null> {
  if (!res.body) return new Uint8Array(await res.arrayBuffer());
  const reader = res.body.getReader();
  const chunks: Uint8Array[] = [];
  let total = 0;
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    total += value.byteLength;
    if (total > maxBytes) {
      await reader.cancel().catch(() => {});
      return null;
    }
    chunks.push(value);
  }
  return concatBytes(chunks, total);
}

export function concatBytes(chunks: Uint8Array[], total?: number): Uint8Array {
  const size = total ?? chunks.reduce((n, c) => n + c.byteLength, 0);
  const out = new Uint8Array(size);
  let off = 0;
  for (const c of chunks) {
    out.set(c, off);
    off += c.byteLength;
  }
  return out;
}

export function formatBytes(n: number): string {
  if (n < 1024) return `${n} B`;
  if (n < 1024 * 1024) return `${(n / 1024).toFixed(1)} KB`;
  return `${(n / 1024 / 1024).toFixed(1)} MB`;
}

const TEXT_MIME = /^(text\/|application\/(json|javascript|ecmascript|x-javascript|xml|xhtml\+xml|manifest\+json|ld\+json|graphql|x-www-form-urlencoded)|image\/svg\+xml)|\+json|\+xml/i;

export function isTextMime(mime: string): boolean {
  return TEXT_MIME.test(mime);
}

const utf8 = new TextDecoder('utf-8', { fatal: false });
export function decodeUtf8(bytes: Uint8Array): string {
  return utf8.decode(bytes);
}

export function bytesToBase64(bytes: Uint8Array): string {
  let bin = '';
  const step = 0x8000;
  for (let i = 0; i < bytes.length; i += step) bin += String.fromCharCode(...bytes.subarray(i, i + step));
  return btoa(bin);
}

export function base64ToBytes(b64: string): Uint8Array {
  const bin = atob(b64);
  const out = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) out[i] = bin.charCodeAt(i);
  return out;
}

export function byteLength(content: string | Uint8Array): number {
  return typeof content === 'string' ? new TextEncoder().encode(content).byteLength : content.byteLength;
}

export function withTimeout<T>(p: Promise<T>, ms: number, label: string): Promise<T> {
  return new Promise<T>((resolve, reject) => {
    const t = setTimeout(() => reject(new Error(`${label}: Zeitüberschreitung nach ${Math.round(ms / 1000)} s`)), ms);
    p.then(
      (v) => {
        clearTimeout(t);
        resolve(v);
      },
      (e) => {
        clearTimeout(t);
        reject(e);
      },
    );
  });
}

export function errMsg(e: unknown): string {
  if (e instanceof Error) return e.message;
  if (typeof e === 'string') return e;
  try {
    return JSON.stringify(e);
  } catch {
    return String(e);
  }
}

/** Führt fn für alle Elemente mit begrenzter Parallelität aus. */
export async function mapLimit<T, R>(items: T[], limit: number, fn: (item: T, index: number) => Promise<R>): Promise<R[]> {
  const results: R[] = new Array(items.length);
  let next = 0;
  const workers = Array.from({ length: Math.min(limit, items.length) }, async () => {
    while (next < items.length) {
      const i = next++;
      results[i] = await fn(items[i] as T, i);
    }
  });
  await Promise.all(workers);
  return results;
}
