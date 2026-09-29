// Network recording in Firefox: webRequest events + webRequest.filterResponseData for bodies → HAR 1.2.
import type { JobContext } from '@/lib/context';
import { bytesToBase64, concatBytes, formatBytes, isTextMime } from '@/lib/fetcher';
import { emptyHar, headerValue, httpVersion, parseCookieHeader, parseSetCookies, queryStringOf, type HarHeader } from '@/lib/har';
import { browser } from 'wxt/browser';

interface Rec {
  requestId: string;
  url: string;
  method: string;
  type: string;
  frameId: number;
  start: number;
  sendTs?: number;
  headersTs?: number;
  end?: number;
  requestHeaders?: HarHeader[];
  responseHeaders?: HarHeader[];
  statusCode?: number;
  statusLine?: string;
  ip?: string;
  fromCache?: boolean;
  error?: string;
  redirectUrl?: string;
  requestBody?: any;
  body?: Uint8Array;
  bodyState?: 'pending' | 'done' | 'toolarge' | 'error';
  bodyError?: string;
  responseSize?: number;
}

/** Types whose bodies are not intercepted (streams, large media). */
const NO_BODY_TYPES = new Set(['media', 'websocket', 'object', 'object_subrequest', 'speculative', 'beacon', 'ping', 'csp_report']);

const toHar = (h?: { name: string; value?: string }[]): HarHeader[] => (h ?? []).map((x) => ({ name: x.name, value: x.value ?? '' }));

export class WebRequestRecorder {
  private current = new Map<string, Rec>();
  private all: Rec[] = [];
  private listeners: [any, any][] = [];
  lastActivity = Date.now();
  loaded = false;

  constructor(
    private tabId: number,
    private includeBodies: boolean,
    private maxBytes: number,
  ) {}

  get count() {
    return this.all.length;
  }
  get pending() {
    return Array.from(this.current.values()).filter((r) => r.end === undefined).length;
  }

  private add(event: any, fn: (d: any) => any, extra: string[]) {
    const wrapped = (d: any) => {
      this.lastActivity = Date.now();
      return fn(d);
    };
    event.addListener(wrapped, { urls: ['<all_urls>'], tabId: this.tabId }, extra);
    this.listeners.push([event, wrapped]);
  }

  async start() {
    const wr: any = browser.webRequest;
    this.add(
      wr.onBeforeRequest,
      (d: any) => {
        const rec: Rec = { requestId: d.requestId, url: d.url, method: d.method, type: d.type, frameId: d.frameId, start: d.timeStamp, requestBody: d.requestBody };
        this.current.set(d.requestId, rec);
        this.all.push(rec);
        if (this.includeBodies && !NO_BODY_TYPES.has(d.type) && typeof wr.filterResponseData === 'function') this.captureBody(rec);
        return {};
      },
      ['blocking', 'requestBody'],
    );
    this.add(
      wr.onSendHeaders,
      (d: any) => {
        const r = this.current.get(d.requestId);
        if (r) {
          r.requestHeaders = toHar(d.requestHeaders);
          r.sendTs = d.timeStamp;
        }
      },
      ['requestHeaders'],
    );
    this.add(
      wr.onHeadersReceived,
      (d: any) => {
        const r = this.current.get(d.requestId);
        if (r) {
          r.responseHeaders = toHar(d.responseHeaders);
          r.statusCode = d.statusCode;
          r.statusLine = d.statusLine;
          r.headersTs = d.timeStamp;
        }
      },
      ['responseHeaders'],
    );
    this.add(
      wr.onBeforeRedirect,
      (d: any) => {
        const r = this.current.get(d.requestId);
        if (r) {
          r.redirectUrl = d.redirectUrl;
          r.statusCode = d.statusCode;
          r.statusLine = d.statusLine;
          r.ip = d.ip;
          r.fromCache = d.fromCache;
          r.end = d.timeStamp;
          r.headersTs ??= d.timeStamp;
          if (d.responseHeaders) r.responseHeaders = toHar(d.responseHeaders);
          this.current.delete(d.requestId); // the next hop gets a new entry
        }
      },
      ['responseHeaders'],
    );
    this.add(
      wr.onResponseStarted,
      (d: any) => {
        const r = this.current.get(d.requestId);
        if (r) {
          r.ip = d.ip;
          r.fromCache = d.fromCache;
        }
      },
      [],
    );
    this.add(
      wr.onCompleted,
      (d: any) => {
        const r = this.current.get(d.requestId);
        if (r) {
          r.end = d.timeStamp;
          r.statusCode = d.statusCode;
          r.statusLine = d.statusLine;
          r.ip = d.ip;
          r.fromCache = d.fromCache;
          r.responseSize = d.responseSize;
          if (d.responseHeaders) r.responseHeaders = toHar(d.responseHeaders);
        }
      },
      ['responseHeaders'],
    );
    this.add(
      wr.onErrorOccurred,
      (d: any) => {
        const r = this.current.get(d.requestId);
        if (r) {
          r.end = d.timeStamp;
          r.error = d.error;
        }
      },
      [],
    );
  }

