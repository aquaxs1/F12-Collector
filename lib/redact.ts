// Redaction: sensitive values are replaced with [REDACTED] by default.

export const REDACTED = '[REDACTED]';

/** Headers whose value is always removed. */
const SENSITIVE_HEADERS = new Set([
  'authorization',
  'proxy-authorization',
  'cookie',
  'set-cookie',
  'x-csrf-token',
  'x-xsrf-token',
  'x-api-key',
  'x-auth-token',
]);

/** Key names whose values are treated as tokens. */
const SENSITIVE_KEY = /(token|auth|session|secret|passw(or)?d|api[-_]?key|credential|jwt|bearer|csrf|xsrf)/i;

/** JWT: three base64url parts, the first starts with "eyJ" (= '{"'). */
const JWT = /eyJ[A-Za-z0-9_-]{5,}\.[A-Za-z0-9_-]{5,}\.[A-Za-z0-9_-]{5,}/g;
/** "Bearer xyz" in any text */
const BEARER = /\bBearer\s+[A-Za-z0-9._~+/=-]{8,}/gi;

export function isSensitiveHeader(name: string) {
  return SENSITIVE_HEADERS.has(name.toLowerCase());
}

export function isSensitiveKey(key: string) {
  return SENSITIVE_KEY.test(key);
}

export function redactTokensInString(value: string): string {
  if (value.length > 5_000_000) return value; // do not scan huge values
  return value.replace(JWT, REDACTED).replace(BEARER, `Bearer ${REDACTED}`);
}

/** Clean a single storage entry (key name + token patterns in the value). */
export function redactStorageValue(key: string, value: string): string {
  if (isSensitiveKey(key)) return REDACTED;
  return redactTokensInString(value);
}

/** Recursively clean any JSON structure (e.g. IndexedDB records). */
export function redactDeep(value: unknown, keyHint = '', depth = 0): unknown {
  if (depth > 50) return value;
  if (typeof value === 'string') return keyHint && isSensitiveKey(keyHint) ? REDACTED : redactTokensInString(value);
  if (Array.isArray(value)) return value.map((v) => redactDeep(v, keyHint, depth + 1));
  if (value && typeof value === 'object') {
    const out: Record<string, unknown> = {};
    for (const [k, v] of Object.entries(value as Record<string, unknown>)) {
      if (isSensitiveKey(k) && (typeof v === 'string' || typeof v === 'number')) out[k] = REDACTED;
      else out[k] = redactDeep(v, k, depth + 1);
    }
    return out;
  }
  return value;
}

export function redactRecord(rec: Record<string, string>): Record<string, string> {
  const out: Record<string, string> = {};
  for (const [k, v] of Object.entries(rec)) out[k] = redactStorageValue(k, v);
  return out;
}
