// Shared UI for the popup and the DevTools panel.
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

  // ---------- Header ----------
  const urlLine = h('div', { class: 'sub' }, '');
  const header = h(
    'header',
    {},
    h('img', { src: browser.runtime.getURL('/logo-ui.png' as any), alt: 'F12 Collector Logo' }),
    h('div', {}, h('h1', {}, 'F12 ', h('span', {}, 'Collector')), urlLine),
  );

  // ---------- Areas ----------
  const areaBox = h('fieldset', {}, h('legend', {}, 'Areas'));
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
        a.support !== 'full' ? h('span', { class: `badge ${a.support}` }, a.support === 'limited' ? 'limited' : 'unavailable') : null,
        a.note ? h('span', { class: 'note' }, a.note) : null,
      ),
    );
  }
  const allRow = h(
    'div',
    { class: 'row' },
    h('button', { type: 'button', class: 'small', onclick: () => setAll(true) }, 'all'),
    h('button', { type: 'button', class: 'small', onclick: () => setAll(false) }, 'none'),
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
    h('strong', {}, '⚠ Warning: '),
    'The export will contain cookie values, session tokens and Authorization headers in plain text. Anyone who gets the ZIP may be able to log in as you. Use for your own analysis only!',
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
    h('legend', {}, 'Privacy'),
    h('label', { class: 'area' }, redactCb, h('span', {}, 'Redact sensitive data ([REDACTED])')),
    h('div', { class: 'muted' }, 'Cookies, Authorization/Cookie/Set-Cookie headers, tokens (JWT, *token*, *auth*, *session*, *secret*).'),
    redactWarn,
  );

  // ---------- Settings ----------
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
    h('option', { value: 'visible' }, 'visible elements only'),
    h('option', { value: 'all' }, 'all elements'),
    h('option', { value: 'none' }, 'none'),
  );
  modeSelect.value = settings.computedStylesMode;
  const settingsBox = h(
    'details',
    {},
    h('summary', {}, 'Settings'),
    h(
      'div',
      { style: 'padding:6px 2px' },
      h('div', { class: 'row' }, 'Max. file size', numberInput('maxFileSizeMB', 0.1, 2000, 0.5), 'MB'),
      checkbox('includeBodies', 'Include response bodies in the HAR'),
      h('div', { class: 'row' }, 'Computed Styles:', modeSelect),
      h('div', { class: 'row' }, 'max.', numberInput('computedStylesLimit', 1, 100000), 'elements'),
      checkbox('computedStylesDiffOnly', 'only values that differ from browser defaults'),
      h('div', { class: 'row' }, 'Network idle after', numberInput('networkIdleMs', 250, 60000, 250), 'ms'),
      h('div', { class: 'row' }, 'Recording max.', numberInput('networkMaxWaitSec', 3, 600), 's'),
      h('div', { class: 'row' }, 'IndexedDB max.', numberInput('indexedDbMaxRecords', 0, 1000000), 'records/store'),
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
        'Restore defaults',
      ),
    ),
  );

  // ---------- Firefox: host permission ----------
  const permBox = h(
    'div',
    { class: 'errbox hidden' },
    h('strong', {}, 'Website access missing. '),
    'Firefox does not grant access to all websites automatically. ',
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
      'Allow access to all websites',
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
  const snapBtn = h('button', { class: 'primary', type: 'button', onclick: () => start('snapshot') }, '📸 Take snapshot');
  const recBtn = h(
    'button',
    { type: 'button', onclick: () => start('record'), title: 'Start network recording, reload the page, wait until the network is idle, then take a snapshot' },
    '⏺ Record & reload',
  );
  const buttons = h('div', { class: 'buttons' }, snapBtn, recBtn);

  // ---------- Progress ----------
  const statusMsg = h('div', { class: 'status-msg' });
  const errorBox = h('div', { class: 'errbox hidden' });
  const stepList = h('ul', { class: 'steps' });
  const resultBox = h('div', { class: 'hidden', style: 'margin-top:8px' });
  const progress = h('fieldset', {}, h('legend', {}, 'Progress'), statusMsg, errorBox, stepList, resultBox);
  const idleHint = h('div', { class: 'muted' }, 'No export yet. The ZIP file is saved to your downloads folder.');
  progress.append(idleHint);

  const limited = getAreas().filter((a) => a.support !== 'full');
  const footer = h(
    'div',
    { class: 'footer' },
    'Everything stays local – no uploads, no telemetry.',
    limited.length
      ? h(
          'div',
          { style: 'margin-top:4px' },
          `${IS_FIREFOX ? 'Firefox' : 'Chrome'} limitations: `,
          limited.map((a) => `${a.label} (${a.note})`).join(' · '),
        )
      : null,
    opts.kind === 'devtools'
      ? h('div', { style: 'margin-top:4px' }, 'Tip: a snapshot taken from this panel also includes the requests from the Network tab (since DevTools was opened).')
      : null,
  );

  const left = h('div', {}, permBox, areaBox, privacyBox, settingsBox, buttons);
  const right = h('div', {}, progress, footer);
  root.append(h('div', { class: 'app' }, header, h('div', { class: 'layout' }, left, right)));

  // ---------- Connection to the background ----------
  let port = connect();
  function connect() {
    const p = browser.runtime.connect({ name: 'f12c-ui' });
    p.onMessage.addListener((msg: any) => {
      if (msg?.type === 'state') render(msg.state);
      if (msg?.type === 'tab') {
        urlLine.textContent = msg.url ?? msg.title ?? '';
        urlLine.title = [msg.title, msg.url].filter(Boolean).join('\n');
      }
    });
    p.onDisconnect.addListener(() => {
      setTimeout(() => (port = connect()), 500);
    });
    return p;
  }

  async function start(mode: RunMode) {
    const tabId = await opts.getTabId();
    if (tabId === undefined) {
      render({ running: false, steps: [], error: 'No active tab found.' });
      return;
    }
    if (!Object.values(settings.areas).some(Boolean)) {
      render({ running: false, steps: [], error: 'Please select at least one area.' });
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
    resultBox.classList.toggle('hidden', s.running || (!s.warnings?.length && !s.fileName));
    resultBox.replaceChildren(
      ...(s.fileName && !s.running ? [h('div', {}, '📦 ', h('strong', {}, s.fileName), ' → downloads folder')] : []),
      ...(s.skippedCount ? [h('div', { style: 'color:var(--warn)' }, `${s.skippedCount} file(s)/bodies skipped due to the size limit (listed in manifest.json)`)] : []),
      ...(s.missing?.length
        ? [h('div', { style: 'margin-top:4px' }, h('strong', {}, 'Missing/limited: '), s.missing.map((m) => `${m.label}${m.reason ? ` – ${m.reason}` : ''}`).join(' · '))]
        : []),
      ...(s.warnings?.length
        ? [
            h(
              'details',
              { style: 'margin-top:4px' },
              h('summary', {}, `Notes (${s.warningsCount ?? s.warnings.length})`),
              h('ul', { style: 'margin:4px 0 0;padding-left:18px;font-size:11.5px' }, ...s.warnings.map((w) => h('li', {}, w))),
            ),
          ]
        : []),
    );
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

  // Show the tab URL (via the background – DevTools panels do not have the tabs API everywhere)
  const tabId = await opts.getTabId();
  if (tabId !== undefined) port.postMessage({ type: 'get-tab', tabId });
  else urlLine.textContent = '';
  void state;
}
