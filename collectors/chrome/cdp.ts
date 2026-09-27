// Dünner Wrapper um chrome.debugger (Chrome DevTools Protocol).
import { browser } from 'wxt/browser';

type Listener = (params: any) => void;

export class CdpSession {
  readonly target: { tabId: number };
  private listeners = new Map<string, Set<Listener>>();
  private attached = false;
  detachReason?: string;

  private onEvent = (source: { tabId?: number }, method: string, params?: unknown) => {
    if (source.tabId !== this.target.tabId) return;
    const set = this.listeners.get(method);
    if (set) for (const l of set) {
      try {
        l(params);
      } catch (e) {
        console.warn('[F12 Collector] CDP-Listener-Fehler', method, e);
      }
    }
  };

  private onDetach = (source: { tabId?: number }, reason: string) => {
    if (source.tabId !== this.target.tabId) return;
    this.attached = false;
    this.detachReason = reason;
  };

  constructor(tabId: number) {
    this.target = { tabId };
  }

  get isAttached() {
    return this.attached;
  }

  async attach(): Promise<void> {
    browser.debugger.onEvent.addListener(this.onEvent);
    browser.debugger.onDetach.addListener(this.onDetach);
    try {
      await browser.debugger.attach(this.target, '1.3');
      this.attached = true;
    } catch (e) {
      this.removeListeners();
      throw e;
    }
  }

  /** CDP-Befehl senden. Jeder Befehl hat ein Timeout, damit ein hängender Renderer den Export nicht blockiert. */
  async send<T = any>(method: string, params?: Record<string, unknown>, timeoutMs = 30000): Promise<T> {
    if (!this.attached) throw new Error(`Debugger nicht verbunden${this.detachReason ? ` (${this.detachReason})` : ''}`);
    let timer: ReturnType<typeof setTimeout> | undefined;
    try {
      return (await Promise.race([
        browser.debugger.sendCommand(this.target, method, params),
        new Promise((_, reject) => {
          timer = setTimeout(() => reject(new Error(`${method}: keine Antwort nach ${Math.round(timeoutMs / 1000)} s`)), timeoutMs);
        }),
      ])) as T;
    } finally {
      clearTimeout(timer);
    }
  }

  on(method: string, listener: Listener): () => void {
    let set = this.listeners.get(method);
    if (!set) this.listeners.set(method, (set = new Set()));
    set.add(listener);
    return () => set!.delete(listener);
  }

  /** Wartet auf ein Event (oder gibt nach timeoutMs undefined zurück). */
  waitFor<T = any>(method: string, timeoutMs: number): Promise<T | undefined> {
    return new Promise((resolve) => {
      const off = this.on(method, (p) => {
        clearTimeout(t);
        off();
        resolve(p);
      });
      const t = setTimeout(() => {
        off();
        resolve(undefined);
      }, timeoutMs);
    });
  }

  /** Immer aufrufen – auch im Fehlerfall. Wirft nie. */
  async detach(): Promise<void> {
    try {
      if (this.attached) await browser.debugger.detach(this.target);
    } catch {
      /* schon getrennt */
    } finally {
      this.attached = false;
      this.removeListeners();
    }
  }

  private removeListeners() {
    browser.debugger.onEvent.removeListener(this.onEvent);
    browser.debugger.onDetach.removeListener(this.onDetach);
    this.listeners.clear();
  }
}
