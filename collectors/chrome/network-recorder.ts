// Network recording via CDP (Network.*) → HAR 1.2 incl. response bodies.
import type { JobContext } from '@/lib/context';
import { errMsg, formatBytes, mapLimit } from '@/lib/fetcher';
import {
  emptyHar,
  headerValue,
  headersFromObject,
  httpVersion,
  parseCookieHeader,
  parseSetCookies,
  queryStringOf,
} from '@/lib/har';
import type { CdpSession } from './cdp';
import { isExtensionUrl } from './sources';

interface Rec {
  id: string;
  hop: number;
  request: any;
  timestamp: number;
  wallTime: number;
  type?: string;
  frameId?: string;
  initiator?: any;
  response?: any;
  responseTimestamp?: number;
  endTimestamp?: number;
  encodedDataLength?: number;
  dataLength: number;
  finished?: boolean;
  failed?: boolean;
  canceled?: boolean;
  errorText?: string;
  redirectURL?: string;
}

const pos = (n: number) => (Number.isFinite(n) && n >= 0 ? n : -1);

export class CdpNetworkRecorder {
  private current = new Map<string, Rec>();
  private all: Rec[] = [];
  private extraReq = new Map<string, any[]>();
  private extraResp = new Map<string, any[]>();
  private offs: (() => void)[] = [];
  private dcl?: number;
  private load?: number;
  lastActivity = Date.now();
  loaded = false;

  constructor(private cdp: CdpSession) {}

  get count() {
    return this.all.length;
  }
  get pending() {
    return Array.from(this.current.values()).filter((r) => !r.finished && !r.failed).length;
  }

  async start() {
    const on = (m: string, fn: (p: any) => void) =>
      this.offs.push(
        this.cdp.on(m, (p) => {
          this.lastActivity = Date.now();
          fn(p);
        }),
      );
    on('Network.requestWillBeSent', (p) => {
      const prev = this.current.get(p.requestId);
      if (p.redirectResponse && prev) {
        prev.response = p.redirectResponse;
        prev.responseTimestamp = p.timestamp;
        prev.endTimestamp = p.timestamp;
        prev.encodedDataLength = p.redirectResponse.encodedDataLength;
        prev.finished = true;
        prev.redirectURL = p.request.url;
      }
      const rec: Rec = {
        id: p.requestId,
        hop: prev ? prev.hop + 1 : 0,
        request: p.request,
        timestamp: p.timestamp,
        wallTime: p.wallTime,
        type: p.type,
        frameId: p.frameId,
        initiator: p.initiator,
        dataLength: 0,
      };
      this.current.set(p.requestId, rec);
      this.all.push(rec);
    });
    on('Network.responseReceived', (p) => {
      const r = this.current.get(p.requestId);
      if (!r) return;
      r.response = p.response;
      r.responseTimestamp = p.timestamp;
      if (p.type) r.type = p.type;
    });
    on('Network.dataReceived', (p) => {
      const r = this.current.get(p.requestId);
      if (r) r.dataLength += p.dataLength ?? 0;
    });
    on('Network.loadingFinished', (p) => {
      const r = this.current.get(p.requestId);
      if (!r) return;
      r.finished = true;
      r.endTimestamp = p.timestamp;
      r.encodedDataLength = p.encodedDataLength;
    });
    on('Network.loadingFailed', (p) => {
      const r = this.current.get(p.requestId);
      if (!r) return;
      r.failed = true;
      r.canceled = p.canceled;
      r.errorText = p.errorText || p.blockedReason || p.corsErrorStatus?.corsError;
      r.endTimestamp = p.timestamp;
    });
    on('Network.requestWillBeSentExtraInfo', (p) => {
      const list = this.extraReq.get(p.requestId) ?? [];
      list.push(p);
      this.extraReq.set(p.requestId, list);
    });
    on('Network.responseReceivedExtraInfo', (p) => {
      const list = this.extraResp.get(p.requestId) ?? [];
      list.push(p);
      this.extraResp.set(p.requestId, list);
    });
    on('Page.domContentEventFired', (p) => (this.dcl = p.timestamp));
    on('Page.loadEventFired', (p) => {
      this.load = p.timestamp;
      this.loaded = true;
    });
    await this.cdp.send('Page.enable');
    await this.cdp.send('Network.enable', { maxTotalBufferSize: 300_000_000, maxResourceBufferSize: 100_000_000, maxPostDataSize: 5_000_000 });
  }

