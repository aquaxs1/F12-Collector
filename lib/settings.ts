import { browser } from 'wxt/browser';
import { DEFAULT_SETTINGS, getAreas } from './areas';
import type { Settings } from './types';

const KEY = 'f12c-settings';

/** Lädt die gespeicherten Einstellungen (fehlende Werte = Standard). */
export async function loadSettings(): Promise<Settings> {
  try {
    const stored = (await browser.storage.local.get(KEY))[KEY] as Partial<Settings> | undefined;
    return normalizeSettings(stored);
  } catch {
    return structuredClone(DEFAULT_SETTINGS);
  }
}

export async function saveSettings(settings: Settings): Promise<void> {
  await browser.storage.local.set({ [KEY]: settings });
}

export function normalizeSettings(input?: Partial<Settings>): Settings {
  const s: Settings = { ...structuredClone(DEFAULT_SETTINGS), ...(input ?? {}) };
  s.areas = { ...DEFAULT_SETTINGS.areas, ...(input?.areas ?? {}) };
  // Bereiche, die im aktuellen Browser nicht möglich sind, immer deaktivieren
  for (const a of getAreas()) if (a.support === 'unavailable') s.areas[a.id] = false;
  const num = (v: unknown, def: number, min: number, max: number) => {
    const n = Number(v);
    return Number.isFinite(n) ? Math.min(max, Math.max(min, n)) : def;
  };
  s.maxFileSizeMB = num(s.maxFileSizeMB, DEFAULT_SETTINGS.maxFileSizeMB, 0.1, 2000);
  s.computedStylesLimit = num(s.computedStylesLimit, DEFAULT_SETTINGS.computedStylesLimit, 1, 100000);
  s.networkIdleMs = num(s.networkIdleMs, DEFAULT_SETTINGS.networkIdleMs, 250, 60000);
  s.networkMaxWaitSec = num(s.networkMaxWaitSec, DEFAULT_SETTINGS.networkMaxWaitSec, 3, 600);
  s.indexedDbMaxRecords = num(s.indexedDbMaxRecords, DEFAULT_SETTINGS.indexedDbMaxRecords, 0, 1000000);
  s.maxSourceMaps = num(s.maxSourceMaps, DEFAULT_SETTINGS.maxSourceMaps, 0, 10000);
  if (!['visible', 'all', 'none'].includes(s.computedStylesMode)) s.computedStylesMode = 'visible';
  return s;
}
