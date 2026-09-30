import type { Area, Settings } from './types';

export const IS_FIREFOX = import.meta.env.FIREFOX;
export const BROWSER_NAME = IS_FIREFOX ? 'firefox' : 'chrome';

export interface AreaInfo {
  id: Area;
  label: string;
  /** full = complete, limited = partial, unavailable = not possible */
  support: 'full' | 'limited' | 'unavailable';
  note?: string;
  /** UI group heading. */
  group: 'Core' | 'Runtime' | 'Capture' | 'App & Network' | 'Security';
}

/** Areas in the order they are shown in the UI and collected. */
export function getAreas(): AreaInfo[] {
  const ff = IS_FIREFOX;
  return [
    { id: 'dom', label: 'DOM (Inspector)', support: 'full', group: 'Core' },
    { id: 'sources', label: 'Sources & source maps', support: 'full', group: 'Core' },
    { id: 'debugger', label: 'Debugger', support: ff ? 'limited' : 'full', note: ff ? 'script list & source maps only, no call stack' : undefined, group: 'Core' },
    { id: 'network', label: 'Network (HAR)', support: ff ? 'limited' : 'full', note: ff ? 'simplified timings, no service worker requests' : undefined, group: 'Core' },
    { id: 'styles', label: 'Styles', support: 'full', group: 'Core' },
    { id: 'storage', label: 'Storage', support: 'full', group: 'Core' },
    { id: 'accessibility', label: 'Accessibility', support: ff ? 'limited' : 'full', note: ff ? 'approximation (roles, ARIA, names)' : undefined, group: 'Core' },
    { id: 'memory', label: 'Memory', support: ff ? 'unavailable' : 'limited', note: ff ? 'not available to extensions in Firefox' : 'heap statistics & memory trace – a real .heapsnapshot is blocked for extensions', group: 'Core' },

    { id: 'console', label: 'Console', support: 'full', note: ff ? undefined : undefined, group: 'Runtime' },
    { id: 'windowGlobals', label: 'window globals', support: 'full', group: 'Runtime' },
    { id: 'eventListeners', label: 'Event listeners', support: ff ? 'unavailable' : 'full', note: ff ? 'needs CDP (Chrome only)' : undefined, group: 'Runtime' },
    { id: 'performance', label: 'Performance (Web Vitals)', support: 'full', group: 'Runtime' },
    { id: 'coverage', label: 'Coverage (JS/CSS)', support: ff ? 'unavailable' : 'full', note: ff ? 'needs CDP (Chrome only)' : 'best with "Record & reload"', group: 'Runtime' },

    { id: 'pageCapture', label: 'Page capture (screenshot, MHTML)', support: ff ? 'limited' : 'full', note: ff ? 'visible-area screenshot only, no MHTML' : undefined, group: 'Capture' },
    { id: 'assets', label: 'Assets (images, fonts, media)', support: 'full', group: 'Capture' },

    { id: 'application', label: 'Application (service workers, manifest)', support: ff ? 'limited' : 'full', note: ff ? 'no CDP service-worker details' : undefined, group: 'App & Network' },
    { id: 'websockets', label: 'WebSockets / EventSource', support: 'full', group: 'App & Network' },

    { id: 'security', label: 'Security (headers, TLS)', support: ff ? 'limited' : 'full', note: ff ? 'headers only, no TLS certificate' : undefined, group: 'Security' },
    { id: 'techstack', label: 'Tech stack', support: 'full', group: 'Security' },
    { id: 'thirdParties', label: 'Third parties / trackers', support: 'full', group: 'Security' },
    { id: 'meta', label: 'Meta files (robots, sitemap, .well-known)', support: 'full', note: 'same-origin fetches', group: 'Security' },
    { id: 'findings', label: 'Endpoint & secret scan', support: 'full', group: 'Security' },
  ];
}

export const DEFAULT_SETTINGS: Settings = {
  areas: {
    dom: true,
    sources: true,
    debugger: true,
    network: true,
    styles: true,
    storage: true,
    accessibility: true,
    memory: !IS_FIREFOX,
    console: true,
    windowGlobals: true,
    eventListeners: !IS_FIREFOX,
    performance: true,
    coverage: false,
    pageCapture: true,
    assets: false,
    application: true,
    websockets: true,
    security: true,
    techstack: true,
    thirdParties: true,
    meta: false,
    findings: true,
  },
  redact: true,
  maxFileSizeMB: 20,
  includeBodies: true,
  computedStylesMode: 'visible',
  computedStylesLimit: 300,
  computedStylesDiffOnly: true,
  networkIdleMs: 2000,
  networkMaxWaitSec: 30,
  indexedDbMaxRecords: 1000,
  maxSourceMaps: 200,
};