  async reload() {
    this.loaded = false;
    this.lastActivity = Date.now();
    await this.cdp.send('Page.reload', { ignoreCache: true });
  }

  stop() {
    for (const off of this.offs) off();
    this.offs = [];
  }

  /** Compact response list (headers, TLS securityDetails) for the security/third-party areas. */
  getResponses(): import('@/lib/context').CdpResponseInfo[] {
    const out: import('@/lib/context').CdpResponseInfo[] = [];
    const seen = new Set<string>();
    for (const r of this.all) {
      const resp = r.response;
      if (!resp || r.request.url.startsWith('data:')) continue;
      const key = r.request.method + ' ' + r.request.url;
      if (seen.has(key)) continue;
      seen.add(key);
      const extra = this.extraResp.get(r.id)?.[r.hop];
      const headers: Record<string, string> = {};
      for (const [k, v] of Object.entries((extra?.headers ?? resp.headers ?? {}) as Record<string, string>)) headers[k.toLowerCase()] = String(v);
      out.push({
        url: r.request.url,
        status: resp.status ?? 0,
        statusText: resp.statusText,
        mimeType: resp.mimeType,
        type: r.type,
        protocol: resp.protocol,
        remoteIP: resp.remoteIPAddress,
        fromCache: resp.fromDiskCache || resp.fromPrefetchCache,
        headers,
        securityDetails: resp.securityDetails,
        securityState: resp.securityState,
      });
    }
    return out;
  }

