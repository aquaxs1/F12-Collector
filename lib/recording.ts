// "Aufzeichnen & neu laden": zuerst Listener/CDP aktivieren, dann Tab neu laden,
// warten bis das Netzwerk ruhig ist (z. B. 2 s ohne neue Requests, max. 30 s).
import { CdpNetworkRecorder } from '@/collectors/chrome/network-recorder';
import { WebRequestRecorder } from '@/collectors/firefox/network-recorder';
import { IS_FIREFOX } from './areas';
import type { JobContext } from './context';
import { harFromPerformance } from './har';
import { browser } from 'wxt/browser';

export interface NetworkRecording {
  reloadAndWait(onDetail: (t: string) => void): Promise<{ timedOut: boolean; summary: string }>;
  toHar(ctx: JobContext): Promise<{ har: any; warnings: string[] }>;
  stop(): Promise<void>;
}

type Recorder = (CdpNetworkRecorder | WebRequestRecorder) & { checkLoaded?: () => Promise<boolean> };

export async function startRecording(ctx: JobContext): Promise<NetworkRecording> {
  let recorder: Recorder;
  const offs: (() => void)[] = [];

  if (IS_FIREFOX) {
    recorder = new WebRequestRecorder(ctx.tabId, ctx.settings.includeBodies, ctx.maxBytes);
  } else {
    if (!ctx.cdp) return simpleReload(ctx);
    const cdp = ctx.cdp;
    recorder = new CdpNetworkRecorder(cdp);
    // Scripts bereits beim Laden erfassen (inkl. solcher, die später vom GC entfernt werden)
    if (ctx.settings.areas.sources || ctx.settings.areas.debugger) {
      const parsed: any[] = [];
      offs.push(cdp.on('Debugger.scriptParsed', (p) => parsed.push(p)));
      await cdp.send('Debugger.enable', { maxScriptsCacheSize: 100_000_000 });
      await cdp.send('Debugger.setSkipAllPauses', { skip: true }).catch(() => {});
      await new Promise((r) => setTimeout(r, 300));
      parsed.length = 0; // Scripts der alten Seite verwerfen
      ctx.shared.parsedScripts = parsed;
    }
  }
  await recorder.start();

  const stopAll = () => {
    recorder.stop();
    for (const off of offs.splice(0)) off();
  };

  return {
    async reloadAndWait(onDetail) {
      const { networkIdleMs, networkMaxWaitSec } = ctx.settings;
      await recorder.reload();
      const t0 = Date.now();
      const maxMs = networkMaxWaitSec * 1000;
      for (;;) {
        await new Promise((r) => setTimeout(r, 200));
        const elapsed = Date.now() - t0;
        const loaded = recorder.checkLoaded ? await recorder.checkLoaded() : recorder.loaded;
        const quietFor = Date.now() - recorder.lastActivity;
        onDetail(
          `${recorder.count} Requests, ${recorder.pending} offen, ${loaded ? 'geladen' : 'lädt …'} – ${Math.floor(elapsed / 1000)} s` +
            (loaded ? ` (ruhig seit ${(quietFor / 1000).toFixed(1)} s)` : ''),
        );
        if (loaded && quietFor >= networkIdleMs) {
          offs.splice(0).forEach((off) => off()); // Script-Erfassung beenden, Netzwerk-Listener laufen weiter
          return { timedOut: false, summary: `${recorder.count} Requests in ${(elapsed / 1000).toFixed(1)} s aufgezeichnet` };
        }
        if (elapsed >= maxMs) {
          offs.splice(0).forEach((off) => off());
          return {
            timedOut: true,
            summary: `Zeitlimit ${networkMaxWaitSec} s erreicht (${recorder.count} Requests, ${recorder.pending} noch offen${loaded ? '' : ', Seite nicht fertig geladen'})`,
          };
        }
      }
    },
    async toHar(c) {
      stopAll();
      return recorder.toHar(c);
    },
    async stop() {
      stopAll();
    },
  };
}

/** Ohne Debugger: nur neu laden und warten, bis der Tab fertig geladen ist. */
function simpleReload(ctx: JobContext): NetworkRecording {
  return {
    async reloadAndWait(onDetail) {
      await browser.tabs.reload(ctx.tabId, { bypassCache: true });
      const t0 = Date.now();
      await new Promise((r) => setTimeout(r, 500));
      while (Date.now() - t0 < ctx.settings.networkMaxWaitSec * 1000) {
        const tab = await browser.tabs.get(ctx.tabId);
        onDetail(`lädt … ${Math.floor((Date.now() - t0) / 1000)} s`);
        if (tab.status === 'complete') {
          await new Promise((r) => setTimeout(r, ctx.settings.networkIdleMs));
          return { timedOut: false, summary: 'neu geladen (ohne Netzwerk-Mitschnitt, Debugger nicht verbunden)' };
        }
        await new Promise((r) => setTimeout(r, 250));
      }
      return { timedOut: true, summary: 'Zeitlimit erreicht (ohne Netzwerk-Mitschnitt)' };
    },
    async toHar() {
      return { har: harFromPerformance(ctx), warnings: ['Debugger nicht verbunden – HAR nur aus Resource-Timing-Daten.'] };
    },
    async stop() {},
  };
}
