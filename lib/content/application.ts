// Application data gathered in the page context: service worker registrations, the storage
// quota estimate, and the web app manifest link. The background then fetches the manifest and
// SW scripts. Everything here is read-only.
import { errText } from './util';

export interface AppData {
  manifestHref?: string;
  controllerScriptURL?: string;
  serviceWorkers?: {
    scope: string;
    updateViaCache?: string;
    active?: { scriptURL: string; state: string };
    waiting?: { scriptURL: string; state: string };
    installing?: { scriptURL: string; state: string };
  }[];
  serviceWorkerError?: string;
  storageEstimate?: { quota?: number; usage?: number; usageDetails?: Record<string, number>; persisted?: boolean };
  storageError?: string;
}

export async function collectApplication(): Promise<AppData> {
  const data: AppData = {};
  try {
    const link = document.querySelector('link[rel="manifest"]') as HTMLLinkElement | null;
    if (link?.href) data.manifestHref = link.href;
  } catch {
    /* ignore */
  }

  try {
    if (navigator.serviceWorker) {
      data.controllerScriptURL = navigator.serviceWorker.controller?.scriptURL;
      const regs = await navigator.serviceWorker.getRegistrations();
      const w = (x: ServiceWorker | null) => (x ? { scriptURL: x.scriptURL, state: x.state } : undefined);
      data.serviceWorkers = regs.map((r) => ({
        scope: r.scope,
        updateViaCache: (r as any).updateViaCache,
        active: w(r.active),
        waiting: w(r.waiting),
        installing: w(r.installing),
      }));
    }
  } catch (e) {
    data.serviceWorkerError = errText(e);
  }

  try {
    if (navigator.storage?.estimate) {
      const est = await navigator.storage.estimate();
      data.storageEstimate = { quota: est.quota, usage: est.usage, usageDetails: (est as any).usageDetails };
      if (navigator.storage.persisted) data.storageEstimate.persisted = await navigator.storage.persisted().catch(() => undefined);
    }
  } catch (e) {
    data.storageError = errText(e);
  }
  return data;
}
