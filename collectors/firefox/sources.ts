// Sources (fallback/Firefox): re-download resources via fetch, inline scripts from the DOM.
import { extractSourceMaps, type SourceMapCandidate } from '@/collectors/shared/sourcemaps';
import type { Collector, ScriptRecord } from '@/lib/context';
import { decodeUtf8, fetchResource, formatBytes, isTextMime, mapLimit } from '@/lib/fetcher';
import { PathAllocator, isHttpUrl, stripHash, urlToPath } from '@/lib/paths';
import type { CollectorResult } from '@/lib/types';

/** Resource types from the Resource Timing API that are safe to re-download (GET, no API calls). */
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

  // 1) Collect all URLs
  const urls = new Map<string, 'document' | 'script' | 'stylesheet' | 'other'>();
  for (const f of ctx.frames) {
    if (isHttpUrl(f.url)) urls.set(stripHash(f.url), 'document');
    const r = f.resources;
    if (!r) continue;
    for (const s of r.scripts) if (isHttpUrl(s.src)) urls.set(s.src, 'script');
    for (const s of r.stylesheets) if (isHttpUrl(s.href)) urls.set(s.href, 'stylesheet');
    for (const p of r.performance) if (isHttpUrl(p.name) && REFETCH_TYPES.has(p.initiatorType) && !urls.has(p.name)) urls.set(p.name, 'other');
  }
  if (!ctx.frames.some((f) => f.resources)) result.warnings.push('No resource list from the content script – only the page URL is downloaded.');
  if (!urls.size && isHttpUrl(ctx.url)) urls.set(ctx.url, 'document');

  // 2) Re-download (from the browser cache, if available)
  const list = Array.from(urls.entries());
  let done = 0;
  const index: { url: string; path?: string; kind: string; size?: number; status?: number; skipped?: string }[] = [];
  await mapLimit(list, 6, async ([url, kind]) => {
    ctx.detail(`downloading resources ${++done}/${list.length}`);
    const res = await fetchResource(url, ctx.maxBytes);
    if (!res.bytes || !res.ok) {
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

  // 3) Inline scripts and styles from the DOM
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
  result.files['sources/index.json'] = JSON.stringify({ method: 'fetch (re-downloaded, preferably from the browser cache)', resources: index }, null, 2);
  const skipped = index.filter((i) => i.skipped).length;
  if (skipped) result.warnings.push(`${skipped} resource(s) not exported (limit ${formatBytes(ctx.maxBytes)} or download error) – see sources/index.json.`);
  result.warnings.push('Sources were re-downloaded via fetch; dynamically created code (eval, new Function) is not included.');
  return result;
};
