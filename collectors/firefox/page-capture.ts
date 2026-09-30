// Page capture (fallback/Firefox): visible-area screenshot via tabs.captureVisibleTab.
// Firefox extensions cannot capture a full-page screenshot or MHTML.
import { browser } from 'wxt/browser';
import type { Collector } from '@/lib/context';
import { base64ToBytes, formatBytes } from '@/lib/fetcher';

export const collectPageCaptureFallback: Collector = async (ctx) => {
  const result = { files: {} as Record<string, Uint8Array | string>, warnings: [] as string[] };
  try {
    const tab = await browser.tabs.get(ctx.tabId);
    ctx.detail('visible-area screenshot');
    const dataUrl = await browser.tabs.captureVisibleTab(tab.windowId!, { format: 'png' } as any);
    const b64 = dataUrl.split(',')[1] ?? '';
    const bytes = base64ToBytes(b64);
    if (bytes.byteLength > ctx.maxBytes) {
      ctx.skipped.push({ path: 'snapshot/viewport.png', reason: 'screenshot larger than limit', size: bytes.byteLength });
      result.warnings.push(`Screenshot (${formatBytes(bytes.byteLength)}) exceeds the size limit and was skipped.`);
    } else {
      result.files['snapshot/viewport.png'] = bytes;
    }
  } catch (e) {
    throw new Error(`captureVisibleTab failed: ${String((e as Error).message ?? e)}`);
  }
  result.warnings.push('Firefox: only the visible viewport was captured (no full-page screenshot, no MHTML).');
  return result;
};
