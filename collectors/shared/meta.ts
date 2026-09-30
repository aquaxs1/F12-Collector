// Meta files: passively fetch well-known same-origin files (robots.txt, sitemap.xml,
// security.txt, etc.). Same-origin only – never foreign hosts. These are ordinary published
// files; fetching them is the documented, allowed exception to "no requests".
import type { Collector } from '@/lib/context';
import { json } from '@/lib/context';
import { decodeUtf8, fetchResource, mapLimit } from '@/lib/fetcher';
import { sanitizeSegment } from '@/lib/paths';

const PATHS = [
  '/robots.txt',
  '/sitemap.xml',
  '/sitemap_index.xml',
  '/.well-known/security.txt',
  '/security.txt',
  '/humans.txt',
  '/ads.txt',
  '/app-ads.txt',
  '/.well-known/change-password',
  '/.well-known/assetlinks.json',
  '/.well-known/apple-app-site-association',
  '/.well-known/openid-configuration',
  '/.well-known/dnt-policy.txt',
  '/manifest.json',
  '/favicon.ico',
];

export const collectMeta: Collector = async (ctx) => {
  const result = { files: {} as Record<string, string | Uint8Array>, warnings: [] as string[] };
  let origin: string;
  try {
    origin = new URL(ctx.url).origin;
  } catch {
    throw new Error('cannot determine page origin');
  }
  if (!/^https?:$/.test(new URL(ctx.url).protocol)) throw new Error('meta files need an http(s) origin');

  const index: any[] = [];
  let done = 0;
  await mapLimit(PATHS, 4, async (path) => {
    ctx.detail(`meta ${++done}/${PATHS.length}`);
    const url = origin + path;
    const res = await fetchResource(url, ctx.maxBytes, 8000);
    if (res.ok && res.bytes) {
      // Skip SPA fallbacks: many sites return index.html for unknown paths
      const isHtml = /text\/html/i.test(res.contentType);
      const wantsHtml = path.endsWith('.json') === false && (path.endsWith('.txt') || path.endsWith('.xml'));
      if (isHtml && wantsHtml) {
        index.push({ path, status: res.status, skipped: 'looks like an HTML fallback (not the real file)' });
        return;
      }
      const name = sanitizeSegment(path.replace(/^\//, '').replace(/\//g, '_')) || 'index';
      const file = `meta/${name}`;
      result.files[file] = res.contentType.startsWith('image/') ? res.bytes : decodeUtf8(res.bytes);
      index.push({ path, status: res.status, contentType: res.contentType, size: res.size, file: name });
    } else {
      index.push({ path, status: res.status || undefined, error: res.error ?? res.skippedReason });
    }
  });

  const found = index.filter((i) => i.file);
  result.files['meta/index.json'] = json({ note: 'Well-known same-origin files, fetched passively.', origin, found: found.length, entries: index });
  if (!found.length) result.warnings.push('No well-known meta files found (all 404 / unavailable).');
  return result;
};
