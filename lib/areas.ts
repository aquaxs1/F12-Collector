import type { Area, Settings } from './types';

export const IS_FIREFOX = import.meta.env.FIREFOX;
export const BROWSER_NAME = IS_FIREFOX ? 'firefox' : 'chrome';

export interface AreaInfo {
  id: Area;
  label: string;
  /** full = complete, limited = partial, unavailable = not possible */
  support: 'full' | 'limited' | 'unavailable';
  note?: string;
}

/** Areas in the order they are shown in the UI and collected. */
export function getAreas(): AreaInfo[] {
  return [
    { id: 'dom', label: 'DOM (Inspector)', support: 'full' },
    { id: 'sources', label: 'Sources & source maps', support: 'full' },
    {
      id: 'debugger',
      label: 'Debugger',
      support: IS_FIREFOX ? 'limited' : 'full',
      note: IS_FIREFOX ? 'script list & source maps only, no call stack' : undefined,
    },
    {
      id: 'network',
      label: 'Network (HAR)',
      support: IS_FIREFOX ? 'limited' : 'full',
      note: IS_FIREFOX ? 'simplified timings, no service worker requests' : undefined,
    },
    { id: 'styles', label: 'Styles', support: 'full' },
    {
      id: 'storage',
      label: 'Storage',
      support: 'full',
    },
    {
      id: 'accessibility',
      label: 'Accessibility',
      support: IS_FIREFOX ? 'limited' : 'full',
      note: IS_FIREFOX ? 'approximation (roles, ARIA, names)' : undefined,
    },
    {
      id: 'memory',
      label: 'Memory',
      support: IS_FIREFOX ? 'unavailable' : 'limited',
      note: IS_FIREFOX
        ? 'not available to extensions in Firefox'
        : 'heap statistics & memory trace – a real .heapsnapshot is blocked for extensions',
    },
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
