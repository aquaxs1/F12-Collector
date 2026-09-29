import { runJob } from '@/lib/job';
import type { JobState, StartJobMessage } from '@/lib/types';
import { browser } from 'wxt/browser';

// Background: accepts jobs from the popup/DevTools panel, orchestrates the collectors,
// builds the ZIP and starts the download. Progress is sent to all open UIs via ports.
export default defineBackground(() => {
  let state: JobState = { running: false, steps: [] };
  const ports = new Set<ReturnType<typeof browser.runtime.connect>>();

  const publish = (s: JobState) => {
    state = s;
    for (const p of ports) {
      try {
        p.postMessage({ type: 'state', state });
      } catch {
        ports.delete(p);
      }
    }
  };

  browser.runtime.onConnect.addListener((port) => {
    if (port.name !== 'f12c-ui') return;
    ports.add(port);
    port.postMessage({ type: 'state', state });
    port.onDisconnect.addListener(() => ports.delete(port));
    port.onMessage.addListener((msg: any) => {
      if (msg?.type === 'get-state') port.postMessage({ type: 'state', state });
      if (msg?.type === 'get-tab')
        browser.tabs
          .get(msg.tabId)
          .then((t) => port.postMessage({ type: 'tab', url: t.url, title: t.title }))
          .catch(() => {});
      if (msg?.type === 'start-job') {
        if (state.running) {
          port.postMessage({ type: 'state', state: { ...state, message: 'An export is already running.' } });
          return;
        }
        state = { running: true, steps: [], tabId: msg.tabId, mode: msg.mode, message: 'Export starting …' };
        publish(state);
        runJob(msg as StartJobMessage, publish).catch((e) => publish({ ...state, running: false, error: String(e) }));
      }
    });
  });
});
