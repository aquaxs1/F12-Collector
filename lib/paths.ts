// Hilfsfunktionen, um URLs in sichere, eindeutige Pfade im ZIP umzuwandeln.

const ILLEGAL = /[<>:"|?*\\\u0000-\u001f]/g;

export function sanitizeSegment(seg: string): string {
  let s = seg;
  try {
    s = decodeURIComponent(seg);
  } catch {
    /* ignore */
  }
  s = s.replace(ILLEGAL, '_').replace(/\//g, '_').trim();
  if (s === '' || s === '.' || s === '..') s = '_';
  if (s.length > 120) s = s.slice(0, 100) + '~' + shortHash(s);
  return s;
}

export function sanitizePath(path: string): string {
  return path
    .split('/')
    .filter((p) => p.length > 0)
    .map(sanitizeSegment)
    .join('/');
}

/** Kurzer, stabiler Hash (FNV-1a) für Dateinamen. */
export function shortHash(input: string): string {
  let h = 0x811c9dc5;
  for (let i = 0; i < input.length; i++) {
    h ^= input.charCodeAt(i);
    h = Math.imul(h, 0x01000193);
  }
  return (h >>> 0).toString(36);
}

function insertBeforeExt(path: string, suffix: string): string {
  const slash = path.lastIndexOf('/');
  const dot = path.lastIndexOf('.');
  if (dot > slash + 1) return path.slice(0, dot) + suffix + path.slice(dot);
  return path + suffix;
}

/**
 * Wandelt eine URL in einen Pfad um: https://example.com/js/app.js?v=1
 * → <prefix>/example.com/js/app_<hash>.js
 */
export function urlToPath(url: string, prefix: string, defaultExt = ''): string {
  let u: URL;
  try {
    u = new URL(url);
  } catch {
    return `${prefix}/_invalid/${sanitizeSegment(url)}`;
  }
  const host = u.protocol === 'file:' ? '_file' : sanitizeSegment(u.host || u.protocol.replace(':', ''));
  let path = u.pathname || '/';
  if (path.endsWith('/')) path += 'index' + (defaultExt || '.html');
  if (u.search) path = insertBeforeExt(path, '_' + shortHash(u.search));
  const lastSeg = path.split('/').pop() ?? '';
  if (defaultExt && !lastSeg.includes('.')) path += defaultExt;
  return `${prefix}/${host}/${sanitizePath(path)}`;
}

/** Hält vergebene Pfade fest und hängt bei Kollisionen ~2, ~3 … an. */
export class PathAllocator {
  private used = new Set<string>();
  constructor(existing: Iterable<string> = []) {
    for (const p of existing) this.used.add(p.toLowerCase());
  }
  allocate(path: string): string {
    let candidate = path;
    let i = 2;
    while (this.used.has(candidate.toLowerCase())) candidate = insertBeforeExt(path, `~${i++}`);
    this.used.add(candidate.toLowerCase());
    return candidate;
  }
  has(path: string) {
    return this.used.has(path.toLowerCase());
  }
}

export function hostOf(url: string): string {
  try {
    return new URL(url).hostname || 'unbekannt';
  } catch {
    return 'unbekannt';
  }
}

export function timestampForFile(d: Date): string {
  const p = (n: number) => String(n).padStart(2, '0');
  return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())}_${p(d.getHours())}-${p(d.getMinutes())}-${p(d.getSeconds())}`;
}

export function isHttpUrl(url: string | undefined): url is string {
  return !!url && /^https?:\/\//i.test(url);
}

/** URL ohne #fragment */
export function stripHash(url: string): string {
  const i = url.indexOf('#');
  return i < 0 ? url : url.slice(0, i);
}
