// Provides response metadata (headers, and on Chrome TLS securityDetails) to the security,
// third-party and tech-stack areas, from the best passive source available:
//   1. responses captured during "Record & reload" (richest; TLS on Chrome)
//   2. the HAR the DevTools panel handed over (headers, no TLS)
//   3. a same-origin cache-first fetch of the current page (main document headers only)
import type { CdpResponseInfo, JobContext } from '@/lib/context';
import { fetchResource } from '@/lib/fetcher';

export interface ResponseSet {
  source: string;
  responses: CdpResponseInfo[];
  warnings: string[];
}

export async function getResponses(ctx: JobContext): Promise<ResponseSet> {
  if (ctx.shared.responses && ctx.shared.responses.length)
    return { source: 'Record & reload (CDP/webRequest)', responses: ctx.shared.responses, warnings: [] };

  // From the DevTools panel HAR
  const har = ctx.devtools?.har;
  if (har?.entries?.length) {
    const responses: CdpResponseInfo[] = har.entries.map((e: any) => {
      const headers: Record<string, string> = {};
      for (const h of e.response?.headers ?? []) headers[String(h.name).toLowerCase()] = h.value;
      return { url: e.request?.url, status: e.response?.status ?? 0, mimeType: e.response?.content?.mimeType, headers };
    });
    return { source: 'DevTools HAR', responses, warnings: ['Response headers taken from the DevTools panel HAR; no TLS certificate.'] };
  }

  // Same-origin main-document fetch (cache-first)
  try {
    const res = await fetchResource(ctx.url, ctx.maxBytes, 10000);
    const headers: Record<string, string> = {};
    // fetchResource does not expose all headers; do a direct fetch for headers only
    const r = await fetch(ctx.url, { credentials: 'include', cache: 'force-cache' });
    r.headers.forEach((v, k) => (headers[k.toLowerCase()] = v));
    return {
      source: 'same-origin fetch of the current page (headers only)',
      responses: [{ url: ctx.url, status: r.status, mimeType: r.headers.get('content-type') ?? undefined, headers }],
      warnings: [
        'No recorded network data: only the main document response headers are available (fetched same-origin from cache). Use "Record & reload" for all responses and, on Chrome, the TLS certificate.',
      ],
      // note: res kept only to reuse the cache warmup
    } as ResponseSet & { _res?: typeof res };
  } catch (e) {
    return { source: 'none', responses: [], warnings: [`No response headers available: ${String((e as Error).message ?? e)}`] };
  }
}

export function eTldPlusOne(host: string): string {
  // Heuristic public-suffix handling for common multi-part TLDs (offline, no PSL).
  const parts = host.split('.').filter(Boolean);
  if (parts.length <= 2) return host;
  const twoLevel = new Set(['co', 'com', 'org', 'net', 'gov', 'edu', 'ac', 'gouv']);
  const sld = parts[parts.length - 2] ?? '';
  const tld = parts[parts.length - 1] ?? '';
  if (twoLevel.has(sld) && tld.length <= 3) return parts.slice(-3).join('.');
  return parts.slice(-2).join('.');
}

export function hostOfUrl(url: string): string | undefined {
  try {
    return new URL(url).hostname;
  } catch {
    return undefined;
  }
}
