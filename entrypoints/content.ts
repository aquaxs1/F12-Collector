import { collectFrame } from '@/lib/content/collect';
import type { ContentCollectOptions } from '@/lib/types';

// Das Content Script selbst tut nichts von allein. Der Background ruft über
// scripting.executeScript (in allen Frames) globalThis.__F12C__.collect(...) auf.
export default defineContentScript({
  matches: ['<all_urls>'],
  allFrames: true,
  matchAboutBlank: true,
  runAt: 'document_idle',
  main() {
    const g = globalThis as any;
    if (g.__F12C__) return; // bereits geladen (z. B. nachträglich injiziert)
    g.__F12C__ = {
      version: 1,
      collect: (opts: ContentCollectOptions) => collectFrame(opts),
    };
  },
});
