// Content Script in allen Frames aufrufen und die Ergebnisse einsammeln.
import { browser } from 'wxt/browser';
import { errMsg, withTimeout } from './fetcher';
import type { ContentCollectOptions, FrameData } from './types';

function callCollect(opts: ContentCollectOptions) {
  const g = globalThis as any;
  if (!g.__F12C__) return { __missing: true };
  return g.__F12C__.collect(opts);
}

async function run(tabId: number, opts: ContentCollectOptions) {
  return browser.scripting.executeScript({
    target: { tabId, allFrames: true },
    func: callCollect,
    args: [opts],
  } as any) as Promise<{ frameId: number; result?: any; error?: any }[]>;
}

export async function collectFromFrames(
  tabId: number,
  opts: ContentCollectOptions,
  timeoutMs: number,
): Promise<{ frames: FrameData[]; warnings: string[] }> {
  const warnings: string[] = [];
  let results = await withTimeout(run(tabId, opts), timeoutMs, 'Content Script');
  // Tabs, die vor der Installation geöffnet wurden, haben noch kein Content Script → nachladen
  if (results.some((r) => r.result?.__missing)) {
    try {
      await browser.scripting.executeScript({ target: { tabId, allFrames: true }, files: ['/content-scripts/content.js'] });
      results = await withTimeout(run(tabId, opts), timeoutMs, 'Content Script');
    } catch (e) {
      warnings.push(`Content Script konnte nicht nachgeladen werden: ${errMsg(e)}`);
    }
  }
  const frames: FrameData[] = [];
  for (const r of results) {
    if (r.error) {
      warnings.push(`Frame ${r.frameId}: ${errMsg(r.error)}`);
      continue;
    }
    if (!r.result || r.result.__missing) {
      warnings.push(`Frame ${r.frameId}: kein Ergebnis vom Content Script`);
      continue;
    }
    frames.push({ ...(r.result as Omit<FrameData, 'frameId'>), frameId: r.frameId });
  }
  frames.sort((a, b) => a.frameId - b.frameId);
  return { frames, warnings };
}