  private captureBody(rec: Rec) {
    let filter: any;
    try {
      filter = (browser.webRequest as any).filterResponseData(rec.requestId);
    } catch (e) {
      rec.bodyState = 'error';
      rec.bodyError = String(e);
      return;
    }
    const chunks: Uint8Array[] = [];
    let size = 0;
    rec.bodyState = 'pending';
    filter.ondata = (ev: { data: ArrayBuffer }) => {
      filter.write(ev.data);
      if (rec.bodyState !== 'pending') return;
      size += ev.data.byteLength;
      if (size > this.maxBytes) {
        rec.bodyState = 'toolarge';
        chunks.length = 0;
        try {
          filter.disconnect(); // the rest flows through unfiltered
        } catch {
          /* ignore */
        }
        return;
      }
      chunks.push(new Uint8Array(ev.data));
    };
    filter.onstop = () => {
      if (rec.bodyState === 'pending') {
        rec.body = concatBytes(chunks, size);
        rec.bodyState = 'done';
      }
      try {
        filter.close();
      } catch {
        /* ignore */
      }
    };
    filter.onerror = () => {
      if (rec.bodyState === 'pending') {
        rec.bodyState = 'error';
        rec.bodyError = filter.error;
      }
    };
  }

  async reload() {
    this.loaded = false;
    this.lastActivity = Date.now();
    await browser.tabs.reload(this.tabId, { bypassCache: true });
  }

  async checkLoaded() {
    try {
      const tab = await browser.tabs.get(this.tabId);
      const mainDone = this.all.some((r) => r.type === 'main_frame' && r.end !== undefined);
      this.loaded = mainDone && tab.status === 'complete';
    } catch {
      /* ignore */
    }
    return this.loaded;
  }

  stop() {
    for (const [event, fn] of this.listeners) {
      try {
        event.removeListener(fn);
      } catch {
        /* ignore */
      }
    }
    this.listeners = [];
  }

