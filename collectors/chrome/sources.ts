// Quellcode (Chrome): Ressourcen über Page.getResourceContent, Scripts über Debugger.getScriptSource.
import { collectSourcesFallback } from '@/collectors/firefox/sources';
import { extractSourceMaps, type SourceMapCandidate } from '@/collectors/shared/sourcemaps';
import type { Collector, ScriptRecord } from '@/lib/context';
import { base64ToBytes, decodeUtf8, errMsg, fetchResource, formatBytes, isTextMime, mapLimit } from '@/lib/fetcher';
import { PathAllocator, stripHash, urlToPath } from '@/lib/paths';
import type { CollectorResult } from '@/lib/types';

const MAX_DYNAMIC = 300;

interface ResItem {
  frameId: string;
  url: string;
  type: string;
  mimeType: string;
}

function extFor(type: string, mime: string) {
  if (type === 'Script' || /javascript/.test(mime)) return '.js';
  if (type === 'Stylesheet' || /css/.test(mime)) return '.css';
  if (type === 'Document' || /html/.test(mime)) return '.html';
  return '';
}

export function isExtensionUrl(url: string) {
  return /^(chrome-extension|moz-extension|chrome|extensions|devtools):/i.test(url);
}

export const collectSourcesChrome: Collector = async (ctx) => {
  const cdp = ctx.cdp;
  if (!cdp) {
    const r = await collectSourcesFallback(ctx);
    r.warnings.unshift('Chrome-Debugger nicht verbunden – Fallback per fetch verwendet.');
    return r;
  }
  const result: CollectorResult = { files: {}, warnings: [] };
  const alloc = new PathAllocator();
  const candidates: SourceMapCandidate[] = [];
  const savedByUrl = new Map<string, string>();
  const frameUrls = new Set<string>();
  const index: { url: string; type: string; path?: string; size?: number; skipped?: string; note?: string }[] = [];

  // 1) Alle Ressourcen aus dem Resource Tree
  await cdp.send('Page.enable');
  const { frameTree } = await cdp.send('Page.getResourceTree');
  const items: ResItem[] = [];
  const seen = new Set<string>();
  const walk = (node: any) => {
    const f = node.frame;
    frameUrls.add(stripHash(String(f.url)));
    if (!seen.has(f.url)) {
      seen.add(f.url);
      items.push({ frameId: f.id, url: f.url, type: 'Document', mimeType: f.mimeType ?? 'text/html' });
    }
    for (const r of node.resources ?? []) {
      if (seen.has(r.url) || r.failed || r.canceled || r.url.startsWith('data:')) continue;
      seen.add(r.url);
      items.push({ frameId: f.id, url: r.url, type: r.type, mimeType: r.mimeType ?? '' });
    }
    for (const c of node.childFrames ?? []) walk(c);
  };
  walk(frameTree);

  let done = 0;
  await mapLimit(items, 6, async (it) => {
    ctx.detail(`Ressourcen ${++done}/${items.length}`);
    if (!/^(https?|file|blob):/i.test(it.url)) return;
    try {
      const { content, base64Encoded } = await cdp.send<{ content: string; base64Encoded: boolean }>('Page.getResourceContent', {
        frameId: it.frameId,
        url: it.url,
      });
      const size = base64Encoded ? Math.floor(content.length * 0.75) : content.length;
      if (size > ctx.maxBytes) {
        index.push({ url: it.url, type: it.type, size, skipped: `größer als Limit (${formatBytes(size)})` });
        ctx.skipped.push({ path: it.url, reason: 'größer als Limit', size });
        return;
      }
      const path = alloc.allocate(urlToPath(it.url, 'sources', extFor(it.type, it.mimeType)));
      const data = base64Encoded ? base64ToBytes(content) : content;
      result.files[path] = data;
      savedByUrl.set(it.url, path);
      index.push({ url: it.url, type: it.type, path, size });
      if (typeof data === 'string' && it.type === 'Stylesheet') candidates.push({ url: it.url, text: data });
    } catch (e) {
      // Nicht mehr im Cache des Renderers → per fetch neu laden
      if (/^https?:/i.test(it.url)) {
        const res = await fetchResource(it.url, ctx.maxBytes);
        if (res.bytes) {
          const path = alloc.allocate(urlToPath(it.url, 'sources', extFor(it.type, it.mimeType)));
          const text = isTextMime(res.contentType) || ['Document', 'Stylesheet', 'Script'].includes(it.type);
          const data = text ? decodeUtf8(res.bytes) : res.bytes;
          result.files[path] = data;
          savedByUrl.set(it.url, path);
          index.push({ url: it.url, type: it.type, path, size: res.size, note: 'per fetch neu geladen' });
          if (typeof data === 'string' && it.type === 'Stylesheet') candidates.push({ url: it.url, text: data });
          return;
        }
      }
      index.push({ url: it.url, type: it.type, skipped: errMsg(e) });
    }
  });

  // 2) Alle geparsten Scripts (inkl. Inline und dynamisch erzeugter)
  let parsed = ctx.shared.parsedScripts;
  if (!parsed) {
    parsed = [];
    const off = cdp.on('Debugger.scriptParsed', (p) => parsed!.push(p));
    await cdp.send('Debugger.enable');
    await new Promise((r) => setTimeout(r, 500));
    off();
    ctx.shared.parsedScripts = parsed;
  }
  const scripts: ScriptRecord[] = [];
  let dynamicCount = 0;
  let dynamicSkipped = 0;
  const relevant = parsed.filter((p) => !isExtensionUrl(p.url ?? '') && p.executionContextAuxData?.type !== 'isolated');
  done = 0;
  await mapLimit(relevant, 6, async (p) => {
    ctx.detail(`Scripts ${++done}/${relevant.length}`);
    const url: string = p.url ?? '';
    const isInline = !!url && frameUrls.has(stripHash(url));
    const kind: ScriptRecord['kind'] = !url ? 'dynamic' : isInline ? 'inline' : 'external';
    const rec: ScriptRecord = {
      id: p.scriptId,
      url: url || `(dynamisch, scriptId ${p.scriptId})`,
      sourceMapURL: p.sourceMapURL || undefined,
      length: p.length,
      hash: p.hash,
      isModule: p.isModule,
      startLine: p.startLine,
      kind,
    };
    scripts.push(rec);
    if (kind === 'external' && savedByUrl.has(url)) {
      rec.path = savedByUrl.get(url);
      const text = result.files[rec.path!];
      candidates.push({ url, text: typeof text === 'string' ? text : undefined, sourceMapURL: rec.sourceMapURL });
      return;
    }
    if (kind === 'dynamic' && dynamicCount >= MAX_DYNAMIC) {
      dynamicSkipped++;
      return;
    }
    if ((p.length ?? 0) > ctx.maxBytes) {
      ctx.skipped.push({ path: rec.url, reason: 'Script größer als Limit', size: p.length });
      return;
    }
    try {
      const { scriptSource } = await cdp.send<{ scriptSource: string }>('Debugger.getScriptSource', { scriptId: p.scriptId });
      let path: string;
      if (kind === 'external') path = urlToPath(url, 'sources', '.js');
      else if (kind === 'inline') path = `${urlToPath(url, 'sources/_inline', '.html').replace(/\.[a-z0-9]+$/i, '')}/script-L${p.startLine + 1}.js`;
      else {
        dynamicCount++;
        path = `sources/_dynamic/script-${p.scriptId}.js`;
      }
      rec.path = alloc.allocate(path);
      result.files[rec.path] = scriptSource;
      if (kind === 'external') savedByUrl.set(url, rec.path);
      candidates.push({ url: url || ctx.url, text: scriptSource, sourceMapURL: rec.sourceMapURL });
    } catch (e) {
      result.warnings.push(`Script ${rec.url}: ${errMsg(e)}`);
    }
  });
  if (dynamicSkipped) result.warnings.push(`${dynamicSkipped} dynamisch erzeugte Scripts (eval) nicht exportiert (max. ${MAX_DYNAMIC}).`);

  // 3) Source Maps
  ctx.shared.scripts = scripts;
  ctx.shared.sourceMaps = await extractSourceMaps(ctx, candidates, result, alloc);

  index.sort((a, b) => a.url.localeCompare(b.url));
  result.files['sources/index.json'] = JSON.stringify({ method: 'Chrome DevTools Protocol (Page.getResourceContent, Debugger.getScriptSource)', resources: index }, null, 2);
  const skipped = index.filter((i) => i.skipped).length;
  if (skipped) result.warnings.push(`${skipped} Ressource(n) nicht exportiert – siehe sources/index.json.`);
  return result;
};
