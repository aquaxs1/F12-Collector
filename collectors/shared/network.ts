// Netzwerk → network.har (HAR 1.2). Quelle je nach Situation:
// 1) Aufzeichnung ("Aufzeichnen & neu laden"): CDP (Chrome) bzw. webRequest (Firefox), inkl. Bodies
// 2) Snapshot aus dem DevTools-Panel: devtools.network.getHAR() + dort gepufferte Bodies
// 3) Snapshot aus dem Popup: Resource-Timing-API (nur URLs & Zeiten)
import type { Collector } from '@/lib/context';
import { formatBytes } from '@/lib/fetcher';
import { emptyHar, harBrowser, harCreator, harFromPerformance, redactHar } from '@/lib/har';
import type { CollectorResult } from '@/lib/types';

export const collectNetwork: Collector = async (ctx) => {
  const result: CollectorResult = { files: {}, warnings: [] };
  let har: any;
  if (ctx.recordedHar) {
    ctx.detail('HAR aus Aufzeichnung erstellen');
    const rec = await ctx.recordedHar();
    har = rec.har;
    result.warnings.push(...rec.warnings);
  } else if (ctx.devtools?.har?.entries) {
    ctx.detail('HAR aus den DevTools übernehmen');
    const log = structuredClone(ctx.devtools.har);
    har = { log: { version: '1.2', ...log, creator: harCreator(), browser: log.browser ?? harBrowser() } };
    // Bodies aus dem Panel-Puffer zuordnen (gleiche URL + Methode, in Reihenfolge)
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
        c.comment = `Body nicht exportiert: ${formatBytes(size)} > Limit`;
        continue;
      }
      c.text = b.content;
      if (b.encoding === 'base64') c.encoding = 'base64';
      attached++;
    }
    const n = har.log.entries?.length ?? 0;
    result.warnings.push(
      `Snapshot ohne Aufzeichnung: HAR aus den DevTools (${n} Requests seit dem Öffnen der DevTools, ${attached} mit Body). Für einen vollständigen Mitschnitt "Aufzeichnen & neu laden" verwenden.`,
    );
    if (tooLarge) result.warnings.push(`${tooLarge} Response-Body(s) über dem Größenlimit nicht exportiert.`);
  } else {
    har = harFromPerformance(ctx);
    if (!har.log.entries.length) har = emptyHar(ctx);
    result.warnings.push(
      'Snapshot ohne Aufzeichnung: network.har enthält nur Daten der Resource-Timing-API (URLs, Zeiten, Größen – keine Header, keine Bodies). Für vollständige Daten "Aufzeichnen & neu laden" verwenden oder den Snapshot aus dem DevTools-Panel starten.',
    );
  }
  if (ctx.settings.redact) redactHar(har);
  result.files['network.har'] = JSON.stringify(har, null, 1);
  ctx.detail(`${har.log.entries.length} Requests`);
  return result;
};
