// Gemeinsame Oberfläche für Popup und DevTools-Panel.
import { browser } from 'wxt/browser';
import { IS_FIREFOX, getAreas } from '../areas';
import { loadSettings, normalizeSettings, saveSettings } from '../settings';
import type { DevtoolsExtras, JobState, RunMode, Settings, StepStatus } from '../types';
import './style.css';

export interface AppOptions {
  kind: 'popup' | 'devtools';
  getTabId: () => Promise<number | undefined>;
  getDevtoolsExtras?: () => Promise<DevtoolsExtras | undefined>;
}

const ICONS: Record<StepStatus, string> = {
  pending: '○',
  running: '◌',
  done: '✔',
  warning: '⚠',
  error: '✖',
  skipped: '–',
};

function h<K extends keyof HTMLElementTagNameMap>(tag: K, attrs: Record<string, any> = {}, ...children: (Node | string | null | undefined)[]) {
  const el = document.createElement(tag);
  for (const [k, v] of Object.entries(attrs)) {
    if (v === undefined || v === null || v === false) continue;
    if (k === 'class') el.className = v;
    else if (k.startsWith('on') && typeof v === 'function') el.addEventListener(k.slice(2), v);
    else if (k in el && typeof v !== 'string') (el as any)[k] = v;
    else el.setAttribute(k, v === true ? '' : String(v));
  }
  for (const c of children) if (c !== null && c !== undefined) el.append(c);
  return el;
}

