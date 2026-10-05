// Assets: the images, fonts and media the page already loaded, saved as files sorted by type.
// URLs come from Resource Timing (per frame); each is re-read (cache-first) in the background.
// Passive: only assets the page itself loaded are fetched, never new/foreign pages.
import type { Collector } from '@/lib/context';
import { fetchResource, formatBytes, mapLimit } from '@/lib/fetcher';
import { json } from '@/lib/context';
import { PathAllocator, isHttpUrl, urlToPath } from '@/lib/paths';

const MAX_ASSETS = 500;
const IMG_EXT = /\.(png|jpe?g|gif|webp|avif|ico|bmp|svg)(\?|#|$)/i;
const FONT_EXT = /\.(woff2?|ttf|otf|eot)(\?|#|$)/i;
const MEDIA_EXT = /\.(mp4|webm|ogg|ogv|mov|m4v|mp3|wav|m4a|flac|aac)(\?|#|$)/i;
const ASSET_INITIATOR = new Set(['img', 'image', 'imageset', 'media', 'video', 'audio']);

function categoryFromMime(mime: string, url: string): string | null {
  const m = mime.toLowerCase();
  if (m.startsWith('image/')) return m.includes('svg') ? 'images/svg' : 'images';
  if (m.startsWith('font/') || m.includes('font') || FONT_EXT.test(url)) return 'fonts';
  if (m.startsWith('video/')) return 'video';
  if (m.startsWith('audio/')) return 'audio';
  if (IMG_EXT.test(url)) return url.match(/\.svg/i) ? 'images/svg' : 'images';
  if (MEDIA_EXT.test(url)) return /\.(mp3|wav|m4a|flac|aac|ogg)(\?|#|$)/i.test(url) ? 'audio' : 'video';
  return null;
}

export const collectAssets: Collector = async (ctx) => {
  const result = { files: {} as Record<string, Uint8Array | string>, warnings: [] as string[] };
  const wanted = new Map<string, string>(); // url -> frame url

  for (const f of ctx.frames) {
    for (const p of f.resources?.performance ?? []) {
      if (!isHttpUrl(p.name) || wanted.has(p.name)) continue;
      const looksAsset = ASSET_INITIATOR.has(p.initiatorType) || IMG_EXT.test(p.name) || FONT_EXT.test(p.name) || MEDIA_EXT.test(p.name);
      if (looksAsset) wanted.set(p.name, f.url);
    }
  }
  if (!ctx.frames.some((f) => f.resources)) result.warnings.push('No resource list from the content script – assets rely on Resource Timing.');

  const list = Array.from(wanted.keys()).slice(0, MAX_ASSETS);
  if (wanted.size > list.length) result.warnings.push(`Only the first ${MAX_ASSETS} of ${wanted.size} assets were saved.`);

  const alloc = new PathAllocator();
  const index: any[] = [];
  const byType: Record<string, number> = {};
  let done = 0;

  await mapLimit(list, 8, async (url) => {
    ctx.detail(`assets ${++done}/${list.length}`);
    const res = await fetchResource(url, ctx.maxBytes);
    if (!res.bytes || !res.ok) {
      const reason = res.skippedReason ?? res.error ?? `HTTP ${res.status}`;
      index.push({ url, skipped: reason, size: res.size || undefined });
      if (res.skippedReason) ctx.skipped.push({ path: `assets → ${url}`, reason, size: res.size });
      return;
    }
    const category = categoryFromMime(res.contentType, url) ?? 'other';
    const path = alloc.allocate(urlToPath(url, `assets/${category}`));
    result.files[path] = res.bytes;
    byType[category] = (byType[category] ?? 0) + 1;
    index.push({ url, path: path.replace(/^assets\//, ''), type: category, mime: res.contentType, size: res.size, frame: wanted.get(url) });
  });

  index.sort((a, b) => String(a.url).localeCompare(String(b.url)));
  result.files['assets/index.json'] = json({
    note: 'Images, fonts and media the page loaded, re-read from the browser cache. No new page loads.',
    counts: byType,
    total: index.length,
    assets: index,
  });
  if (!list.length) result.warnings.push('No assets found in the Resource Timing data.');
  const skipped = index.filter((i) => i.skipped).length;
  if (skipped) result.warnings.push(`${skipped} asset(s) not saved (size limit ${formatBytes(ctx.maxBytes)} or load error) – see assets/index.json.`);
  return result;
};
