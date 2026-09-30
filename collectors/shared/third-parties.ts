// Third parties / trackers: foreign domains the page contacted and whether they set cookies.
// Passive: derived from Resource Timing + captured response headers only.
import type { Collector } from '@/lib/context';
import { json } from '@/lib/context';
import { eTldPlusOne, getResponses, hostOfUrl } from './responses';
import { redactTokensInString } from '@/lib/redact';

const KNOWN_TRACKERS = [
  'google-analytics.com', 'googletagmanager.com', 'doubleclick.net', 'google.com/ads', 'googlesyndication.com',
  'facebook.net', 'facebook.com', 'connect.facebook.net', 'fbcdn.net', 'hotjar.com', 'segment.com', 'segment.io',
  'mixpanel.com', 'amplitude.com', 'fullstory.com', 'clarity.ms', 'quantserve.com', 'scorecardresearch.com',
  'criteo.com', 'taboola.com', 'outbrain.com', 'adroll.com', 'bing.com', 'yandex.ru', 'matomo', 'newrelic.com',
  'sentry.io', 'intercom.io', 'optimizely.com', 'cloudflareinsights.com', 'adsrvr.org', 'pubmatic.com',
];

export const collectThirdParties: Collector = async (ctx) => {
  const result = { files: {} as Record<string, string>, warnings: [] as string[] };
  const pageHost = hostOfUrl(ctx.url) ?? '';
  const pageEtld = eTldPlusOne(pageHost);

  const { responses } = await getResponses(ctx).catch(() => ({ responses: [] as any[] }));
  const setsCookieByHost = new Map<string, boolean>();
  for (const r of responses) {
    const host = hostOfUrl(r.url);
    if (host && r.headers['set-cookie']) setsCookieByHost.set(host, true);
  }

  // Collect all contacted URLs
  const urls = new Set<string>();
  for (const f of ctx.frames) {
    if (f.url) urls.add(f.url);
    for (const p of f.resources?.performance ?? []) urls.add(p.name);
    for (const s of f.resources?.scripts ?? []) if (s.src) urls.add(s.src);
    for (const s of f.resources?.stylesheets ?? []) if (s.href) urls.add(s.href);
  }
  for (const r of responses) urls.add(r.url);

  const byHost = new Map<string, { host: string; etld1: string; count: number; types: Record<string, number>; samples: Set<string> }>();
  const typeOf = (u: string) => {
    if (/\.(js|mjs)(\?|#|$)/i.test(u)) return 'script';
    if (/\.css(\?|#|$)/i.test(u)) return 'stylesheet';
    if (/\.(png|jpe?g|gif|webp|avif|svg|ico)(\?|#|$)/i.test(u)) return 'image';
    if (/\.(woff2?|ttf|otf|eot)(\?|#|$)/i.test(u)) return 'font';
    return 'other';
  };
  for (const u of urls) {
    if (!/^https?:/i.test(u)) continue;
    const host = hostOfUrl(u);
    if (!host) continue;
    const e = byHost.get(host) ?? { host, etld1: eTldPlusOne(host), count: 0, types: {}, samples: new Set() };
    e.count++;
    const t = typeOf(u);
    e.types[t] = (e.types[t] ?? 0) + 1;
    if (e.samples.size < 3) e.samples.add(u.slice(0, 200));
    byHost.set(host, e);
  }

  const all = Array.from(byHost.values()).map((e) => ({
    host: e.host,
    etld1: e.etld1,
    firstParty: e.etld1 === pageEtld,
    requests: e.count,
    types: e.types,
    setsCookies: !!setsCookieByHost.get(e.host),
    knownTracker: KNOWN_TRACKERS.some((t) => e.host.includes(t) || e.etld1.includes(t)),
    samples: Array.from(e.samples).map((u) => (ctx.settings.redact ? redactTokensInString(u) : u)),
  }));
  const thirdParties = all.filter((x) => !x.firstParty).sort((a, b) => Number(b.knownTracker) - Number(a.knownTracker) || b.requests - a.requests);
  const trackers = thirdParties.filter((x) => x.knownTracker);

  result.files['security/third-parties.json'] = json({
    note: 'Foreign domains the page contacted (Resource Timing + captured responses). "knownTracker" uses a small built-in list.',
    pageDomain: pageHost,
    pageEtld1: pageEtld,
    summary: { totalHosts: all.length, thirdPartyHosts: thirdParties.length, knownTrackers: trackers.length, thirdPartiesSettingCookies: thirdParties.filter((x) => x.setsCookies).length },
    thirdParties,
    firstParty: all.filter((x) => x.firstParty),
  });

  if (trackers.length) result.warnings.push(`${trackers.length} known tracker domain(s): ${trackers.slice(0, 5).map((t) => t.host).join(', ')}.`);
  return result;
};
