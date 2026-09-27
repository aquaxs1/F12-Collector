// HAR 1.2 – gemeinsame Hilfsfunktionen (Aufbau, Redaction, Fallback aus Resource Timing).
import { browser } from 'wxt/browser';
import { BROWSER_NAME } from './areas';
import type { JobContext } from './context';
import { REDACTED, isSensitiveHeader, redactTokensInString } from './redact';

export interface HarHeader {
  name: string;
  value: string;
}

export function harCreator() {
  return { name: 'F12 Collector', version: browser.runtime.getManifest().version };
}

export function harBrowser() {
  const m = /(Firefox|Chrome|Chromium|Edg)\/([\d.]+)/.exec(navigator.userAgent);
  return { name: m?.[1] ?? BROWSER_NAME, version: m?.[2] ?? '' };
}

/** CDP-Header-Objekt → HAR-Header-Array (mehrere Werte sind durch \n getrennt). */
export function headersFromObject(obj: Record<string, string> | undefined): HarHeader[] {
  const out: HarHeader[] = [];
  if (!obj) return out;
  for (const [name, value] of Object.entries(obj)) for (const v of String(value).split('\n')) out.push({ name, value: v });
  return out;
}

export function headerValue(headers: HarHeader[], name: string): string | undefined {
  const n = name.toLowerCase();
  return headers.find((h) => h.name.toLowerCase() === n)?.value;
}

export function queryStringOf(url: string): HarHeader[] {
  try {
    return Array.from(new URL(url).searchParams.entries()).map(([name, value]) => ({ name, value }));
  } catch {
    return [];
  }
}

export function parseCookieHeader(value: string | undefined) {
  if (!value) return [];
  return value
    .split(/;\s*/)
    .filter(Boolean)
    .map((part) => {
      const i = part.indexOf('=');
      return i < 0 ? { name: part, value: '' } : { name: part.slice(0, i).trim(), value: part.slice(i + 1) };
    });
}

export function parseSetCookies(headers: HarHeader[]) {
  return headers
    .filter((h) => h.name.toLowerCase() === 'set-cookie')
    .flatMap((h) => h.value.split('\n'))
    .map((line) => {
      const [pair = '', ...attrs] = line.split(/;\s*/);
      const i = pair.indexOf('=');
      const c: Record<string, any> = { name: i < 0 ? pair : pair.slice(0, i), value: i < 0 ? '' : pair.slice(i + 1) };
      for (const a of attrs) {
        const [k = '', v] = a.split('=');
        const key = k.trim().toLowerCase();
        if (key === 'path') c.path = v;
        else if (key === 'domain') c.domain = v;
        else if (key === 'expires') {
          const d = new Date(v ?? '');
          if (!isNaN(d.getTime())) c.expires = d.toISOString();
        } else if (key === 'httponly') c.httpOnly = true;
        else if (key === 'secure') c.secure = true;
        else if (key === 'samesite') c.sameSite = v;
      }
      return c;
    });
}

export function httpVersion(protocol: string | undefined): string {
  if (!protocol) return 'HTTP/1.1';
  const p = protocol.toLowerCase();
  if (p === 'h2' || p === 'http/2' || p === 'http/2.0') return 'HTTP/2.0';
  if (p === 'h3' || p.startsWith('h3-') || p === 'http/3') return 'HTTP/3.0';
  if (p.startsWith('http/')) return p.toUpperCase();
  return protocol.toUpperCase();
}

export function emptyHar(ctx: JobContext, pages: any[] = []) {
  return {
    log: {
      version: '1.2',
      creator: harCreator(),
      browser: harBrowser(),
      pages,
      entries: [] as any[],
      comment: '',
    },
  };
}

/** Sensible Header, Cookies und Tokens im HAR schwärzen. */
export function redactHar(har: any) {
  for (const e of har?.log?.entries ?? []) {
    for (const part of [e.request, e.response]) {
      if (!part) continue;
      for (const h of part.headers ?? []) {
        if (isSensitiveHeader(h.name)) h.value = REDACTED;
        else if (typeof h.value === 'string') h.value = redactTokensInString(h.value);
      }
      for (const c of part.cookies ?? []) c.value = REDACTED;
    }
    if (e.request?.postData?.text) e.request.postData.text = redactTokensInString(e.request.postData.text);
    for (const p of e.request?.postData?.params ?? []) if (typeof p.value === 'string') p.value = redactTokensInString(p.value);
  }
  har.log.comment = [har.log.comment, 'Redaction aktiv: Cookie-/Auth-Header und Token-Muster wurden durch [REDACTED] ersetzt.'].filter(Boolean).join(' ');
  return har;
}

const TYPE_MAP: Record<string, string> = {
  script: 'script',
  link: 'stylesheet',
  css: 'stylesheet',
  img: 'image',
  image: 'image',
  xmlhttprequest: 'xhr',
  fetch: 'fetch',
  beacon: 'ping',
  iframe: 'document',
  navigation: 'document',
  video: 'media',
  audio: 'media',
  font: 'font',
};

/** Fallback ohne Aufzeichnung: HAR aus der Resource-Timing-API (ohne Header und Bodies). */
export function harFromPerformance(ctx: JobContext) {
  const har = emptyHar(ctx);
  const top = ctx.frames.find((f) => f.frameId === 0) ?? ctx.frames[0];
  if (!top?.resources) return har;
  const r = top.resources;
  const started = new Date(r.timeOrigin).toISOString();
  har.log.pages.push({ startedDateTime: started, id: 'page_1', title: ctx.title || ctx.url, pageTimings: {} });
  const all = [...(r.navigation ? [{ ...r.navigation, initiatorType: 'navigation' }] : []), ...r.performance];
  for (const f of ctx.frames) if (f !== top && f.resources) all.push(...f.resources.performance);
  for (const p of all) {
    if (!/^https?:/i.test(p.name)) continue;
    const status = p.responseStatus ?? 0;
    har.log.entries.push({
      pageref: 'page_1',
      startedDateTime: new Date(r.timeOrigin + p.startTime).toISOString(),
      time: Math.max(0, p.duration),
      request: { method: 'GET', url: p.name, httpVersion: httpVersion(p.nextHopProtocol), cookies: [], headers: [], queryString: queryStringOf(p.name), headersSize: -1, bodySize: -1 },
      response: {
        status,
        statusText: status ? '' : '(unbekannt – nur Resource Timing)',
        httpVersion: httpVersion(p.nextHopProtocol),
        cookies: [],
        headers: [],
        content: { size: p.decodedBodySize ?? 0, mimeType: '' },
        redirectURL: '',
        headersSize: -1,
        bodySize: p.encodedBodySize ?? -1,
        _transferSize: p.transferSize,
      },
      cache: {},
      timings: { blocked: -1, dns: -1, connect: -1, ssl: -1, send: 0, wait: Math.max(0, p.duration), receive: 0 },
      _resourceType: TYPE_MAP[p.initiatorType] ?? 'other',
    });
  }
  har.log.entries.sort((a: any, b: any) => a.startedDateTime.localeCompare(b.startedDateTime));
  har.log.comment = 'Erzeugt aus der Resource-Timing-API (Snapshot ohne Aufzeichnung): keine Header, keine Bodies, Methode immer GET angenommen.';
  return har;
}
