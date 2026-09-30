// Event listeners (Chrome/CDP only): DOMDebugger.getEventListeners for window, document and a
// capped set of elements. Firefox has no equivalent extension API → marked unavailable.
import type { Collector } from '@/lib/context';
import { json } from '@/lib/context';
import { errMsg } from '@/lib/fetcher';
import { redactTokensInString } from '@/lib/redact';

const MAX_ELEMENTS = 800;

export const collectEventListeners: Collector = async (ctx) => {
  const cdp = ctx.cdp;
  const result = { files: {} as Record<string, string>, warnings: [] as string[] };
  const red = (v: string) => (ctx.settings.redact ? redactTokensInString(v) : v);
  if (!cdp) throw new Error('Event listeners require the Chrome debugger (chrome.debugger), which could not be attached.');
  if (ctx.shared.pausedEvent) {
    result.warnings.push('Page is paused in the debugger: event listeners cannot be read.');
    result.files['dom/event-listeners.json'] = json({ paused: true, elements: [] });
    return result;
  }

  await cdp.send('Runtime.enable').catch(() => {});
  await cdp.send('DOM.enable').catch(() => {});

  // Build an array of targets in the page: [window, document, ...elements] (capped).
  const arr = await cdp.send<any>('Runtime.evaluate', {
    expression: `(() => { const a=[window, document]; const els=document.getElementsByTagName('*'); for (let i=0;i<els.length && a.length<${MAX_ELEMENTS + 2};i++) a.push(els[i]); return a; })()`,
    returnByValue: false,
  });
  const arrayId = arr.result?.objectId;
  if (!arrayId) throw new Error('could not enumerate DOM nodes');

  const props = await cdp.send<any>('Runtime.getProperties', { objectId: arrayId, ownProperties: true });
  const targets = (props.result ?? []).filter((p: any) => /^\d+$/.test(p.name) && p.value?.objectId);

  const elements: any[] = [];
  let total = 0;
  let done = 0;
  for (const t of targets) {
    ctx.detail(`listeners ${++done}/${targets.length}`);
    const objectId = t.value.objectId;
    try {
      const { listeners } = await cdp.send<any>('DOMDebugger.getEventListeners', { objectId, depth: 0 });
      if (listeners && listeners.length) {
        total += listeners.length;
        elements.push({
          target: describe(t.value),
          listeners: listeners.map((l: any) => ({
            type: l.type,
            useCapture: l.useCapture,
            passive: l.passive,
            once: l.once,
            scriptId: l.scriptId,
            line: (l.lineNumber ?? 0) + 1,
            column: (l.columnNumber ?? 0) + 1,
            handler: l.handler?.description ? red(String(l.handler.description).slice(0, 300)) : l.handler?.className,
          })),
        });
      }
    } catch {
      /* node went away */
    } finally {
      await cdp.send('Runtime.releaseObject', { objectId }).catch(() => {});
    }
  }
  await cdp.send('Runtime.releaseObject', { objectId: arrayId }).catch(() => {});

  result.files['dom/event-listeners.json'] = json({
    note: `Event listeners registered via addEventListener, read with DOMDebugger.getEventListeners. Scanned window, document and up to ${MAX_ELEMENTS} elements.`,
    scannedTargets: targets.length,
    elementsWithListeners: elements.length,
    totalListeners: total,
    elements,
  });
  if (targets.length >= MAX_ELEMENTS) result.warnings.push(`Only the first ${MAX_ELEMENTS} elements were scanned for event listeners.`);
  void errMsg;
  return result;
};

function describe(v: any): string {
  if (v.className === 'Window') return 'window';
  if (v.subtype === 'node' && v.description) return v.description;
  return v.description || v.className || v.type || 'unknown';
}
