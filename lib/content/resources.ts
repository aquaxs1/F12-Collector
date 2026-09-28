// List of all scripts, stylesheets and loaded resources of a frame.
import type { FrameData, PerfEntryInfo, ScriptInfo, StylesheetInfo } from '../types';
import { cssPath } from './util';

function perf(e: PerformanceResourceTiming): PerfEntryInfo {
  return {
    name: e.name,
    initiatorType: e.initiatorType,
    startTime: e.startTime,
    duration: e.duration,
    transferSize: e.transferSize,
    encodedBodySize: e.encodedBodySize,
    decodedBodySize: e.decodedBodySize,
    nextHopProtocol: e.nextHopProtocol,
    responseStatus: (e as any).responseStatus,
  };
}

export function collectResources(): NonNullable<FrameData['resources']> {
  const scripts: ScriptInfo[] = Array.from(document.scripts).map((s, index) => ({
    index,
    src: s.src || undefined,
    inline: s.src ? undefined : s.textContent ?? '',
    type: s.type || undefined,
  }));
  const stylesheets: StylesheetInfo[] = [];
  document.querySelectorAll('link[rel~="stylesheet"][href], style').forEach((el, index) => {
    if (el instanceof HTMLLinkElement) stylesheets.push({ index, href: el.href, owner: cssPath(el), media: el.media || undefined });
    else stylesheets.push({ index, text: el.textContent ?? '', owner: cssPath(el) });
  });
  const entries = performance.getEntriesByType('resource') as PerformanceResourceTiming[];
  const nav = performance.getEntriesByType('navigation')[0] as PerformanceResourceTiming | undefined;
  return {
    scripts,
    stylesheets,
    performance: entries.map(perf),
    timeOrigin: performance.timeOrigin,
    navigation: nav ? perf(nav) : undefined,
  };
}
