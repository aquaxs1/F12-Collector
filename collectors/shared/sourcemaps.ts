// Resolve source maps and reconstruct original files (same for Chrome & Firefox).
import type { JobContext, SourceMapRecord } from '@/lib/context';
import { base64ToBytes, decodeUtf8, errMsg, fetchResource, mapLimit } from '@/lib/fetcher';
import { PathAllocator, sanitizePath, urlToPath } from '@/lib/paths';
import type { CollectorResult } from '@/lib/types';

export interface SourceMapCandidate {
  /** URL of the generated file (JS or CSS) */
  url: string;
  text?: string;
  /** already known sourceMappingURL (e.g. from CDP scriptParsed) */
  sourceMapURL?: string;
}

const SMURL = /\/[\/*][#@]\s*sourceMappingURL\s*=\s*([^\s'"*]+)/g;

export function findSourceMappingURL(text: string): string | undefined {
  // Only scan the end – that is practically always where the comment is
  const tail = text.length > 20000 ? text.slice(-20000) : text;
  let last: string | undefined;
  for (const m of tail.matchAll(SMURL)) last = m[1];
  return last;
}

/** Path for an original file from a source map, e.g. webpack://app/./src/x.ts → sources/original/webpack/app/src/x.ts */
export function originalPath(source: string): string {
  let s = source.replace(/\?.*$/, '');
  const scheme = /^([a-z][a-z0-9+.-]*):\/\/+/i.exec(s);
  if (scheme) {
    const proto = (scheme[1] ?? '').toLowerCase();
    s = s.slice(scheme[0].length);
    if (proto !== 'http' && proto !== 'https') s = `${proto}/${s}`;
  }
  const parts: string[] = [];
  for (const p of s.split('/')) {
    if (p === '' || p === '.') continue;
    if (p === '..') {
      parts.push('__');
      continue;
    }
    parts.push(p);
  }
  return `sources/original/${sanitizePath(parts.join('/')) || 'unnamed'}`;
}

interface RawMap {
  version?: number;
  sources?: string[];
  sourcesContent?: (string | null)[];
  sourceRoot?: string;
  sections?: { map?: RawMap; url?: string }[];
}

function resolve(ref: string, base: string): string | undefined {
  try {
    return new URL(ref, base).href;
  } catch {
    return undefined;
  }
}

export async function extractSourceMaps(
  ctx: JobContext,
  candidates: SourceMapCandidate[],
  result: CollectorResult,
  alloc: PathAllocator,
): Promise<SourceMapRecord[]> {
  const records: SourceMapRecord[] = [];
  const seenMaps = new Set<string>();
  const writtenOriginals = new Set<string>();
  let fetchBudget = 500; // max. original files downloaded when sourcesContent is missing
  const jobs: { cand: SourceMapCandidate; ref: string }[] = [];
  for (const cand of candidates) {
    const ref = cand.sourceMapURL || (cand.text ? findSourceMappingURL(cand.text) : undefined);
    if (!ref) continue;
    const key = ref.startsWith('data:') ? `${cand.url}#inline` : resolve(ref, cand.url) ?? ref;
    if (seenMaps.has(key)) continue;
    seenMaps.add(key);
    jobs.push({ cand, ref });
  }
  const limited = jobs.slice(0, ctx.settings.maxSourceMaps);
  if (jobs.length > limited.length)
    result.warnings.push(`Only ${limited.length} of ${jobs.length} source maps processed (limit in the settings).`);

  let done = 0;
  await mapLimit(limited, 4, async ({ cand, ref }) => {
    ctx.detail(`source maps ${++done}/${limited.length}`);
    const rec: SourceMapRecord = { forUrl: cand.url, mapUrl: ref.startsWith('data:') ? '(inline data:-URL)' : resolve(ref, cand.url) ?? ref, sources: 0, reconstructed: 0 };
    records.push(rec);
    try {
      let mapText: string;
      let mapPathUrl: string;
      if (ref.startsWith('data:')) {
        const comma = ref.indexOf(',');
        const meta = ref.slice(5, comma);
        const payload = ref.slice(comma + 1);
        mapText = /;base64/i.test(meta) ? decodeUtf8(base64ToBytes(decodeURIComponent(payload))) : decodeURIComponent(payload);
        mapPathUrl = cand.url;
      } else {
        const abs = resolve(ref, cand.url);
        if (!abs || !/^https?:/i.test(abs)) throw new Error(`URL cannot be downloaded: ${ref}`);
        const res = await fetchResource(abs, ctx.maxBytes);
        if (!res.bytes) throw new Error(res.skippedReason ?? res.error ?? `HTTP ${res.status}`);
        if (!res.ok) throw new Error(`HTTP ${res.status}`);
        mapText = decodeUtf8(res.bytes);
        mapPathUrl = abs;
      }
      const mapPath = alloc.allocate(urlToPath(mapPathUrl, 'sources/sourcemaps').replace(/(\.map)?$/, '.map'));
      rec.path = mapPath;
      result.files[mapPath] = mapText;
      const raw = JSON.parse(mapText.replace(/^\)\]\}'[^\n]*\n/, '')) as RawMap;
      const maps: { map: RawMap; base: string }[] = [];
      const baseUrl = ref.startsWith('data:') ? cand.url : resolve(ref, cand.url) ?? cand.url;
      if (raw.sections) for (const s of raw.sections) {
        if (s.map) maps.push({ map: s.map, base: baseUrl });
      }
      else maps.push({ map: raw, base: baseUrl });

      for (const { map, base } of maps) {
        const sources = map.sources ?? [];
        rec.sources += sources.length;
        for (let i = 0; i < sources.length; i++) {
          const src = sources[i];
          if (!src) continue;
          const full = map.sourceRoot ? map.sourceRoot.replace(/\/?$/, '/') + src : src;
          const path = originalPath(full);
          if (writtenOriginals.has(path)) continue;
          let content = map.sourcesContent?.[i] ?? null;
          if (content == null && fetchBudget > 0) {
            const abs = resolve(full, base);
            if (abs && /^https?:/i.test(abs)) {
              fetchBudget--;
              const res = await fetchResource(abs, ctx.maxBytes, 10000);
              if (res.ok && res.bytes) content = decodeUtf8(res.bytes);
            }
          }
          if (content == null) continue;
          writtenOriginals.add(path);
          result.files[alloc.allocate(path)] = content;
          rec.reconstructed++;
        }
      }
    } catch (e) {
      rec.error = errMsg(e);
    }
  });
  const failed = records.filter((r) => r.error);
  if (failed.length) result.warnings.push(`${failed.length} source map(s) could not be loaded (details in sources/sourcemaps/index.json).`);
  if (records.length) result.files['sources/sourcemaps/index.json'] = JSON.stringify(records, null, 2);
  return records;
}
