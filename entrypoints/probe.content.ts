// MAIN-world probe, injected at document_start in every frame. It passively buffers what can
// only be seen from inside the page and from the very start of its lifetime:
//   - console.* calls, window errors and unhandled promise rejections
//   - WebSocket and EventSource connections + their frames/messages
//   - Web Vitals (LCP, CLS, INP, FCP, TTFB) and long tasks via PerformanceObserver
//   - the baseline set of window keys (to later diff the page's own globals)
//
// It never sends anything anywhere; the background reads the buffers on demand via
// scripting.executeScript (world: MAIN). Everything is capped and wrapped in try/catch so a
// broken page can never break the probe (and the probe never breaks the page).
export default defineContentScript({
  matches: ['<all_urls>'],
  allFrames: true,
  matchAboutBlank: true,
  runAt: 'document_start',
  world: 'MAIN',
  main() {
    try {
      install();
    } catch {
      /* never break the page */
    }
  },
});

const KEY = '__F12C_PROBE__';
const MAX_CONSOLE = 1000;
const MAX_ERRORS = 300;
const MAX_WS = 60;
const MAX_WS_FRAMES = 400;
const MAX_TEXT = 8000;

interface Probe {
  installedAtDocumentStart: boolean;
  baseline: Set<string>;
  console: any[];
  consoleDropped: number;
  errors: any[];
  ws: any[];
  wsDropped: number;
  vitals: Record<string, number>;
  clsValue: number;
  inpMax: number;
  dump(): unknown;
}

