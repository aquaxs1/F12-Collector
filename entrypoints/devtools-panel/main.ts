import { mountApp } from '@/lib/ui/app';
import type { DevtoolsExtras } from '@/lib/types';
import { browser } from 'wxt/browser';

// While the panel is open, buffer response bodies from the Network tab so that
// a snapshot (without reloading) still has bodies in the HAR.
const MAX_BUFFER = 100 * 1024 * 1024;
const bodies: NonNullable<DevtoolsExtras['bodies']> = [];
let buffered = 0;

const devtools: any = browser.devtools;
try {
  devtools.network.onRequestFinished.addListener((req: any) => {
    if (buffered > MAX_BUFFER) return;
    let handled = false;
    const handle = (content: string | null | undefined, encoding?: string) => {
      if (handled || content == null) return;
      handled = true;
      buffered += content.length;
      bodies.push({ url: req.request?.url, method: req.request?.method, content, encoding: encoding || undefined, mimeType: req.response?.content?.mimeType });
    };
    try {
      const r = req.getContent((c: string, enc: string) => handle(c, enc));
      if (r && typeof r.then === 'function') r.then((res: any) => (Array.isArray(res) ? handle(res[0]) : handle(res))).catch(() => {});
    } catch {
      /* ignore */
    }
  });
  devtools.network.onNavigated?.addListener(() => {
    bodies.length = 0;
    buffered = 0;
  });
} catch {
  /* network API not available */
}

function getHAR(): Promise<any> {
  return new Promise((resolve) => {
    let done = false;
    const finish = (v: any) => {
      if (!done) {
        done = true;
        resolve(v);
      }
    };
    try {
      const r = devtools.network.getHAR((log: any) => finish(log));
      if (r && typeof r.then === 'function') r.then(finish, () => finish(undefined));
    } catch {
      finish(undefined);
    }
    setTimeout(() => finish(undefined), 10000);
  });
}

mountApp(document.getElementById('app')!, {
  kind: 'devtools',
  async getTabId() {
    return browser.devtools.inspectedWindow.tabId;
  },
  async getDevtoolsExtras() {
    const har = await getHAR();
    return har ? { har: JSON.parse(JSON.stringify(har)), bodies: bodies.slice() } : undefined;
  },
});
