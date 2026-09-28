// Accessibility (fallback/Firefox): approximation from the content script.
import type { Collector } from '@/lib/context';
import type { CollectorResult } from '@/lib/types';

export const collectA11yFallback: Collector = async (ctx) => {
  const result: CollectorResult = { files: {}, warnings: [] };
  const frames = ctx.frames.filter((f) => f.a11y).map((f) => ({ frameId: f.frameId, url: f.url, nodeCount: f.a11y!.nodeCount, truncated: f.a11y!.truncated, tree: f.a11y!.tree }));
  if (!frames.length) throw new Error('No data received from the content script');
  result.files['accessibility.json'] = JSON.stringify(
    {
      source: 'Approximation in the content script (explicit/implicit roles, ARIA attributes, states, simplified name computation)',
      note: 'Not the real browser accessibility tree: Firefox provides no accessibility API to extensions. Hidden subtrees (display:none, aria-hidden) are not included.',
      url: ctx.url,
      frames,
    },
    null,
    1,
  );
  result.warnings.push('Accessibility is an approximation (roles, ARIA, accessible names), not the browser\'s real accessibility tree.');
  for (const f of frames) if (f.truncated) result.warnings.push(`A11y (${f.url}): truncated to 20000 nodes.`);
  return result;
};
