// "Record & reload": enable listeners/CDP first, then reload the tab and
// wait until the network is idle (e.g. 2 s without new requests, max. 30 s).
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
    // Capture scripts while loading (including ones the GC removes later)
    if (ctx.settings.areas.sources || ctx.settings.areas.debugger) {
      const parsed: any[] = [];
      offs.push(cdp.on('Debugger.scriptParsed', (p) => parsed.push(p)));
      await cdp.send('Debugger.enable', { maxScriptsCacheSize: 100_000_000 });
      await cdp.send('Debugger.setSkipAllPauses', { skip: true }).catch(() => {});
      await new Promise((r) => setTimeout(r, 300));
      parsed.length = 0; // discard scripts of the old page
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
          `${recorder.count} requests, ${recorder.pending} pending, ${loaded ? 'loaded' : 'loading …'} – ${Math.floor(elapsed / 1000)} s` +
            (loaded ? ` (idle for ${(quietFor / 1000).toFixed(1)} s)` : ''),
        );
        if (loaded && quietFor >= networkIdleMs) {
          offs.splice(0).forEach((off) => off()); // stop capturing scripts, network listeners keep running
          return { timedOut: false, summary: `${recorder.count} requests recorded in ${(elapsed / 1000).toFixed(1)} s` };
        }
        if (elapsed >= maxMs) {
          offs.splice(0).forEach((off) => off());
          return {
            timedOut: true,
            summary: `Time limit of ${networkMaxWaitSec} s reached (${recorder.count} requests, ${recorder.pending} still pending${loaded ? '' : ', page not fully loaded'})`,
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

/** Without debugger: just reload and wait until the tab has finished loading. */
function simpleReload(ctx: JobContext): NetworkRecording {
  return {
    async reloadAndWait(onDetail) {
      await browser.tabs.reload(ctx.tabId, { bypassCache: true });
      const t0 = Date.now();
      await new Promise((r) => setTimeout(r, 500));
      while (Date.now() - t0 < ctx.settings.networkMaxWaitSec * 1000) {
        const tab = await browser.tabs.get(ctx.tabId);
        onDetail(`loading … ${Math.floor((Date.now() - t0) / 1000)} s`);
        if (tab.status === 'complete') {
          await new Promise((r) => setTimeout(r, ctx.settings.networkIdleMs));
          return { timedOut: false, summary: 'reloaded (no network recording, debugger not attached)' };
        }
        await new Promise((r) => setTimeout(r, 250));
      }
      return { timedOut: true, summary: 'time limit reached (no network recording)' };
    },
    async toHar() {
      return { har: harFromPerformance(ctx), warnings: ['Debugger not attached – HAR from Resource Timing data only.'] };
    },
    async stop() {},
  };
}
