// Security: evaluate the main document's security headers and, on Chrome (record mode), export
// the TLS certificate details. Passive – based only on responses already captured.
import type { Collector, CdpResponseInfo } from '@/lib/context';
import { json } from '@/lib/context';
import { REDACTED, isSensitiveHeader } from '@/lib/redact';
import { getResponses, hostOfUrl } from './responses';

interface Check {
  name: string;
  present: boolean;
  severity: 'ok' | 'info' | 'low' | 'medium' | 'high';
  value?: string;
  note: string;
}

export const collectSecurity: Collector = async (ctx) => {
  const result = { files: {} as Record<string, string>, warnings: [] as string[] };
  const { source, responses, warnings } = await getResponses(ctx);
  result.warnings.push(...warnings);

  const mainHost = hostOfUrl(ctx.url);
  const main =
    responses.find((r) => r.url === ctx.url) ??
    responses.find((r) => hostOfUrl(r.url) === mainHost && (r.type === 'Document' || r.mimeType?.includes('html'))) ??
    responses[0];

  const checks: Check[] = main ? evaluateHeaders(main) : [];

  // Export the (redacted) header sets for every response, for the offline checker.
  const headerDump = responses.map((r) => ({
    url: r.url,
    status: r.status,
    isMain: r === main,
    headers: redactHeaders(r.headers, ctx.settings.redact),
  }));
  result.files['security/headers.json'] = json({
    source,
    mainDocument: main?.url,
    checks,
    responses: headerDump,
  });

  // TLS (Chrome/record only)
  const tlsEntries = responses
    .filter((r) => r.securityDetails)
    .map((r) => ({ url: r.url, securityState: r.securityState, tls: summarizeTls(r.securityDetails) }));
  const uniqueTls: any[] = [];
  const seen = new Set<string>();
  for (const t of tlsEntries) {
    const key = t.tls?.issuer + '|' + t.tls?.subjectName + '|' + t.tls?.validTo;
    if (seen.has(key)) continue;
    seen.add(key);
    uniqueTls.push(t);
  }
  result.files['security/tls.json'] = json({
    available: uniqueTls.length > 0,
    note: uniqueTls.length ? 'TLS certificate details from CDP securityDetails.' : 'No TLS certificate available (needs Chrome "Record & reload").',
    certificates: uniqueTls,
  });

  if (!main) result.warnings.push('No main-document response found to evaluate security headers.');
  else {
    const bad = checks.filter((c) => c.severity === 'high' || c.severity === 'medium');
    if (bad.length) result.warnings.push(`${bad.length} security header issue(s): ${bad.map((c) => c.name).join(', ')}.`);
  }
  return result;
};

function redactHeaders(headers: Record<string, string>, redact: boolean): Record<string, string> {
  if (!redact) return headers;
  const out: Record<string, string> = {};
  for (const [k, v] of Object.entries(headers)) out[k] = isSensitiveHeader(k) ? REDACTED : v;
  return out;
}

