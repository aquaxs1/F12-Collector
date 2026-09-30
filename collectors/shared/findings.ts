// Endpoint & secret scan of the page's JavaScript. Passive: scans inline scripts (from the DOM)
// and external scripts (re-read cache-first). Secret VALUES are redacted by default – only the
// type and location (file/line) are exported.
import type { Collector } from '@/lib/context';
import { json } from '@/lib/context';
import { decodeUtf8, fetchResource, mapLimit } from '@/lib/fetcher';
import { isHttpUrl, urlToPath } from '@/lib/paths';
import { redactTokensInString } from '@/lib/redact';

interface SecretRule {
  type: string;
  severity: 'high' | 'medium' | 'low';
  re: RegExp;
}

// Ordered, specific → generic. All global + multiline-safe (tested per whole file).
const SECRET_RULES: SecretRule[] = [
  { type: 'AWS Access Key ID', severity: 'high', re: /\bAKIA[0-9A-Z]{16}\b/g },
  { type: 'AWS Secret Access Key', severity: 'high', re: /\baws_secret_access_key\s*[:=]\s*['"][A-Za-z0-9/+=]{40}['"]/gi },
  { type: 'Google API key', severity: 'high', re: /\bAIza[0-9A-Za-z_\-]{35}\b/g },
  { type: 'Google OAuth client secret', severity: 'high', re: /\bGOCSPX-[0-9A-Za-z_\-]{20,}\b/g },
  { type: 'GitHub token', severity: 'high', re: /\bgh[posru]_[0-9A-Za-z]{36,}\b/g },
  { type: 'Slack token', severity: 'high', re: /\bxox[baprs]-[0-9A-Za-z-]{10,}\b/g },
  { type: 'Stripe secret key', severity: 'high', re: /\b[sr]k_live_[0-9A-Za-z]{20,}\b/g },
  { type: 'Stripe publishable key', severity: 'low', re: /\bpk_live_[0-9A-Za-z]{20,}\b/g },
  { type: 'SendGrid API key', severity: 'high', re: /\bSG\.[0-9A-Za-z_\-]{22}\.[0-9A-Za-z_\-]{43}\b/g },
  { type: 'Twilio Account SID', severity: 'medium', re: /\bAC[0-9a-fA-F]{32}\b/g },
  { type: 'Mailgun key', severity: 'high', re: /\bkey-[0-9a-zA-Z]{32}\b/g },
  { type: 'npm token', severity: 'high', re: /\bnpm_[0-9A-Za-z]{36}\b/g },
  { type: 'Private key block', severity: 'high', re: /-----BEGIN (?:RSA |EC |DSA |OPENSSH |PGP )?PRIVATE KEY-----/g },
  { type: 'JWT', severity: 'medium', re: /\beyJ[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]{8,}\b/g },
  { type: 'Basic auth in URL', severity: 'high', re: /https?:\/\/[^\s'":/]+:[^\s'"@/]+@/g },
  { type: 'Generic secret assignment', severity: 'medium', re: /\b(api[_-]?key|apikey|secret|access[_-]?token|auth[_-]?token|client[_-]?secret|password|passwd|private[_-]?key)\b\s*[:=]\s*['"][^'"\n]{8,}['"]/gi },
];

const ENDPOINT_ABS = /https?:\/\/[A-Za-z0-9.\-]+(?::\d+)?\/[A-Za-z0-9._~:/?#\[\]@!$&'()*+,;=%\-]*/g;
const ENDPOINT_PATH = /['"`](\/(?:api|rest|graphql|v\d|internal|admin|auth|oauth|user|users|account|gateway|service)[A-Za-z0-9._\-/]{0,120})['"`]/gi;
const MAX_SCRIPTS = 80;
const MAX_FINDINGS = 4000;

function lineOf(text: string, index: number): number {
  let line = 1;
  for (let i = 0; i < index && i < text.length; i++) if (text.charCodeAt(i) === 10) line++;
  return line;
}

function mask(value: string, redact: boolean): string {
  if (redact) return '[REDACTED]';
  const v = value.replace(/\s+/g, ' ');
  if (v.length <= 12) return v[0] + '…' + v.slice(-1);
  return v.slice(0, 4) + '…' + v.slice(-4) + ` (${v.length} chars)`;
}

interface Source {
  location: string;
  text: string;
}

export const collectFindings: Collector = async (ctx) => {
  const result = { files: {} as Record<string, string>, warnings: [] as string[] };
  const redact = ctx.settings.redact;
  const sources: Source[] = [];

  // Inline scripts from every frame
  for (const f of ctx.frames) {
    for (const s of f.resources?.scripts ?? []) {
      if (!s.src && s.inline && s.inline.trim()) sources.push({ location: `inline script #${s.index} @ ${f.url}`, text: s.inline });
    }
  }
  // External scripts (fetch cache-first)
  const scriptUrls = new Set<string>();
  for (const f of ctx.frames) {
    for (const s of f.resources?.scripts ?? []) if (isHttpUrl(s.src)) scriptUrls.add(s.src!);
    for (const p of f.resources?.performance ?? []) if (p.initiatorType === 'script' && isHttpUrl(p.name)) scriptUrls.add(p.name);
  }
  const list = Array.from(scriptUrls).slice(0, MAX_SCRIPTS);
  if (scriptUrls.size > list.length) result.warnings.push(`Only the first ${MAX_SCRIPTS} external scripts were scanned.`);
  let done = 0;
  await mapLimit(list, 8, async (url) => {
    ctx.detail(`scanning ${++done}/${list.length}`);
    const res = await fetchResource(url, ctx.maxBytes);
    if (res.ok && res.bytes) sources.push({ location: 'sources/' + urlToPath(url, '', '.js').replace(/^\//, ''), text: decodeUtf8(res.bytes) });
  });

  const secrets: any[] = [];
  const endpointMap = new Map<string, { count: number; locations: Set<string> }>();
  const seenSecret = new Set<string>();

  for (const src of sources) {
    const text = src.text.length > 4_000_000 ? src.text.slice(0, 4_000_000) : src.text;
    // secrets
    for (const rule of SECRET_RULES) {
      rule.re.lastIndex = 0;
      let m: RegExpExecArray | null;
      while ((m = rule.re.exec(text)) && secrets.length < MAX_FINDINGS) {
        const value = m[0];
        const key = rule.type + '|' + src.location + '|' + value.slice(0, 16);
        if (seenSecret.has(key)) continue;
        seenSecret.add(key);
        secrets.push({ type: rule.type, severity: rule.severity, location: src.location, line: lineOf(text, m.index), preview: mask(value, redact) });
        if (m.index === rule.re.lastIndex) rule.re.lastIndex++;
      }
    }
    // endpoints
    const add = (raw: string) => {
      const key = raw.length > 200 ? raw.slice(0, 200) : raw;
      const e = endpointMap.get(key) ?? { count: 0, locations: new Set<string>() };
      e.count++;
      if (e.locations.size < 5) e.locations.add(src.location);
      endpointMap.set(key, e);
    };
    let m: RegExpExecArray | null;
    ENDPOINT_ABS.lastIndex = 0;
    while ((m = ENDPOINT_ABS.exec(text)) && endpointMap.size < MAX_FINDINGS) add(m[0]);
    ENDPOINT_PATH.lastIndex = 0;
    while ((m = ENDPOINT_PATH.exec(text)) && endpointMap.size < MAX_FINDINGS) { if (m[1]) add(m[1]); }
  }

  const endpoints = Array.from(endpointMap.entries())
    .map(([url, v]) => ({ url: redact ? redactTokensInString(url) : url, count: v.count, locations: Array.from(v.locations) }))
    .sort((a, b) => b.count - a.count);

  const bySeverity = { high: 0, medium: 0, low: 0 } as Record<string, number>;
  for (const s of secrets) bySeverity[s.severity] = (bySeverity[s.severity] ?? 0) + 1;

  result.files['security/findings.json'] = json({
    note: 'Endpoint & secret scan of inline + external JavaScript. Secret values are redacted by default (type + location only).',
    redaction: redact ? 'secret values fully redacted' : 'secret values shown masked (first/last chars only)',
    scannedSources: sources.length,
    summary: { secrets: secrets.length, secretsBySeverity: bySeverity, endpoints: endpoints.length },
    secrets,
    endpoints,
  });

  if (bySeverity.high) result.warnings.push(`${bySeverity.high} high-severity secret pattern(s) found in JS – review security/findings.json.`);
  if (!sources.length) result.warnings.push('No JavaScript sources available to scan.');
  return result;
};
