// Tech stack detection (Wappalyzer-style, offline). Purely passive: matches a small rule set
// against already-collected data (response headers, Set-Cookie names, script URLs, HTML,
// window globals). No requests, no probing.
import type { Collector, JobContext } from '@/lib/context';
import { json } from '@/lib/context';
import { getResponses } from './responses';

interface Rule {
  name: string;
  cat: string;
  header?: [string, RegExp][];
  cookie?: RegExp[];
  script?: RegExp[];
  html?: RegExp[];
  global?: RegExp[];
  version?: RegExp; // capture group 1, applied to matched evidence
}

const RULES: Rule[] = [
  { name: 'jQuery', cat: 'JavaScript library', script: [/jquery[.-]([\d.]+)|jquery(\.min)?\.js/i], global: [/^jQuery$|^\$$/], version: /jquery[.-]([\d.]+)/i },
  { name: 'React', cat: 'JavaScript framework', script: [/react(-dom)?[.@-]([\d.]+)|\/react(\.production|\.development)?\.min\.js/i], global: [/^(React|ReactDOM)$/], html: [/data-reactroot|__NEXT_DATA__/], version: /react(?:-dom)?[.@-]([\d.]+)/i },
  { name: 'Next.js', cat: 'Web framework', script: [/\/_next\//i], html: [/id="__next"|__NEXT_DATA__/], header: [['x-powered-by', /Next\.js/i]], global: [/^__NEXT_DATA__$/] },
  { name: 'Vue.js', cat: 'JavaScript framework', script: [/vue(@|[.-])([\d.]+)|\/vue(\.min|\.runtime)?\.js/i], global: [/^Vue$/], html: [/data-v-[0-9a-f]{8}|__vue__/], version: /vue(?:@|[.-])([\d.]+)/i },
  { name: 'Nuxt.js', cat: 'Web framework', script: [/\/_nuxt\//i], global: [/^__NUXT__$/], html: [/id="__nuxt"|__NUXT__/] },
  { name: 'Angular', cat: 'JavaScript framework', script: [/angular[.-]([\d.]+)|\/@angular\//i], global: [/^(ng|angular)$/], html: [/ng-version="([\d.]+)"|ng-app|_nghost/], version: /ng-version="([\d.]+)"/i },
  { name: 'Svelte', cat: 'JavaScript framework', html: [/svelte-[0-9a-z]{6}/i], script: [/\/svelte\//i] },
  { name: 'WordPress', cat: 'CMS', html: [/wp-content|wp-includes|<meta name="generator" content="WordPress ?([\d.]*)/i], script: [/wp-content|wp-includes/i], version: /WordPress ?([\d.]+)/i },
  { name: 'Drupal', cat: 'CMS', html: [/<meta name="generator" content="Drupal ?([\d.]*)/i], header: [['x-generator', /Drupal ?([\d.]*)/i]], script: [/\/sites\/(all|default)\/|drupal\.js/i], version: /Drupal ?([\d.]+)/i },
  { name: 'Joomla', cat: 'CMS', html: [/<meta name="generator" content="Joomla/i, /\/media\/jui\//i] },
  { name: 'Shopify', cat: 'Ecommerce', html: [/cdn\.shopify\.com|Shopify\.theme/i], script: [/cdn\.shopify\.com/i], header: [['x-shopid', /.+/i]] },
  { name: 'Magento', cat: 'Ecommerce', html: [/Magento|mage\/cookies/i], cookie: [/^X-Magento/i] },
  { name: 'Google Analytics', cat: 'Analytics', script: [/google-analytics\.com\/(analytics|ga)\.js|gtag\/js|googletagmanager\.com\/gtag/i], global: [/^(ga|gtag|dataLayer)$/] },
  { name: 'Google Tag Manager', cat: 'Tag manager', script: [/googletagmanager\.com\/gtm\.js/i], html: [/googletagmanager\.com\/ns\.html/i], global: [/^dataLayer$/] },
  { name: 'Facebook Pixel', cat: 'Analytics', script: [/connect\.facebook\.net\/.*\/fbevents\.js/i], global: [/^fbq$/] },
  { name: 'Hotjar', cat: 'Analytics', script: [/static\.hotjar\.com/i], global: [/^hj$/] },
  { name: 'Sentry', cat: 'Monitoring', script: [/browser\.sentry-cdn\.com|@sentry\//i], global: [/^(Sentry|__SENTRY__)$/] },
  { name: 'Stripe', cat: 'Payments', script: [/js\.stripe\.com/i], global: [/^Stripe$/] },
  { name: 'Cloudflare', cat: 'CDN / WAF', header: [['server', /cloudflare/i], ['cf-ray', /.+/]], script: [/\/cdn-cgi\//i] },
  { name: 'Vercel', cat: 'Hosting', header: [['server', /Vercel/i], ['x-vercel-id', /.+/]] },
  { name: 'Netlify', cat: 'Hosting', header: [['server', /Netlify/i], ['x-nf-request-id', /.+/]] },
  { name: 'nginx', cat: 'Web server', header: [['server', /nginx\/?([\d.]*)/i]], version: /nginx\/([\d.]+)/i },
  { name: 'Apache', cat: 'Web server', header: [['server', /Apache\/?([\d.]*)/i]], version: /Apache\/([\d.]+)/i },
  { name: 'Microsoft IIS', cat: 'Web server', header: [['server', /IIS\/?([\d.]*)/i]], version: /IIS\/([\d.]+)/i },
  { name: 'Express', cat: 'Web framework', header: [['x-powered-by', /Express/i]] },
  { name: 'PHP', cat: 'Language', header: [['x-powered-by', /PHP\/?([\d.]*)/i], ['set-cookie', /PHPSESSID/i]], version: /PHP\/([\d.]+)/i },
  { name: 'ASP.NET', cat: 'Framework', header: [['x-powered-by', /ASP\.NET/i], ['x-aspnet-version', /([\d.]+)/i], ['set-cookie', /ASP\.NET_SessionId/i]], version: /([\d.]+)/ },
  { name: 'Ruby on Rails', cat: 'Web framework', header: [['x-powered-by', /Phusion Passenger/i], ['set-cookie', /_session_id/i]] },
  { name: 'Bootstrap', cat: 'UI framework', script: [/bootstrap(\.bundle)?(\.min)?\.js|bootstrap[@\/-]([\d.]+)/i], html: [/class="[^"]*\b(container|row|col-(sm|md|lg|xl))\b/i], version: /bootstrap[@\/-]([\d.]+)/i },
  { name: 'Tailwind CSS', cat: 'UI framework', html: [/class="[^"]*\b(flex|grid|text-(sm|lg|xl)|bg-(gray|blue|red)-\d00)\b/i] },
  { name: 'Font Awesome', cat: 'Icons', script: [/fontawesome|fa-solid|fa-brands/i], html: [/class="[^"]*\bfa[srb]?\b/i] },
  { name: 'Google Fonts', cat: 'Fonts', html: [/fonts\.googleapis\.com/i] },
  { name: 'jsDelivr', cat: 'CDN', script: [/cdn\.jsdelivr\.net/i] },
  { name: 'unpkg', cat: 'CDN', script: [/unpkg\.com/i] },
  { name: 'cdnjs', cat: 'CDN', script: [/cdnjs\.cloudflare\.com/i] },
];

export const collectTechStack: Collector = async (ctx) => {
  const result = { files: {} as Record<string, string>, warnings: [] as string[] };
  const { responses, source } = await getResponses(ctx).catch(() => ({ responses: [] as any[], source: 'none' }));

  const scriptUrls = new Set<string>();
  const htmlBlobs: string[] = [];
  for (const f of ctx.frames) {
    for (const s of f.resources?.scripts ?? []) if (s.src) scriptUrls.add(s.src);
    for (const p of f.resources?.performance ?? []) if (p.initiatorType === 'script') scriptUrls.add(p.name);
    if (f.dom?.html) htmlBlobs.push(f.dom.html.slice(0, 200000));
  }
  const globals = new Set<string>();
  for (const fp of ctx.shared.probe ?? []) for (const g of fp.globals) globals.add(g.name);

  const headerPairs: [string, string][] = [];
  for (const r of responses) for (const [k, v] of Object.entries(r.headers)) headerPairs.push([k, String(v)]);

  const scripts = Array.from(scriptUrls);
  const html = htmlBlobs.join('\n');
  const detected: any[] = [];

  for (const rule of RULES) {
    const evidence: string[] = [];
    let version: string | undefined;
    const tryVersion = (s: string) => {
      if (!version && rule.version) {
        const m = rule.version.exec(s);
        if (m && m[1]) version = m[1].replace(/[.\-]+$/, '');
      }
    };
    for (const [hk, hv] of rule.header ?? []) {
      const hit = headerPairs.find(([k, v]) => k === hk.toLowerCase() && hv.test(v));
      if (hit) {
        evidence.push(`header ${hit[0]}: ${hit[1].slice(0, 80)}`);
        tryVersion(hit[1]);
      }
    }
    for (const re of rule.cookie ?? []) {
      const hit = headerPairs.find(([k, v]) => k === 'set-cookie' && re.test(v));
      if (hit) evidence.push(`cookie ${re}`);
    }
    for (const re of rule.script ?? []) {
      const hit = scripts.find((u) => re.test(u));
      if (hit) {
        evidence.push(`script ${hit.slice(0, 100)}`);
        tryVersion(hit);
      }
    }
    for (const re of rule.html ?? []) {
      const m = re.exec(html);
      if (m) {
        evidence.push(`html ${m[0].slice(0, 60)}`);
        tryVersion(m[0]);
      }
    }
    for (const re of rule.global ?? []) {
      const hit = Array.from(globals).find((g) => re.test(g));
      if (hit) evidence.push(`window.${hit}`);
    }
    if (evidence.length) detected.push({ name: rule.name, category: rule.cat, version, confidence: evidence.length >= 2 ? 'high' : 'medium', evidence: evidence.slice(0, 4) });
  }

  detected.sort((a, b) => a.category.localeCompare(b.category) || a.name.localeCompare(b.name));
  result.files['security/techstack.json'] = json({
    note: 'Passive technology fingerprinting from headers, script URLs, HTML and window globals. Heuristic – may miss or misidentify.',
    headerSource: source,
    count: detected.length,
    technologies: detected,
  });
  if (!detected.length) result.warnings.push('No technologies matched the built-in rules.');
  void (ctx as JobContext);
  return result;
};
