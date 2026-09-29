import { collectFrame } from '@/lib/content/collect';
import type { ContentCollectOptions } from '@/lib/types';

// The content script does nothing on its own. The background calls
// globalThis.__F12C__.collect(...) via scripting.executeScript (in all frames).
export default defineContentScript({
  matches: ['<all_urls>'],
  allFrames: true,
  matchAboutBlank: true,
  runAt: 'document_idle',
  main() {
    const g = globalThis as any;
    if (g.__F12C__) return; // already loaded (e.g. injected later)
    g.__F12C__ = {
      version: 1,
      collect: (opts: ContentCollectOptions) => collectFrame(opts),
    };
  },
});
