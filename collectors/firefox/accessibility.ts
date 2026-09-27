// Barrierefreiheit (Fallback/Firefox): Annäherung aus dem Content Script.
import type { Collector } from '@/lib/context';
import type { CollectorResult } from '@/lib/types';

export const collectA11yFallback: Collector = async (ctx) => {
  const result: CollectorResult = { files: {}, warnings: [] };
  const frames = ctx.frames.filter((f) => f.a11y).map((f) => ({ frameId: f.frameId, url: f.url, nodeCount: f.a11y!.nodeCount, truncated: f.a11y!.truncated, tree: f.a11y!.tree }));
  if (!frames.length) throw new Error('Keine Daten aus dem Content Script erhalten');
  result.files['accessibility.json'] = JSON.stringify(
    {
      source: 'Annäherung im Content Script (Rollen explizit/implizit, ARIA-Attribute, Zustände, vereinfachte Namensberechnung)',
      note: 'Kein echter Browser-Accessibility-Tree: Firefox stellt Extensions keine Accessibility-API bereit. Ausgeblendete Teilbäume (display:none, aria-hidden) sind nicht enthalten.',
      url: ctx.url,
      frames,
    },
    null,
    1,
  );
  result.warnings.push('Barrierefreiheit ist eine Annäherung (Rollen, ARIA, zugängliche Namen), nicht der echte Accessibility Tree des Browsers.');
  for (const f of frames) if (f.truncated) result.warnings.push(`A11y (${f.url}): gekürzt auf 20000 Knoten.`);
  return result;
};