  async toHar(ctx: JobContext): Promise<{ har: any; warnings: string[] }> {
    const warnings: string[] = [];
    const recs = this.all.filter((r) => !isExtensionUrl(r.request.url) && !r.request.url.startsWith('data:'));
    const firstDoc = recs.find((r) => r.type === 'Document') ?? recs[0];
    const base = firstDoc ? { ts: firstDoc.timestamp, wall: firstDoc.wallTime } : { ts: 0, wall: Date.now() / 1000 };
    const pageStart = new Date(base.wall * 1000).toISOString();
    const har = emptyHar(ctx, [
      {
        startedDateTime: pageStart,
        id: 'page_1',
        title: ctx.title || ctx.url,
        pageTimings: {
          onContentLoad: this.dcl ? Math.round((this.dcl - base.ts) * 1000) : -1,
          onLoad: this.load ? Math.round((this.load - base.ts) * 1000) : -1,
        },
      },
    ]);

    let bodiesSkipped = 0;
    let bodiesFailed = 0;
    let done = 0;
    const entries = await mapLimit(recs, 6, async (r) => {
      ctx.detail(`HAR ${++done}/${recs.length}`);
      const reqExtra = this.extraReq.get(r.id)?.[r.hop];
      const respExtra = r.redirectURL ? undefined : this.extraResp.get(r.id)?.[r.hop];
      const reqHeaders = headersFromObject(reqExtra?.headers ?? r.request.headers);
      const resp = r.response;
      const respHeaders = headersFromObject(respExtra?.headers ?? resp?.headers);

      // Request body
      let postData: any;
      if (r.request.hasPostData) {
        let text: string | undefined = r.request.postData;
        if (text === undefined) {
          try {
            text = (await this.cdp.send<{ postData: string }>('Network.getRequestPostData', { requestId: r.id })).postData;
          } catch {
            /* no longer available */
          }
        }
        if (text !== undefined) postData = { mimeType: headerValue(reqHeaders, 'content-type') ?? '', text };
      }

      // Response body
      const content: any = { size: r.dataLength || resp?.encodedDataLength || 0, mimeType: resp?.mimeType ?? 'x-unknown' };
      const status = resp?.status ?? 0;
      if (ctx.settings.includeBodies && r.finished && !r.failed && !r.redirectURL && resp && status !== 204 && status !== 304) {
        try {
          const b = await this.cdp.send<{ body: string; base64Encoded: boolean }>('Network.getResponseBody', { requestId: r.id });
          const size = b.base64Encoded ? Math.floor(b.body.length * 0.75) : b.body.length;
          if (size > ctx.maxBytes) {
            bodiesSkipped++;
            content.comment = `Body not exported: ${formatBytes(size)} > limit ${formatBytes(ctx.maxBytes)}`;
            ctx.skipped.push({ path: `network.har → ${r.request.url}`, reason: 'response body larger than limit', size });
          } else {
            content.text = b.body;
            if (b.base64Encoded) content.encoding = 'base64';
            content.size = size;
          }
        } catch (e) {
          bodiesFailed++;
          content.comment = `Body not available: ${errMsg(e)}`;
        }
      }

      // Timings
      const t = resp?.timing;
      const end = r.endTimestamp ?? r.responseTimestamp ?? r.timestamp;
      let timings: any;
      if (t && t.requestTime > 0) {
        const firstPhase = [t.dnsStart, t.connectStart, t.sendStart].find((x: number) => x >= 0) ?? 0;
        const blocked = Math.max(0, (t.requestTime - r.timestamp) * 1000 + firstPhase);
        const dns = t.dnsStart >= 0 ? t.dnsEnd - t.dnsStart : -1;
        const connect = t.connectStart >= 0 ? t.connectEnd - t.connectStart : -1;
        const ssl = t.sslStart >= 0 ? t.sslEnd - t.sslStart : -1;
        const send = Math.max(0, t.sendEnd - t.sendStart);
        const wait = Math.max(0, t.receiveHeadersEnd - t.sendEnd);
        const receive = Math.max(0, (end - t.requestTime) * 1000 - t.receiveHeadersEnd);
        timings = { blocked, dns: pos(dns), connect: pos(connect), ssl: pos(ssl), send, wait, receive };
      } else {
        const total = Math.max(0, (end - r.timestamp) * 1000);
        const toHeaders = r.responseTimestamp ? Math.max(0, (r.responseTimestamp - r.timestamp) * 1000) : total;
        timings = { blocked: 0, dns: -1, connect: -1, ssl: -1, send: 0, wait: toHeaders, receive: Math.max(0, total - toHeaders) };
      }
      const time = ['blocked', 'dns', 'connect', 'send', 'wait', 'receive'].reduce((n, k) => n + Math.max(0, timings[k]), 0);

      const wall = r.wallTime ?? base.wall + (r.timestamp - base.ts);
      const entry: any = {
        pageref: 'page_1',
        startedDateTime: new Date(wall * 1000).toISOString(),
        time,
        request: {
          method: r.request.method,
          url: r.request.url + (r.request.urlFragment ?? ''),
          httpVersion: httpVersion(resp?.protocol),
          cookies: parseCookieHeader(headerValue(reqHeaders, 'cookie')),
          headers: reqHeaders,
          queryString: queryStringOf(r.request.url),
          headersSize: -1,
          bodySize: postData?.text?.length ?? 0,
          ...(postData ? { postData } : {}),
        },
        response: {
          status,
          statusText: resp?.statusText ?? '',
          httpVersion: httpVersion(resp?.protocol),
          cookies: parseSetCookies(respHeaders),
          headers: respHeaders,
          content,
          redirectURL: r.redirectURL ?? headerValue(respHeaders, 'location') ?? '',
          headersSize: -1,
          bodySize: r.encodedDataLength ?? -1,
          _transferSize: r.encodedDataLength ?? -1,
          ...(r.failed ? { _error: r.errorText ?? 'failed' } : {}),
        },
        cache: {},
        timings,
        serverIPAddress: resp?.remoteIPAddress?.replace(/^\[|\]$/g, '') ?? '',
        connection: resp?.connectionId !== undefined ? String(resp.connectionId) : '',
        _resourceType: (r.type ?? 'other').toLowerCase(),
        _priority: r.request.initialPriority,
        _initiator: r.initiator,
        _fromCache: resp?.fromDiskCache ? 'disk' : resp?.fromPrefetchCache ? 'prefetch' : undefined,
        _fromServiceWorker: resp?.fromServiceWorker || undefined,
      };
      if (!r.finished && !r.failed) entry.comment = 'Request had not finished at export time';
      return entry;
    });
    har.log.entries = entries.sort((a, b) => a.startedDateTime.localeCompare(b.startedDateTime));
    har.log.comment = 'Recorded with the Chrome DevTools Protocol (Network domain) during "Record & reload".';
    if (bodiesSkipped) warnings.push(`${bodiesSkipped} response body/bodies above the size limit not exported.`);
    if (bodiesFailed) warnings.push(`${bodiesFailed} response body/bodies were no longer available (e.g. evicted from the buffer).`);
    return { har, warnings };
  }
}