export async function mountApp(root: HTMLElement, opts: AppOptions) {
  let settings: Settings = await loadSettings();
  let state: JobState = { running: false, steps: [] };
  const persist = () => saveSettings(settings).catch(() => {});

  // ---------- Kopf ----------
  const urlLine = h('div', { class: 'sub' }, '…');
  const header = h(
    'header',
    {},
    h('img', { src: browser.runtime.getURL('/logo-ui.png' as any), alt: 'F12 Collector Logo' }),
    h('div', {}, h('h1', {}, 'F12 Collector'), urlLine),
  );

  // ---------- Bereiche ----------
  const areaBox = h('fieldset', {}, h('legend', {}, 'Bereiche'));
  for (const a of getAreas()) {
    const unavailable = a.support === 'unavailable';
    const cb = h('input', {
      type: 'checkbox',
      checked: !unavailable && settings.areas[a.id],
      disabled: unavailable,
      onchange: (e: Event) => {
        settings.areas[a.id] = (e.target as HTMLInputElement).checked;
        persist();
      },
    });
    areaBox.append(
      h(
        'label',
        { class: `area ${a.support}`, title: a.note ?? '' },
        cb,
        h('span', {}, a.label),
        a.support !== 'full' ? h('span', { class: `badge ${a.support}` }, a.support === 'limited' ? 'eingeschränkt' : 'nicht verfügbar') : null,
        a.note ? h('span', { class: 'note' }, a.note) : null,
      ),
    );
  }
  const allRow = h(
    'div',
    { class: 'row' },
    h('button', { type: 'button', style: 'flex:0;padding:2px 8px;font-weight:400', onclick: () => setAll(true) }, 'alle'),
    h('button', { type: 'button', style: 'flex:0;padding:2px 8px;font-weight:400', onclick: () => setAll(false) }, 'keine'),
  );
  areaBox.append(allRow);
  function setAll(v: boolean) {
    for (const a of getAreas()) if (a.support !== 'unavailable') settings.areas[a.id] = v;
    areaBox.querySelectorAll<HTMLInputElement>('input[type=checkbox]:not(:disabled)').forEach((c) => (c.checked = v));
    persist();
  }

  // ---------- Redaction ----------
  const redactWarn = h(
    'div',
    { class: 'warnbox' },
    h('strong', {}, '⚠ Achtung: '),
    'Der Export enthält dann Cookie-Werte, Session-Tokens und Authorization-Header im Klartext. Wer das ZIP bekommt, kann sich damit evtl. als du anmelden. Nur für eigene Analysen verwenden!',
  );
  const redactCb = h('input', {
    type: 'checkbox',
    checked: settings.redact,
    onchange: (e: Event) => {
      settings.redact = (e.target as HTMLInputElement).checked;
      redactWarn.classList.toggle('hidden', settings.redact);
      persist();
    },
  });
  redactWarn.classList.toggle('hidden', settings.redact);
  const privacyBox = h(
    'fieldset',
    {},
    h('legend', {}, 'Datenschutz'),
    h('label', { class: 'area' }, redactCb, h('span', {}, 'Sensible Daten schwärzen ([REDACTED])')),
    h('div', { class: 'note', style: 'color:var(--muted);font-size:11.5px' }, 'Cookies, Authorization/Cookie/Set-Cookie-Header, Tokens (JWT, *token*, *auth*, *session*, *secret*).'),
    redactWarn,
  );

  // ---------- Einstellungen ----------
  const numberInput = (key: keyof Settings, min: number, max: number, step = 1) =>
    h('input', {
      type: 'number',
      min: String(min),
      max: String(max),
      step: String(step),
      value: String(settings[key]),
      onchange: (e: Event) => {
        (settings as any)[key] = Number((e.target as HTMLInputElement).value);
        settings = normalizeSettings(settings);
        (e.target as HTMLInputElement).value = String(settings[key]);
        persist();
      },
    });
  const checkbox = (key: keyof Settings, label: string) =>
    h(
      'label',
      { class: 'area' },
      h('input', {
        type: 'checkbox',
        checked: !!settings[key],
        onchange: (e: Event) => {
          (settings as any)[key] = (e.target as HTMLInputElement).checked;
          persist();
        },
      }),
      h('span', {}, label),
    );
  const modeSelect = h(
    'select',
    {
      onchange: (e: Event) => {
        settings.computedStylesMode = (e.target as HTMLSelectElement).value as Settings['computedStylesMode'];
        persist();
      },
    },
    h('option', { value: 'visible' }, 'nur sichtbare Elemente'),
    h('option', { value: 'all' }, 'alle Elemente'),
    h('option', { value: 'none' }, 'keine'),
  );
  modeSelect.value = settings.computedStylesMode;
  const settingsBox = h(
    'details',
    {},
    h('summary', {}, 'Einstellungen'),
    h(
      'div',
      { style: 'padding:6px 2px' },
      h('div', { class: 'row' }, 'Max. Dateigröße', numberInput('maxFileSizeMB', 0.1, 2000, 0.5), 'MB'),
      checkbox('includeBodies', 'Response-Bodies ins HAR aufnehmen'),
      h('div', { class: 'row' }, 'Computed Styles:', modeSelect),
      h('div', { class: 'row' }, 'max.', numberInput('computedStylesLimit', 1, 100000), 'Elemente'),
      checkbox('computedStylesDiffOnly', 'nur vom Browser-Standard abweichende Werte'),
      h('div', { class: 'row' }, 'Netzwerk ruhig nach', numberInput('networkIdleMs', 250, 60000, 250), 'ms'),
      h('div', { class: 'row' }, 'Aufzeichnung max.', numberInput('networkMaxWaitSec', 3, 600), 's'),
      h('div', { class: 'row' }, 'IndexedDB max.', numberInput('indexedDbMaxRecords', 0, 1000000), 'Datensätze/Store'),
      h('div', { class: 'row' }, 'Source Maps max.', numberInput('maxSourceMaps', 0, 10000)),
      h(
        'button',
        {
          type: 'button',
          style: 'margin-top:6px',
          onclick: async () => {
            settings = normalizeSettings({});
            await saveSettings(settings);
            location.reload();
          },
        },
        'Standardwerte wiederherstellen',
      ),
    ),
  );

  // ---------- Firefox: Host-Berechtigung ----------
  const permBox = h(
    'div',
    { class: 'errbox hidden' },
    h('strong', {}, 'Zugriff auf Websites fehlt. '),
    'Firefox erteilt die Berechtigung für alle Websites nicht automatisch. ',
    h(
      'button',
      {
        type: 'button',
        class: 'primary',
        style: 'margin-top:6px;width:100%',
        onclick: async () => {
          await browser.permissions.request({ origins: ['<all_urls>'] }).catch(() => false);
          checkPermissions();
        },
      },
      'Zugriff auf alle Websites erlauben',
    ),
  );
  async function checkPermissions() {
    try {
      const ok = await browser.permissions.contains({ origins: ['<all_urls>'] });
      permBox.classList.toggle('hidden', ok);
    } catch {
      /* ignore */
    }
  }
  if (IS_FIREFOX) checkPermissions();

  // ---------- Buttons ----------
  const snapBtn = h('button', { class: 'primary', type: 'button', onclick: () => start('snapshot') }, '📸 Snapshot erstellen');
  const recBtn = h(
    'button',
    { type: 'button', onclick: () => start('record'), title: 'Netzwerk-Mitschnitt starten, Seite neu laden, warten bis Ruhe herrscht, dann Snapshot' },
    '⏺ Aufzeichnen & neu laden',
  );
  const buttons = h('div', { class: 'buttons' }, snapBtn, recBtn);

  // ---------- Fortschritt ----------
  const statusMsg = h('div', { class: 'status-msg' });
  const errorBox = h('div', { class: 'errbox hidden' });
  const stepList = h('ul', { class: 'steps' });
  const progress = h('fieldset', {}, h('legend', {}, 'Fortschritt'), statusMsg, errorBox, stepList);
  const idleHint = h('div', { style: 'color:var(--muted)' }, 'Noch kein Export gestartet. Die Datei landet im Download-Ordner.');
  progress.append(idleHint);

  const footer = h('div', { class: 'footer' }, 'Alles bleibt lokal – kein Upload, keine Telemetrie.');

  const left = h('div', {}, permBox, areaBox, privacyBox, settingsBox, buttons);
  const right = h('div', {}, progress, footer);
  root.append(h('div', { class: 'app' }, header, h('div', { class: 'layout' }, left, right)));

  // ---------- Verbindung zum Background ----------
  let port = connect();
  function connect() {
    const p = browser.runtime.connect({ name: 'f12c-ui' });
    p.onMessage.addListener((msg: any) => {
      if (msg?.type === 'state') render(msg.state);
    });
    p.onDisconnect.addListener(() => {
      setTimeout(() => (port = connect()), 500);
    });
    return p;
  }

  async function start(mode: RunMode) {
    const tabId = await opts.getTabId();
    if (tabId === undefined) {
      render({ running: false, steps: [], error: 'Kein aktiver Tab gefunden.' });
      return;
    }
    if (!Object.values(settings.areas).some(Boolean)) {
      render({ running: false, steps: [], error: 'Bitte mindestens einen Bereich auswählen.' });
      return;
    }
    snapBtn.disabled = recBtn.disabled = true;
    let devtools: DevtoolsExtras | undefined;
    try {
      if (settings.areas.network && mode === 'snapshot') devtools = await opts.getDevtoolsExtras?.();
    } catch {
      /* optional */
    }
    port.postMessage({ type: 'start-job', tabId, mode, settings, source: opts.kind, devtools });
  }

  function render(s: JobState) {
    state = s;
    idleHint.classList.toggle('hidden', s.running || s.steps.length > 0 || !!s.error);
    snapBtn.disabled = recBtn.disabled = s.running;
    statusMsg.textContent = s.message ?? '';
    statusMsg.style.color = s.error ? 'var(--err)' : s.running ? '' : s.warningsCount ? 'var(--warn)' : 'var(--ok)';
    errorBox.textContent = s.error ?? '';
    errorBox.classList.toggle('hidden', !s.error);
    stepList.replaceChildren(
      ...s.steps.map((st) =>
        h(
          'li',
          { class: `st-${st.status}` },
          h('span', { class: `icon ${st.status === 'running' ? 'spin' : ''}` }, ICONS[st.status]),
          h('span', {}, st.label),
          st.detail ? h('span', { class: 'detail' }, st.detail) : null,
        ),
      ),
    );
  }

  // Tab-URL anzeigen
  const tabId = await opts.getTabId();
  if (tabId !== undefined) {
    try {
      const tab = await browser.tabs.get(tabId);
      urlLine.textContent = tab.url ?? '';
      urlLine.title = tab.url ?? '';
    } catch {
      urlLine.textContent = '';
    }
  }
  void state;
}
