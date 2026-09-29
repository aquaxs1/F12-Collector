// Network → network.har (HAR 1.2). The source depends on the situation:
// 1) Recording ("Record & reload"): CDP (Chrome) or webRequest (Firefox), incl. bodies
// 2) Snapshot from the DevTools panel: devtools.network.getHAR() + bodies buffered there
// 3) Snapshot from the popup: Resource Timing API (URLs & timings only)
import type { Collector } from '@/lib/context';
import { formatBytes } from '@/lib/fetcher';
import { emptyHar, harBrowser, harCreator, harFromPerformance, redactHar } from '@/lib/har';
import type { CollectorResult } from '@/lib/types';

export const collectNetwork: Collector = async (ctx) => {
  const result: CollectorResult = { files: {}, warnings: [] };
  let har: any;
  if (ctx.recordedHar) {
    ctx.detail('building HAR from recording');
    const rec = await ctx.recordedHar();
    har = rec.har;
    result.warnings.push(...rec.warnings);
  } else if (ctx.devtools?.har?.entries) {
    ctx.detail('taking HAR from DevTools');
    const log = structuredClone(ctx.devtools.har);
    har = { log: { version: '1.2', ...log, creator: harCreator(), browser: log.browser ?? harBrowser() } };
    // Match bodies from the panel buffer (same URL + method, in order)
    const pool = new Map<string, NonNullable<typeof ctx.devtools.bodies>>();
    for (const b of ctx.devtools.bodies ?? []) {
      const k = `${b.method} ${b.url}`;
      if (!pool.has(k)) pool.set(k, []);
      pool.get(k)!.push(b);
    }
    let attached = 0;
    let tooLarge = 0;
    for (const e of har.log.entries ?? []) {
      const c = (e.response.content ??= { size: 0, mimeType: '' });
      if (c.text !== undefined || !ctx.settings.includeBodies) continue;
      const b = pool.get(`${e.request.method} ${e.request.url}`)?.shift();
      if (!b) continue;
      const size = b.encoding === 'base64' ? b.content.length * 0.75 : b.content.length;
      if (size > ctx.maxBytes) {
        tooLarge++;
        c.comment = `Body not exported: ${formatBytes(size)} > limit`;
        continue;
      }
      c.text = b.content;
      if (b.encoding === 'base64') c.encoding = 'base64';
      attached++;
    }
    const n = har.log.entries?.length ?? 0;
    result.warnings.push(
      `Snapshot without recording: HAR from DevTools (${n} requests since DevTools was opened, ${attached} with body). Use "Record & reload" for a complete capture.`,
    );
    if (tooLarge) result.warnings.push(`${tooLarge} response body/bodies above the size limit not exported.`);
  } else {
    har = harFromPerformance(ctx);
    if (!har.log.entries.length) har = emptyHar(ctx);
    result.warnings.push(
      'Snapshot without recording: network.har only contains Resource Timing API data (URLs, timings, sizes – no headers, no bodies). For complete data use "Record & reload" or take the snapshot from the DevTools panel.',
    );
  }
  if (ctx.settings.redact) redactHar(har);
  result.files['network.har'] = JSON.stringify(har, null, 1);
  ctx.detail(`${har.log.entries.length} requests`);
  return result;
};
