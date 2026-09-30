// Coverage (Chrome/CDP only): how much of each JS script and CSS stylesheet actually ran.
// Captured in the job right after load (see lib/job.ts). Most meaningful with "Record & reload";
// in plain snapshot mode almost nothing has executed since tracking started.
import type { Collector } from '@/lib/context';
import { json } from '@/lib/context';
import { isExtensionUrl } from './sources';

function mergedUsed(ranges: { startOffset: number; endOffset: number; count: number }[]): { used: number; total: number } {
  let total = 0;
  const covered: [number, number][] = [];
  for (const r of ranges) {
    total = Math.max(total, r.endOffset);
    if (r.count > 0) covered.push([r.startOffset, r.endOffset]);
  }
  covered.sort((a, b) => a[0] - b[0]);
  let used = 0;
  let curStart = -1;
  let curEnd = -1;
  for (const [s, e] of covered) {
    if (s > curEnd) {
      if (curEnd > curStart) used += curEnd - curStart;
      curStart = s;
      curEnd = e;
    } else if (e > curEnd) curEnd = e;
  }
  if (curEnd > curStart) used += curEnd - curStart;
  return { used, total };
}

const pct = (used: number, total: number) => (total > 0 ? Math.round((used / total) * 1000) / 10 : 0);

export const collectCoverage: Collector = async (ctx) => {
  const result = { files: {} as Record<string, string>, warnings: [] as string[] };
  const cov = ctx.shared.coverage;
  if (!ctx.cdp) throw new Error('Coverage requires the Chrome debugger (chrome.debugger), which could not be attached.');
  if (!cov?.started) throw new Error('Coverage tracking was not started.');

  // JS coverage
  const js: any[] = [];
  let jsUsed = 0;
  let jsTotal = 0;
  for (const entry of cov.js ?? []) {
    const url: string = entry.url ?? '';
    if (!url || isExtensionUrl(url)) continue;
    const ranges = (entry.functions ?? []).flatMap((f: any) => f.ranges ?? []);
    const { used, total } = mergedUsed(ranges);
    if (total === 0) continue;
    jsUsed += used;
    jsTotal += total;
    js.push({ url, totalBytes: total, usedBytes: used, unusedBytes: total - used, usedPercent: pct(used, total) });
  }
  js.sort((a, b) => b.unusedBytes - a.unusedBytes);

  // CSS coverage
  const cssBySheet = new Map<string, { used: number; total: number }>();
  for (const c of cov.css ?? []) {
    const agg = cssBySheet.get(c.styleSheetId) ?? { used: 0, total: 0 };
    if (c.used) agg.used += c.endOffset - c.startOffset;
    agg.total = Math.max(agg.total, c.endOffset);
    cssBySheet.set(c.styleSheetId, agg);
  }
  const css: any[] = [];
  let cssUsed = 0;
  let cssTotal = 0;
  for (const [id, agg] of cssBySheet) {
    const sheet = cov.cssSheets[id];
    const total = sheet?.length ?? agg.total;
    cssUsed += agg.used;
    cssTotal += total;
    css.push({ url: sheet?.url || `(inline sheet ${id})`, totalBytes: total, usedBytes: agg.used, unusedBytes: Math.max(0, total - agg.used), usedPercent: pct(agg.used, total) });
  }
  css.sort((a, b) => b.unusedBytes - a.unusedBytes);

  result.files['coverage/js-coverage.json'] = json({ note: 'Per-script byte coverage since tracking started (Profiler.takePreciseCoverage).', scripts: js });
  result.files['coverage/css-coverage.json'] = json({ note: 'Per-stylesheet byte coverage (CSS.takeCoverageDelta).', stylesheets: css });
  result.files['coverage/summary.json'] = json({
    mode: ctx.mode === 'record' ? 'Record & reload (load-time coverage)' : 'Snapshot (little code has run since tracking started – use Record & reload)',
    js: { scripts: js.length, totalBytes: jsTotal, usedBytes: jsUsed, usedPercent: pct(jsUsed, jsTotal) },
    css: { stylesheets: css.length, totalBytes: cssTotal, usedBytes: cssUsed, usedPercent: pct(cssUsed, cssTotal) },
  });

  if (ctx.mode !== 'record') result.warnings.push('Coverage in snapshot mode is near-empty; use "Record & reload" to measure what runs during page load.');
  if (!js.length && !css.length) result.warnings.push('No coverage data captured.');
  return result;
};