function install() {
  const w = window as any;
  if (w[KEY]) return;

  const p: Probe = {
    installedAtDocumentStart: document.readyState === 'loading',
    baseline: new Set(Object.getOwnPropertyNames(window)),
    console: [],
    consoleDropped: 0,
    errors: [],
    ws: [],
    wsDropped: 0,
    vitals: {},
    clsValue: 0,
    inpMax: 0,
    dump,
  };
  p.baseline.add(KEY);

  // ---- console ----
  const push = (level: string, args: unknown[], stack?: string) => {
    if (p.console.length >= MAX_CONSOLE) {
      p.consoleDropped++;
      return;
    }
    p.console.push({ level, ts: Date.now(), args: args.map(stringify), stack });
  };
  for (const level of ['log', 'info', 'warn', 'error', 'debug', 'trace', 'table', 'assert', 'dir'] as const) {
    const orig = (console as any)[level];
    if (typeof orig !== 'function') continue;
    try {
      (console as any)[level] = function (...args: unknown[]) {
        try {
          push(level, args, level === 'error' || level === 'trace' || level === 'warn' ? new Error().stack : undefined);
        } catch {
          /* ignore */
        }
        return orig.apply(this, args as any);
      };
    } catch {
      /* frozen console */
    }
  }

  // ---- errors ----
  const pushErr = (e: any) => {
    if (p.errors.length >= MAX_ERRORS) return;
    p.errors.push(e);
  };
  window.addEventListener(
    'error',
    (ev: ErrorEvent) => {
      pushErr({
        ts: Date.now(),
        kind: 'error',
        message: String(ev.message ?? (ev.error && ev.error.message) ?? 'error'),
        source: ev.filename,
        line: ev.lineno,
        column: ev.colno,
        stack: ev.error && ev.error.stack ? String(ev.error.stack).slice(0, 4000) : undefined,
      });
    },
    true,
  );
  window.addEventListener('unhandledrejection', (ev: PromiseRejectionEvent) => {
    let message = 'unhandledrejection';
    let stack: string | undefined;
    try {
      const r: any = ev.reason;
      message = r && r.message ? String(r.message) : stringify(r);
      stack = r && r.stack ? String(r.stack).slice(0, 4000) : undefined;
    } catch {
      /* ignore */
    }
    pushErr({ ts: Date.now(), kind: 'unhandledrejection', message, stack });
  });

  // ---- WebSocket ----
  try {
    const NativeWS = window.WebSocket;
    if (NativeWS) {
      const Wrapped: any = function (this: any, url: string, protocols?: string | string[]) {
        const sock = protocols !== undefined ? new NativeWS(url, protocols as any) : new NativeWS(url);
        const conn: any = {
          kind: 'WebSocket',
          url: String(url),
          protocols: protocols ? String(protocols) : undefined,
          openedAt: Date.now(),
          frames: [],
          framesDropped: 0,
        };
        if (p.ws.length < MAX_WS) p.ws.push(conn);
        else p.wsDropped++;
        const addFrame = (dir: string, data: unknown) => {
          if (conn.frames.length >= MAX_WS_FRAMES) {
            conn.framesDropped++;
            return;
          }
          conn.frames.push(frameOf(dir, data));
        };
        sock.addEventListener('message', (ev: MessageEvent) => addFrame('receive', ev.data));
        sock.addEventListener('close', (ev: CloseEvent) => {
          conn.closedAt = Date.now();
          conn.closeCode = ev.code;
          conn.closeReason = ev.reason;
        });
        const origSend = sock.send;
        sock.send = function (data: any) {
          try {
            addFrame('send', data);
          } catch {
            /* ignore */
          }
          return origSend.call(this, data);
        };
        return sock;
      };
      Wrapped.prototype = NativeWS.prototype;
      for (const k of ['CONNECTING', 'OPEN', 'CLOSING', 'CLOSED'] as const) Wrapped[k] = (NativeWS as any)[k];
      window.WebSocket = Wrapped;
    }
  } catch {
    /* ignore */
  }

  // ---- EventSource ----
  try {
    const NativeES = window.EventSource;
    if (NativeES) {
      const Wrapped: any = function (this: any, url: string, init?: EventSourceInit) {
        const es = new NativeES(url, init);
        const conn: any = { kind: 'EventSource', url: String(url), openedAt: Date.now(), frames: [], framesDropped: 0 };
        if (p.ws.length < MAX_WS) p.ws.push(conn);
        else p.wsDropped++;
        es.addEventListener('message', (ev: MessageEvent) => {
          if (conn.frames.length >= MAX_WS_FRAMES) {
            conn.framesDropped++;
            return;
          }
          conn.frames.push(frameOf('receive', ev.data));
        });
        es.addEventListener('error', () => {
          if (es.readyState === 2) conn.closedAt = Date.now();
        });
        return es;
      };
      Wrapped.prototype = NativeES.prototype;
      for (const k of ['CONNECTING', 'OPEN', 'CLOSED'] as const) Wrapped[k] = (NativeES as any)[k];
      window.EventSource = Wrapped;
    }
  } catch {
    /* ignore */
  }

  // ---- Web Vitals ----
  observe('largest-contentful-paint', (e: any) => (p.vitals.lcp = Math.round(e.startTime)), true);
  observe('paint', (e: any) => {
    if (e.name === 'first-contentful-paint') p.vitals.fcp = Math.round(e.startTime);
  });
  observe('layout-shift', (e: any) => {
    if (!e.hadRecentInput) {
      p.clsValue += e.value;
      p.vitals.cls = Math.round(p.clsValue * 1000) / 1000;
    }
  });
  observe('event', (e: any) => {
    const d = e.duration ?? 0;
    if (d > p.inpMax) {
      p.inpMax = d;
      p.vitals.inp = Math.round(d);
    }
  });
  observe('first-input', (e: any) => {
    const d = (e.processingStart ?? e.startTime) - e.startTime;
    if (p.vitals.inp === undefined) p.vitals.inp = Math.round(d);
  });
  let longTasks = 0;
  let longTotal = 0;
  observe('longtask', (e: any) => {
    longTasks++;
    longTotal += e.duration ?? 0;
    p.vitals.longTasks = longTasks;
    p.vitals.longTaskTotalMs = Math.round(longTotal);
  });

  Object.defineProperty(window, KEY, { value: p, configurable: true, enumerable: false, writable: false });

  function dump() {
    let navigation: Record<string, number> | undefined;
    try {
      const nav = performance.getEntriesByType('navigation')[0] as any;
      if (nav) {
        p.vitals.ttfb = Math.round(nav.responseStart);
        navigation = {
          type: nav.type,
          startTime: Math.round(nav.startTime),
          domContentLoaded: Math.round(nav.domContentLoadedEventEnd),
          loadEvent: Math.round(nav.loadEventEnd),
          responseStart: Math.round(nav.responseStart),
          transferSize: nav.transferSize,
          decodedBodySize: nav.decodedBodySize,
        } as any;
      }
    } catch {
      /* ignore */
    }
    return {
      installedAtDocumentStart: p.installedAtDocumentStart,
      console: p.console,
      consoleDropped: p.consoleDropped,
      errors: p.errors,
      ws: p.ws,
      wsDropped: p.wsDropped,
      vitals: p.vitals,
      globals: readGlobals(p.baseline),
      navigation,
    };
  }

  function observe(type: string, cb: (e: any) => void, buffered = true) {
    try {
      new PerformanceObserver((list) => {
        for (const e of list.getEntries()) {
          try {
            cb(e);
          } catch {
            /* ignore */
          }
        }
      }).observe({ type, buffered } as any);
    } catch {
      /* unsupported entry type */
    }
  }
}