  async toHar(ctx: JobContext): Promise<{ har: any; warnings: string[] }> {
    const warnings: string[] = [];
    const recs = this.all.filter((r) => /^(https?|ftp):/i.test(r.url));
    const first = recs.find((r) => r.type === 'main_frame') ?? recs[0];
    const base = first?.start ?? Date.now();
    const har = emptyHar(ctx, [{ startedDateTime: new Date(base).toISOString(), id: 'page_1', title: ctx.title || ctx.url, pageTimings: { onContentLoad: -1, onLoad: -1 } }]);
    let tooLarge = 0;
    for (const r of recs) {
      const reqHeaders = r.requestHeaders ?? [];
      const respHeaders = r.responseHeaders ?? [];
      const mime = headerValue(respHeaders, 'content-type') ?? '';
      const content: any = { size: r.body?.byteLength ?? r.responseSize ?? 0, mimeType: mime || 'x-unknown' };
      if (r.body && r.bodyState === 'done') {
        if (isTextMime(mime) || r.type === 'main_frame' || r.type === 'sub_frame' || r.type === 'script' || r.type === 'stylesheet') {
          const charset = /charset=([^;]+)/i.exec(mime)?.[1]?.trim();
          let dec: TextDecoder;
          try {
            dec = new TextDecoder(charset || 'utf-8');
          } catch {
            dec = new TextDecoder('utf-8');
          }
          content.text = dec.decode(r.body);
        } else {
          content.text = bytesToBase64(r.body);
          content.encoding = 'base64';
        }
      } else if (r.bodyState === 'toolarge') {
        tooLarge++;
        content.comment = `Body not exported: larger than limit ${formatBytes(this.maxBytes)}`;
        ctx.skipped.push({ path: `network.har → ${r.url}`, reason: 'response body larger than limit' });
      } else if (r.bodyState === 'error') content.comment = `Body not available: ${r.bodyError ?? 'error'}`;
      else if (r.bodyState === 'pending') content.comment = 'Body not complete at export time';

      let postData: any;
      if (r.requestBody?.formData) {
        postData = {
          mimeType: headerValue(reqHeaders, 'content-type') ?? 'application/x-www-form-urlencoded',
          params: Object.entries(r.requestBody.formData as Record<string, string[]>).flatMap(([name, vals]) => vals.map((value) => ({ name, value }))),
          text: '',
        };
      } else if (r.requestBody?.raw?.length) {
        const bytes = concatBytes(r.requestBody.raw.filter((x: any) => x.bytes).map((x: any) => new Uint8Array(x.bytes)));
        postData = { mimeType: headerValue(reqHeaders, 'content-type') ?? '', text: new TextDecoder().decode(bytes) };
      }

      const end = r.end ?? Date.now();
      const send = r.sendTs ?? r.start;
      const headersAt = r.headersTs ?? end;
      const timings = {
        blocked: Math.max(0, send - r.start),
        dns: -1,
        connect: -1,
        ssl: -1,
        send: 0,
        wait: Math.max(0, headersAt - send),
        receive: Math.max(0, end - headersAt),
      };
      const version = (r.statusLine?.split(' ')[0] ?? '').toUpperCase();
      const entry: any = {
        pageref: 'page_1',
        startedDateTime: new Date(r.start).toISOString(),
        time: timings.blocked + timings.wait + timings.receive,
        request: {
          method: r.method,
          url: r.url,
          httpVersion: version || httpVersion(undefined),
          cookies: parseCookieHeader(headerValue(reqHeaders, 'cookie')),
          headers: reqHeaders,
          queryString: queryStringOf(r.url),
          headersSize: -1,
          bodySize: postData?.text?.length ?? 0,
          ...(postData ? { postData } : {}),
        },
        response: {
          status: r.statusCode ?? 0,
          statusText: r.statusLine?.replace(/^\S+\s+\d+\s*/, '') ?? '',
          httpVersion: version || httpVersion(undefined),
          cookies: parseSetCookies(respHeaders),
          headers: respHeaders,
          content,
          redirectURL: r.redirectUrl ?? '',
          headersSize: -1,
          bodySize: r.responseSize ?? -1,
          ...(r.error ? { _error: r.error } : {}),
        },
        cache: {},
        timings,
        serverIPAddress: r.ip ?? '',
        _resourceType: mapType(r.type),
        _fromCache: r.fromCache ? 'disk' : undefined,
      };
      if (r.end === undefined) entry.comment = 'Request had not finished at export time';
      har.log.entries.push(entry);
    }
    har.log.comment = 'Recorded with webRequest + filterResponseData (Firefox) during "Record & reload". Timings are simplified (no DNS/connect/SSL).';
    if (tooLarge) warnings.push(`${tooLarge} response body/bodies above the size limit not exported.`);
    warnings.push('Firefox: simplified timings (DNS/connect/SSL not available), service worker requests are missing.');
    return { har, warnings };
  }
}

function mapType(t: string) {
  switch (t) {
    case 'main_frame':
    case 'sub_frame':
      return 'document';
    case 'stylesheet':
      return 'stylesheet';
    case 'script':
      return 'script';
    case 'image':
    case 'imageset':
      return 'image';
    case 'font':
      return 'font';
    case 'xmlhttprequest':
      return 'xhr';
    case 'media':
      return 'media';
    case 'websocket':
      return 'websocket';
    default:
      return 'other';
  }
}
