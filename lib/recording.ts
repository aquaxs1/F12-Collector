// "Aufzeichnen & neu laden" – Phase 1: nur neu laden und auf das Laden warten.
import { browser } from 'wxt/browser';
import type { JobContext } from './context';

export interface NetworkRecording {
  reloadAndWait(onDetail: (t: string) => void): Promise<{ timedOut: boolean; summary: string }>;
  toHar(ctx: JobContext): Promise<{ har: any; warnings: string[] }>;
  stop(): Promise<void>;
}

export async function startRecording(ctx: JobContext): Promise<NetworkRecording> {
  return {
    async reloadAndWait() {
      await browser.tabs.reload(ctx.tabId, { bypassCache: true });
      const t0 = Date.now();
      while (Date.now() - t0 < ctx.settings.networkMaxWaitSec * 1000) {
        const tab = await browser.tabs.get(ctx.tabId);
        if (tab.status === 'complete') return { timedOut: false, summary: 'Seite geladen' };
        await new Promise((r) => setTimeout(r, 250));
      }
      return { timedOut: true, summary: 'Zeitlimit erreicht' };
    },
    async toHar() {
      return { har: null, warnings: ['Netzwerkaufzeichnung noch nicht verfügbar'] };
    },
    async stop() {},
  };
}
