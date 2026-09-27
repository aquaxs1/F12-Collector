import type { Area, Settings } from './types';

export const IS_FIREFOX = import.meta.env.FIREFOX;
export const BROWSER_NAME = IS_FIREFOX ? 'firefox' : 'chrome';

export interface AreaInfo {
  id: Area;
  label: string;
  /** full = vollständig, limited = eingeschränkt, unavailable = nicht möglich */
  support: 'full' | 'limited' | 'unavailable';
  note?: string;
}

/** Bereiche in der Reihenfolge, in der sie im UI angezeigt und gesammelt werden. */
export function getAreas(): AreaInfo[] {
  return [
    { id: 'dom', label: 'DOM (Inspektor)', support: 'full' },
    { id: 'sources', label: 'Quellcode & Source Maps', support: 'full' },
    {
      id: 'debugger',
      label: 'Debugger',
      support: IS_FIREFOX ? 'limited' : 'full',
      note: IS_FIREFOX ? 'nur Script-Liste & Source Maps, kein Call Stack' : undefined,
    },
    {
      id: 'network',
      label: 'Netzwerk (HAR)',
      support: 'full',
    },
    { id: 'styles', label: 'Styles', support: 'full' },
    {
      id: 'storage',
      label: 'Webspeicher',
      support: 'full',
    },
    {
      id: 'accessibility',
      label: 'Barrierefreiheit',
      support: IS_FIREFOX ? 'limited' : 'full',
      note: IS_FIREFOX ? 'Annäherung (Rollen, ARIA, Namen)' : undefined,
    },
    {
      id: 'memory',
      label: 'Memory',
      support: IS_FIREFOX ? 'unavailable' : 'limited',
      note: IS_FIREFOX
        ? 'in Firefox für Extensions nicht verfügbar'
        : 'Heap-Statistik & Memory-Trace – echter .heapsnapshot ist für Extensions gesperrt',
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
