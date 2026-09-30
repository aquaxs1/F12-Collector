// window globals: the page's own properties on `window`, diffed against the pristine baseline
// the probe captured at document_start. Useful for finding config objects, framework handles,
// leaked data, analytics queues, etc. Values are previews only and are redacted by default.
import type { Collector } from '@/lib/context';
import { json } from '@/lib/context';
import { isSensitiveKey, redactTokensInString, REDACTED } from '@/lib/redact';
import type { GlobalEntry } from '@/lib/types';

export const collectWindowGlobals: Collector = async (ctx) => {
  const result = { files: {} as Record<string, string>, warnings: [] as string[] };
  const redact = ctx.settings.redact;
  const probe = ctx.shared.probe ?? [];

  const frames = probe.map((f) => ({
    url: f.frameUrl || (f.isTop ? ctx.url : undefined),
    isTop: f.isTop,
    count: f.globals.length,
    globals: (f.globals as GlobalEntry[]).map((g) => ({
      name: g.name,
      type: g.type,
      preview: redact ? redactPreview(g.name, g.preview) : g.preview,
    })),
  }));

  result.files['sources/window-globals.json'] = json({
    note: 'Own window properties added by the page, diffed against the baseline captured at document_start. Values are short previews only, redacted by default.',
    frames,
  });

  if (!probe.length) result.warnings.push('No window-globals data (probe missing). Reload the page with the extension installed, or use "Record & reload".');
  return result;
};

function redactPreview(name: string, preview?: string): string | undefined {
  if (preview === undefined) return preview;
  if (isSensitiveKey(name)) return REDACTED;
  return redactTokensInString(preview);
}