function evaluateHeaders(r: CdpResponseInfo): Check[] {
  const h = r.headers;
  const get = (n: string) => h[n.toLowerCase()];
  const checks: Check[] = [];

  const csp = get('content-security-policy');
  checks.push({
    name: 'Content-Security-Policy',
    present: !!csp,
    value: csp,
    severity: !csp ? 'medium' : /unsafe-inline|unsafe-eval/i.test(csp) ? 'low' : 'ok',
    note: !csp ? 'No CSP – no defense-in-depth against XSS/injection.' : /unsafe-inline|unsafe-eval/i.test(csp) ? "CSP present but uses 'unsafe-inline'/'unsafe-eval'." : 'CSP present.',
  });

  const hsts = get('strict-transport-security');
  const https = ctx_isHttps(r.url);
  checks.push({
    name: 'Strict-Transport-Security',
    present: !!hsts,
    value: hsts,
    severity: !https ? 'info' : !hsts ? 'medium' : /max-age=0\b/.test(hsts) ? 'low' : 'ok',
    note: !https ? 'Page is not HTTPS.' : !hsts ? 'No HSTS – connections can be downgraded.' : 'HSTS present.',
  });

  const xfo = get('x-frame-options');
  const cspFrame = csp && /frame-ancestors/i.test(csp);
  checks.push({
    name: 'X-Frame-Options / frame-ancestors',
    present: !!xfo || !!cspFrame,
    value: xfo ?? (cspFrame ? '(via CSP frame-ancestors)' : undefined),
    severity: xfo || cspFrame ? 'ok' : 'medium',
    note: xfo || cspFrame ? 'Clickjacking protection present.' : 'No X-Frame-Options and no CSP frame-ancestors – clickjacking possible.',
  });

  const xcto = get('x-content-type-options');
  checks.push({
    name: 'X-Content-Type-Options',
    present: !!xcto,
    value: xcto,
    severity: /nosniff/i.test(xcto ?? '') ? 'ok' : 'low',
    note: /nosniff/i.test(xcto ?? '') ? 'nosniff set.' : "Missing 'nosniff' – MIME sniffing possible.",
  });

  const ref = get('referrer-policy');
  checks.push({
    name: 'Referrer-Policy',
    present: !!ref,
    value: ref,
    severity: ref ? 'ok' : 'low',
    note: ref ? 'Referrer-Policy set.' : 'No Referrer-Policy – full URLs may leak in the Referer header.',
  });

  const perm = get('permissions-policy') ?? get('feature-policy');
  checks.push({ name: 'Permissions-Policy', present: !!perm, value: perm, severity: perm ? 'ok' : 'info', note: perm ? 'Permissions-Policy set.' : 'No Permissions-Policy.' });

  const coop = get('cross-origin-opener-policy');
  checks.push({ name: 'Cross-Origin-Opener-Policy', present: !!coop, value: coop, severity: coop ? 'ok' : 'info', note: coop ? 'COOP set.' : 'No COOP (origin isolation).' });

  // CORS misconfiguration: ACAO * together with credentials
  const acao = get('access-control-allow-origin');
  const acac = get('access-control-allow-credentials');
  if (acao) {
    const bad = acao.trim() === '*' && /true/i.test(acac ?? '');
    checks.push({
      name: 'CORS Access-Control-Allow-Origin',
      present: true,
      value: `${acao}${acac ? ' (+credentials)' : ''}`,
      severity: bad ? 'high' : acao.trim() === '*' ? 'low' : 'ok',
      note: bad
        ? "ACAO '*' with Allow-Credentials: true is invalid and dangerous."
        : acao.trim() === '*'
          ? "ACAO '*' – any origin can read responses (ensure no credentials/secret data)."
          : 'CORS restricted to specific origins.',
    });
  }

  const server = get('server');
  if (server) checks.push({ name: 'Server banner', present: true, value: server, severity: /\d/.test(server) ? 'low' : 'info', note: /\d/.test(server) ? 'Server header reveals software + version.' : 'Server header present.' });
  const xpb = get('x-powered-by');
  if (xpb) checks.push({ name: 'X-Powered-By', present: true, value: xpb, severity: 'low', note: 'X-Powered-By reveals backend technology.' });

  return checks;
}

function ctx_isHttps(url: string): boolean {
  try {
    return new URL(url).protocol === 'https:';
  } catch {
    return false;
  }
}

function summarizeTls(sd: any) {
  if (!sd) return undefined;
  return {
    protocol: sd.protocol,
    keyExchange: sd.keyExchange,
    cipher: sd.cipher,
    subjectName: sd.subjectName,
    sanList: sd.sanList,
    issuer: sd.issuer,
    validFrom: sd.validFrom ? new Date(sd.validFrom * 1000).toISOString() : undefined,
    validTo: sd.validTo ? new Date(sd.validTo * 1000).toISOString() : undefined,
    signedCertificateTimestamps: Array.isArray(sd.signedCertificateTimestamps) ? sd.signedCertificateTimestamps.length : undefined,
    certificateTransparencyCompliance: sd.certificateTransparencyCompliance,
  };
}
