// Quellcode (Fallback/Firefox): Ressourcen per fetch neu laden, Inline-Scripts aus dem DOM.
import { extractSourceMaps, type SourceMapCandidate } from '@/collectors/shared/sourcemaps';
import type { Collector, ScriptRecord } from '@/lib/context';
import { decodeUtf8, fetchResource, formatBytes, isTextMime, mapLimit } from '@/lib/fetcher';
import { PathAllocator, isHttpUrl, stripHash, urlToPath } from '@/lib/paths';
import type { CollectorResult } from '@/lib/types';

/** Ressourcentypen aus der Resource-Timing-API, die gefahrlos erneut geladen werden (GET, keine API-Aufrufe). */
const REFETCH_TYPES = new Set(['script', 'link', 'css', 'img', 'iframe', 'frame', 'other', 'navigation', 'font', 'image']);

function extOf(url: string, mime: string): string {
  if (/javascript|ecmascript/.test(mime)) return '.js';
  if (/css/.test(mime)) return '.css';
  if (/html/.test(mime)) return '.html';
  if (/json/.test(mime)) return '.json';
  return '';
}

export const collectSourcesFallback: Collector = async (ctx) => {
  const result: CollectorResult = { files: {}, warnings: [] };
  const alloc = new PathAllocator();
  const scripts: ScriptRecord[] = [];
  const candidates: SourceMapCandidate[] = [];

  // 1) Alle URLs sammeln
  const urls = new Map<string, 'document' | 'script' | 'stylesheet' | 'other'>();
  for (const f of ctx.frames) {
    if (isHttpUrl(f.url)) urls.set(stripHash(f.url), 'document');
    const r = f.resources;
    if (!r) continue;
    for (const s of r.scripts) if (isHttpUrl(s.src)) urls.set(s.src, 'script');
    for (const s of r.stylesheets) if (isHttpUrl(s.href)) urls.set(s.href, 'stylesheet');
    for (const p of r.performance) if (isHttpUrl(p.name) && REFETCH_TYPES.has(p.initiatorType) && !urls.has(p.name)) urls.set(p.name, 'other');
  }
  if (!ctx.frames.some((f) => f.resources)) result.warnings.push('Keine Ressourcenliste aus dem Content Script – nur die Seiten-URL wird geladen.');
  if (!urls.size && isHttpUrl(ctx.url)) urls.set(ctx.url, 'document');

  // 2) Neu laden (aus dem Browser-Cache, falls vorhanden)
  const list = Array.from(urls.entries());
  let done = 0;
  const index: { url: string; path?: string; kind: string; size?: number; status?: number; skipped?: string }[] = [];
  await mapLimit(list, 6, async ([url, kind]) => {
    ctx.detail(`Ressourcen laden ${++done}/${list.length}`);
    const res = await fetchResource(url, ctx.maxBytes);
    if (!res.bytes) {
      const reason = res.skippedReason ?? res.error ?? `HTTP ${res.status}`;
      index.push({ url, kind, skipped: reason, size: res.size || undefined });
      if (res.skippedReason) ctx.skipped.push({ path: url, reason, size: res.size });
      return;
    }
    const path = alloc.allocate(urlToPath(url, 'sources', extOf(url, res.contentType)));
    const text = isTextMime(res.contentType) || kind === 'script' || kind === 'stylesheet' || kind === 'document';
    const content = text ? decodeUtf8(res.bytes) : res.bytes;
    result.files[path] = content;
    index.push({ url, kind, path, size: res.size, status: res.status });
    if (typeof content === 'string' && (kind === 'script' || /javascript|css/.test(res.contentType) || /\.(m?js|css)(\?|$)/.test(url))) {
      candidates.push({ url, text: content });
      if (kind === 'script' || /javascript/.test(res.contentType))
        scripts.push({ url, path, kind: 'external', length: content.length });
    }
  });

  // 3) Inline-Scripts und -Styles aus dem DOM
  for (const f of ctx.frames) {
    const r = f.resources;
    if (!r) continue;
    const base = urlToPath(f.url, 'sources/_inline', '.html').replace(/\.[a-z0-9]+$/i, '');
    for (const s of r.scripts) {
      if (s.src || !s.inline?.trim()) continue;
      const ext = s.type && /json/.test(s.type) ? '.json' : s.type && !/(java|ecma)script|module/.test(s.type) ? '.txt' : '.js';
      const path = alloc.allocate(`${base}/script-${s.index}${ext}`);
      result.files[path] = s.inline;
      scripts.push({ url: f.url, path, kind: 'inline', length: s.inline.length, isModule: s.type === 'module' });
      candidates.push({ url: f.url, text: s.inline });
    }
    for (const s of r.stylesheets) {
      if (s.href || !s.text?.trim()) continue;
      const path = alloc.allocate(`${base}/style-${s.index}.css`);
      result.files[path] = s.text;
    }
  }

  // 4) Source Maps
  ctx.shared.scripts = scripts;
  ctx.shared.sourceMaps = await extractSourceMaps(ctx, candidates, result, alloc);

  index.sort((a, b) => a.url.localeCompare(b.url));
  result.files['sources/index.json'] = JSON.stringify({ method: 'fetch (neu geladen, bevorzugt aus dem Browser-Cache)', resources: index }, null, 2);
  const skipped = index.filter((i) => i.skipped).length;
  if (skipped) result.warnings.push(`${skipped} Ressource(n) nicht exportiert (Limit ${formatBytes(ctx.maxBytes)} oder Ladefehler) – siehe sources/index.json.`);
  result.warnings.push('Quellcode wurde per fetch neu geladen; dynamisch erzeugter Code (eval, new Function) ist nicht enthalten.');
  return result;
};
