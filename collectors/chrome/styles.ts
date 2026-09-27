// Styles (Chrome): alle Stylesheets über CSS.getStyleSheetText, Computed Styles aus dem Content Script.
import { collectStylesFallback, sheetFileName, writeComputed } from '@/collectors/firefox/styles';
import type { Collector } from '@/lib/context';
import { errMsg, mapLimit } from '@/lib/fetcher';
import { PathAllocator } from '@/lib/paths';
import type { CollectorResult } from '@/lib/types';

export const collectStylesChrome: Collector = async (ctx) => {
  if (!ctx.cdp) {
    const r = await collectStylesFallback(ctx);
    r.warnings.unshift('Chrome-Debugger nicht verbunden – Stylesheets aus dem CSSOM.');
    return r;
  }
  const cdp = ctx.cdp;
  const result: CollectorResult = { files: {}, warnings: [] };
  const headers: any[] = [];
  const off = cdp.on('CSS.styleSheetAdded', (p) => headers.push(p.header));
  try {
    await cdp.send('DOM.enable');
    await cdp.send('CSS.enable'); // meldet alle vorhandenen Stylesheets per styleSheetAdded
    await new Promise((r) => setTimeout(r, 300));
  } finally {
    off();
  }
  const relevant = headers.filter((h) => h.origin !== 'user-agent' && h.origin !== 'injected');
  const alloc = new PathAllocator();
  let done = 0;
  let failed = 0;
  const index = await mapLimit(relevant, 6, async (h, i) => {
    ctx.detail(`Stylesheets ${++done}/${relevant.length}`);
    const entry: Record<string, unknown> = {
      styleSheetId: h.styleSheetId,
      sourceURL: h.sourceURL || undefined,
      origin: h.origin,
      isInline: h.isInline,
      isConstructed: h.isConstructed,
      isMutable: h.isMutable,
      disabled: h.disabled,
      title: h.title || undefined,
      frameId: h.frameId,
      length: h.length,
      sourceMapURL: h.sourceMapURL || undefined,
    };
    try {
      const { text } = await cdp.send<{ text: string }>('CSS.getStyleSheetText', { styleSheetId: h.styleSheetId });
      const file = alloc.allocate(`styles/stylesheets/${sheetFileName(i, h.sourceURL, h.isInline ? 'inline' : h.isConstructed ? 'constructed' : 'sheet')}`);
      result.files[file] = text;
      entry.file = file.slice(7);
    } catch (e) {
      failed++;
      entry.error = errMsg(e);
    }
    return entry;
  });
  await cdp.send('CSS.disable').catch(() => {});
  result.files['styles/stylesheets/index.json'] = JSON.stringify(index, null, 2);
  if (failed) result.warnings.push(`${failed} Stylesheet(s) nicht lesbar.`);
  writeComputed(ctx, result);
  return result;
};
