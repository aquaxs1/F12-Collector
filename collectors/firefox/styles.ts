// Styles (Fallback/Firefox): document.styleSheets aus dem Content Script,
// Cross-Origin-Sheets über den Background neu laden, Computed Styles per getComputedStyle.
import type { Collector, JobContext } from '@/lib/context';
import { decodeUtf8, fetchResource, mapLimit } from '@/lib/fetcher';
import { PathAllocator, sanitizeSegment } from '@/lib/paths';
import type { CollectorResult } from '@/lib/types';

export function sheetFileName(i: number, href: string | undefined, fallback = 'inline') {
  let base = fallback;
  if (href) {
    try {
      base = new URL(href).pathname.split('/').pop() || 'index';
    } catch {
      /* ignore */
    }
  }
  base = sanitizeSegment(base).replace(/\.css$/i, '');
  return `${String(i + 1).padStart(3, '0')}_${base}.css`;
}

/** Computed Styles aus allen Frames → styles/computed-styles.json */
export function writeComputed(ctx: JobContext, result: CollectorResult) {
  const s = ctx.settings;
  const frames = ctx.frames
    .filter((f) => f.styles)
    .map((f) => ({
      frameId: f.frameId,
      url: f.url,
      candidates: f.styles!.computedTotalCandidates,
      exported: f.styles!.computed.length,
      elements: f.styles!.computed,
    }));
  result.files['styles/computed-styles.json'] = JSON.stringify(
    {
      mode: s.computedStylesMode,
      limitPerFrame: s.computedStylesLimit,
      diffOnly: s.computedStylesDiffOnly,
      note: s.computedStylesDiffOnly
        ? 'Nur Werte, die vom Browser-Standard für das jeweilige Element abweichen (Vergleich mit einem leeren Dokument).'
        : 'Alle berechneten Eigenschaften.',
      frames,
    },
    null,
    1,
  );
  for (const f of frames)
    if (f.candidates > f.exported)
      result.warnings.push(`Computed Styles (${f.url}): ${f.exported} von ${f.candidates} Elementen exportiert (Limit in den Einstellungen).`);
  if (s.computedStylesMode !== 'none' && !frames.length) result.warnings.push('Keine Computed Styles erhalten (Content Script lief nicht).');
}

export const collectStylesFallback: Collector = async (ctx) => {
  const result: CollectorResult = { files: {}, warnings: [] };
  const alloc = new PathAllocator();
  const sheets = ctx.frames.flatMap((f) => (f.styles?.sheets ?? []).map((s) => ({ frame: f.url, ...s })));
  let refetched = 0;
  let failed = 0;
  let done = 0;
  const index = await mapLimit(sheets, 6, async (s, i) => {
    ctx.detail(`Stylesheets ${++done}/${sheets.length}`);
    let text = s.text;
    let source = 'CSSOM (cssRules)';
    if (text === undefined && s.href && /^https?:/i.test(s.href)) {
      const res = await fetchResource(s.href, ctx.maxBytes);
      if (res.ok && res.bytes) {
        text = decodeUtf8(res.bytes);
        source = 'neu geladen (Cross-Origin)';
        refetched++;
      } else failed++;
    }
    const file = text !== undefined ? alloc.allocate(`styles/stylesheets/${sheetFileName(i, s.href)}`) : undefined;
    if (file) result.files[file] = text!;
    return { file: file?.slice(7), href: s.href, owner: s.owner, media: s.media, frame: s.frame, source: text !== undefined ? source : 'nicht lesbar' };
  });
  result.files['styles/stylesheets/index.json'] = JSON.stringify(index, null, 2);
  if (refetched) result.warnings.push(`${refetched} Cross-Origin-Stylesheet(s) neu geladen (Inhalt kann von der geparsten Version abweichen).`);
  if (failed) result.warnings.push(`${failed} Stylesheet(s) nicht lesbar.`);
  writeComputed(ctx, result);
  return result;
};
