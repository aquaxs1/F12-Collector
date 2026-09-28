// Helpers for the content script.

/** Short CSS path to an element, e.g. "main > div.card:nth-of-type(2) > h2". */
export function cssPath(el: Element): string {
  const parts: string[] = [];
  let cur: Element | null = el;
  let depth = 0;
  while (cur && cur.nodeType === Node.ELEMENT_NODE && depth < 12) {
    const tag = cur.localName;
    if (cur.id && /^[A-Za-z][\w-]*$/.test(cur.id)) {
      parts.unshift(`${tag}#${cur.id}`);
      break;
    }
    let part = tag;
    const cls = Array.from(cur.classList)
      .filter((c) => /^[A-Za-z_-][\w-]*$/.test(c))
      .slice(0, 2);
    if (cls.length) part += '.' + cls.join('.');
    const parent: Element | null = cur.parentElement;
    if (parent) {
      const same = Array.from(parent.children).filter((c) => c.localName === tag);
      if (same.length > 1) part += `:nth-of-type(${same.indexOf(cur) + 1})`;
    }
    parts.unshift(part);
    const root = cur.getRootNode();
    if (!parent && root instanceof ShadowRoot) {
      parts.unshift('::shadow-root');
      cur = root.host;
    } else {
      cur = parent;
    }
    depth++;
  }
  return parts.join(' > ');
}

/** Also returns closed shadow roots where the browser allows content scripts to access them. */
export function getShadowRoot(el: Element): ShadowRoot | null {
  try {
    const c = (globalThis as any).chrome;
    if (c?.dom?.openOrClosedShadowRoot) return c.dom.openOrClosedShadowRoot(el) ?? null;
  } catch {
    /* ignore */
  }
  const anyEl = el as any;
  if ('openOrClosedShadowRoot' in anyEl) {
    try {
      return anyEl.openOrClosedShadowRoot ?? null; // Firefox
    } catch {
      /* ignore */
    }
  }
  return el.shadowRoot;
}

export function errText(e: unknown): string {
  return e instanceof Error ? e.message : String(e);
}

export function bytesToBase64(bytes: Uint8Array): string {
  let bin = '';
  const step = 0x8000;
  for (let i = 0; i < bytes.length; i += step) bin += String.fromCharCode(...bytes.subarray(i, i + step));
  return btoa(bin);
}

/** Converts arbitrary (structured-clone) values into JSON-friendly values. */
export function toJsonSafe(value: unknown, depth = 0, seen = new WeakSet<object>()): unknown {
  if (value === null || value === undefined) return value ?? null;
  const t = typeof value;
  if (t === 'string' || t === 'boolean') return value;
  if (t === 'number') return Number.isFinite(value as number) ? value : String(value);
  if (t === 'bigint') return { __type: 'BigInt', value: String(value) };
  if (t !== 'object') return String(value);
  if (depth > 30) return '[nested too deeply]';
  const obj = value as object;
  if (seen.has(obj)) return '[circular]';
  seen.add(obj);
  if (obj instanceof Date) return { __type: 'Date', value: isNaN(obj.getTime()) ? 'Invalid Date' : obj.toISOString() };
  if (obj instanceof RegExp) return { __type: 'RegExp', value: String(obj) };
  if (obj instanceof ArrayBuffer || ArrayBuffer.isView(obj)) {
    const bytes =
      obj instanceof ArrayBuffer ? new Uint8Array(obj) : new Uint8Array(obj.buffer, obj.byteOffset, obj.byteLength);
    return {
      __type: obj.constructor?.name ?? 'Binary',
      byteLength: bytes.byteLength,
      base64: bytes.byteLength <= 65536 ? bytesToBase64(bytes) : undefined,
    };
  }
  if (typeof Blob !== 'undefined' && obj instanceof Blob)
    return { __type: obj instanceof File ? 'File' : 'Blob', size: obj.size, type: obj.type, name: (obj as File).name };
  if (obj instanceof Map)
    return { __type: 'Map', entries: Array.from(obj.entries()).map(([k, v]) => [toJsonSafe(k, depth + 1, seen), toJsonSafe(v, depth + 1, seen)]) };
  if (obj instanceof Set) return { __type: 'Set', values: Array.from(obj.values()).map((v) => toJsonSafe(v, depth + 1, seen)) };
  if (Array.isArray(obj)) return obj.map((v) => toJsonSafe(v, depth + 1, seen));
  const out: Record<string, unknown> = {};
  for (const [k, v] of Object.entries(obj)) out[k] = toJsonSafe(v, depth + 1, seen);
  return out;
}