function frameOf(dir: string, data: unknown) {
  const f: any = { ts: Date.now(), dir };
  try {
    if (typeof data === 'string') {
      f.opcode = 'text';
      f.text = data.length > MAX_TEXT ? (f.truncated = true) && data.slice(0, MAX_TEXT) : data;
    } else if (data instanceof ArrayBuffer) {
      f.opcode = 'binary';
      f.binaryByteLength = data.byteLength;
    } else if (data && (data as any).byteLength !== undefined) {
      f.opcode = 'binary';
      f.binaryByteLength = (data as any).byteLength;
    } else if (data && typeof (data as any).size === 'number') {
      f.opcode = 'binary';
      f.binaryByteLength = (data as any).size;
    } else {
      f.opcode = 'text';
      f.text = stringify(data);
    }
  } catch {
    f.opcode = 'unknown';
  }
  return f;
}

function readGlobals(baseline: Set<string>): any[] {
  const out: any[] = [];
  let names: string[] = [];
  try {
    names = Object.getOwnPropertyNames(window);
  } catch {
    return out;
  }
  for (const name of names) {
    if (baseline.has(name) || name === KEY) continue;
    if (/^(webkit|moz|ms|chrome)[A-Z]/.test(name)) continue; // vendor noise
    let type = 'unknown';
    let preview: string | undefined;
    try {
      const v = (window as any)[name];
      type = v === null ? 'null' : Array.isArray(v) ? 'array' : typeof v;
      preview = previewOf(v);
    } catch {
      type = 'getter-threw';
    }
    out.push({ name, type, preview });
    if (out.length >= 2000) break;
  }
  return out;
}

function previewOf(v: unknown): string | undefined {
  try {
    if (v === null || v === undefined) return String(v);
    const t = typeof v;
    if (t === 'function') return `function ${(v as any).name || ''}`.trim() + '()';
    if (t === 'string') return (v as string).length > 200 ? (v as string).slice(0, 200) + '…' : (v as string);
    if (t === 'number' || t === 'boolean' || t === 'bigint') return String(v);
    if (Array.isArray(v)) return `Array(${(v as unknown[]).length})`;
    if (t === 'object') {
      const ctor = (v as any).constructor && (v as any).constructor.name;
      const keys = Object.keys(v as object).slice(0, 12);
      return `${ctor && ctor !== 'Object' ? ctor + ' ' : ''}{${keys.join(', ')}${Object.keys(v as object).length > 12 ? ', …' : ''}}`;
    }
  } catch {
    return '[unreadable]';
  }
  return undefined;
}

function stringify(v: unknown, depth = 0): string {
  try {
    if (v === null) return 'null';
    if (v === undefined) return 'undefined';
    const t = typeof v;
    if (t === 'string') return v as string;
    if (t === 'number' || t === 'boolean' || t === 'bigint') return String(v);
    if (t === 'function') return `ƒ ${(v as any).name || 'anonymous'}()`;
    if (t === 'symbol') return String(v);
    if (v instanceof Error) return `${v.name}: ${v.message}`;
    if (typeof Node !== 'undefined' && v instanceof Node) {
      const el = v as any;
      return el.tagName ? `<${el.tagName.toLowerCase()}${el.id ? '#' + el.id : ''}>` : `#node(${(v as Node).nodeName})`;
    }
    if (depth > 3) return '[…]';
    if (Array.isArray(v)) return '[' + (v as unknown[]).slice(0, 50).map((x) => stringify(x, depth + 1)).join(', ') + ((v as unknown[]).length > 50 ? ', …' : '') + ']';
    if (t === 'object') {
      const seen = JSON.stringify(v, (_k, val) => (typeof val === 'bigint' ? String(val) : val));
      if (seen && seen.length <= MAX_TEXT) return seen;
      const keys = Object.keys(v as object).slice(0, 30);
      return '{' + keys.map((k) => `${k}: ${stringify((v as any)[k], depth + 1)}`).join(', ') + '}';
    }
    return String(v);
  } catch {
    return '[unserializable]';
  }
}
