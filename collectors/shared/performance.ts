// Performance: Web Vitals (LCP, CLS, INP, FCP, TTFB) and long tasks from the probe's
// PerformanceObserver, plus navigation timing and a resource-timing summary per frame.
import type { Collector } from '@/lib/context';
import { json } from '@/lib/context';

const RATING = {
  lcp: [2500, 4000],
  cls: [0.1, 0.25],
  inp: [200, 500],
  fcp: [1800, 3000],
  ttfb: [800, 1800],
} as const;

function rate(metric: keyof typeof RATING, v?: number): string | undefined {
  if (v === undefined) return undefined;
  const [good, poor] = RATING[metric];
  return v <= good ? 'good' : v <= poor ? 'needs-improvement' : 'poor';
}

export const collectPerformance: Collector = async (ctx) => {
  const result = { files: {} as Record<string, string>, warnings: [] as string[] };
  const probe = ctx.shared.probe ?? [];
  const top = probe.find((f) => f.isTop) ?? probe[0];

  const vitals = top?.vitals ?? {};
  const webVitals = {
    LCP_ms: vitals.lcp,
    CLS: vitals.cls,
    INP_ms: vitals.inp,
    FCP_ms: vitals.fcp,
    TTFB_ms: vitals.ttfb,
    longTasks: vitals.longTasks,
    longTaskTotalMs: vitals.longTaskTotalMs,
    ratings: {
      LCP: rate('lcp', vitals.lcp),
      CLS: rate('cls', vitals.cls),
      INP: rate('inp', vitals.inp),
      FCP: rate('fcp', vitals.fcp),
      TTFB: rate('ttfb', vitals.ttfb),
    },
  };

  // Resource timing summary from the content-script resource lists
  const resourceSummary = ctx.frames
    .filter((f) => f.resources)
    .map((f) => {
      const byType: Record<string, { count: number; transferBytes: number; decodedBytes: number }> = {};
      for (const p of f.resources!.performance) {
        const t = (byType[p.initiatorType] ??= { count: 0, transferBytes: 0, decodedBytes: 0 });
        t.count++;
        t.transferBytes += p.transferSize ?? 0;
        t.decodedBytes += p.decodedBodySize ?? 0;
      }
      return { frameUrl: f.url, resourceCount: f.resources!.performance.length, byType, navigation: f.resources!.navigation };
    });

  result.files['performance/performance.json'] = json({
    note: 'Web Vitals via PerformanceObserver (probe). Field values reflect the current session; use "Record & reload" for load-time metrics like LCP/FCP.',
    url: ctx.url,
    webVitals,
    navigation: top?.navigation,
    resources: resourceSummary,
  });

  if (!probe.length) result.warnings.push('No Web Vitals (probe missing). Use "Record & reload" or reload with the extension installed.');
  else if (vitals.lcp === undefined && vitals.fcp === undefined)
    result.warnings.push('No paint/LCP metrics captured – for load-time vitals use "Record & reload".');
  return result;
};
