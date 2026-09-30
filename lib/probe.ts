// Reads the MAIN-world probe buffers (see entrypoints/probe.content.ts) from every frame.
import { browser } from 'wxt/browser';
import { errMsg, withTimeout } from './fetcher';
import type { FrameProbe } from './types';

function readProbe() {
  const p = (window as any).__F12C_PROBE__;
  if (!p) return { __missing: true };
  try {
    return p.dump();
  } catch (e) {
    return { __error: String(e) };
  }
}

export async function collectProbe(tabId: number, timeoutMs = 15000): Promise<{ frames: FrameProbe[]; warnings: string[] }> {
  const warnings: string[] = [];
  let results: { frameId: number; result?: any }[];
  try {
    results = (await withTimeout(
      browser.scripting.executeScript({ target: { tabId, allFrames: true }, world: 'MAIN', func: readProbe } as any) as any,
      timeoutMs,
      'Probe',
    )) as any;
  } catch (e) {
    return { frames: [], warnings: [`Probe: ${errMsg(e)}`] };
  }
  const frames: FrameProbe[] = [];
  let missing = 0;
  for (const r of results) {
    const v = r.result;
    if (!v || v.__missing) {
      missing++;
      continue;
    }
    if (v.__error) {
      warnings.push(`Probe frame ${r.frameId}: ${v.__error}`);
      continue;
    }
    frames.push({
      frameUrl: '',
      isTop: r.frameId === 0,
      installedAtDocumentStart: !!v.installedAtDocumentStart,
      console: v.console ?? [],
      consoleDropped: v.consoleDropped ?? 0,
      errors: v.errors ?? [],
      ws: v.ws ?? [],
      vitals: v.vitals ?? {},
      globals: v.globals ?? [],
      navigation: v.navigation,
    });
  }
  if (missing && !frames.length)
    warnings.push(
      `Probe not present in ${missing} frame(s) – console/websockets/web-vitals/window-globals need the page to have loaded with the extension installed. Use "Record & reload" for complete data.`,
    );
  return { frames, warnings };
}
