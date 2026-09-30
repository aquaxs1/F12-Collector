// Page capture (Chrome/CDP): full-page PNG screenshot + MHTML snapshot.
import type { Collector } from '@/lib/context';
import { base64ToBytes, formatBytes } from '@/lib/fetcher';
import { collectPageCaptureFallback } from '@/collectors/firefox/page-capture';

const MAX_DIM = 16000; // guard against GPU/allocation limits on very tall pages

export const collectPageCaptureChrome: Collector = async (ctx) => {
  if (!ctx.cdp) {
    const r = await collectPageCaptureFallback(ctx);
    r.warnings.unshift('Chrome debugger not attached – captured the visible area only, no MHTML.');
    return r;
  }
  const cdp = ctx.cdp;
  const result = { files: {} as Record<string, Uint8Array | string>, warnings: [] as string[] };
  await cdp.send('Page.enable').catch(() => {});

  // Full-page screenshot
  try {
    ctx.detail('screenshot');
    const metrics = await cdp.send<any>('Page.getLayoutMetrics');
    const size = metrics.cssContentSize ?? metrics.contentSize ?? {};
    let width = Math.ceil(size.width || 0);
    let height = Math.ceil(size.height || 0);
    let clipped = false;
    if (width > MAX_DIM) { width = MAX_DIM; clipped = true; }
    if (height > MAX_DIM) { height = MAX_DIM; clipped = true; }
    const params: any = { format: 'png', captureBeyondViewport: true };
    if (width > 0 && height > 0) params.clip = { x: 0, y: 0, width, height, scale: 1 };
    const shot = await cdp.send<any>('Page.captureScreenshot', params);
    const bytes = base64ToBytes(shot.data);
    if (bytes.byteLength > ctx.maxBytes) {
      ctx.skipped.push({ path: 'snapshot/page.png', reason: 'screenshot larger than limit', size: bytes.byteLength });
      result.warnings.push(`Full-page screenshot (${formatBytes(bytes.byteLength)}) exceeds the size limit and was skipped.`);
    } else {
      result.files['snapshot/page.png'] = bytes;
      if (clipped) result.warnings.push(`Page is very large; screenshot clipped to ${width}×${height}px.`);
    }
  } catch (e) {
    result.warnings.push(`Screenshot failed: ${String((e as Error).message ?? e)}`);
  }

  // MHTML snapshot
  try {
    ctx.detail('MHTML');
    const snap = await cdp.send<any>('Page.captureSnapshot', { format: 'mhtml' });
    const enc = new TextEncoder().encode(snap.data);
    if (enc.byteLength > ctx.maxBytes) {
      ctx.skipped.push({ path: 'snapshot/page.mhtml', reason: 'MHTML larger than limit', size: enc.byteLength });
      result.warnings.push(`MHTML snapshot (${formatBytes(enc.byteLength)}) exceeds the size limit and was skipped.`);
    } else {
      result.files['snapshot/page.mhtml'] = snap.data;
    }
  } catch (e) {
    result.warnings.push(`MHTML capture failed: ${String((e as Error).message ?? e)}`);
  }

  if (!Object.keys(result.files).length) throw new Error('Page capture produced no files');
  return result;
};
