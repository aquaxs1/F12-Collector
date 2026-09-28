// DOM (Fallback/Firefox): serialisiertes HTML aus dem Content Script, alle Frames.
import type { Collector } from '@/lib/context';
import { PathAllocator, hostOf } from '@/lib/paths';
import type { CollectorResult, FrameData } from '@/lib/types';

/** Schreibt Frames (außer dem Hauptframe) nach dom/frames/. */
export function writeFrames(frames: FrameData[], result: CollectorResult, skipUrls = new Set<string>()) {
  const alloc = new PathAllocator();
  const index: { frameId: number; url: string; file?: string; error?: string }[] = [];
  for (const f of frames) {
    if (f.isTop && f.frameId === 0) continue;
    if (skipUrls.has(f.url)) continue;
    if (!f.dom) {
      index.push({ frameId: f.frameId, url: f.url, error: f.errors.join('; ') || 'kein DOM' });
      continue;
    }
    const file = alloc.allocate(`dom/frames/${f.frameId}_${hostOf(f.url).replace(/[^\w.-]/g, '_')}.html`);
    result.files[file] = f.dom.html;
    index.push({ frameId: f.frameId, url: f.url, file: file.slice(4) });
  }
  if (index.length) result.files['dom/frames/index.json'] = JSON.stringify(index, null, 2);
}

export const collectDomFallback: Collector = async (ctx) => {
  const result: CollectorResult = { files: {}, warnings: [] };
  const top = ctx.frames.find((f) => f.frameId === 0);
  if (!top?.dom) throw new Error('Kein DOM vom Hauptframe erhalten' + (top?.errors.length ? `: ${top.errors.join('; ')}` : ''));
  result.files['dom/index.html'] = top.dom.html;
  writeFrames(ctx.frames, result);
  const shadow = ctx.frames.flatMap((f) => (f.dom?.shadowRoots ?? []).map((s) => ({ frameUrl: f.url, ...s })));
  result.files['dom/shadow-roots.json'] = JSON.stringify(shadow, null, 2);
  for (const f of ctx.frames) for (const e of f.errors) if (e.startsWith('DOM')) result.warnings.push(`Frame ${f.url}: ${e}`);
  return result;
};
