// Auswahl der Collector je Browser. Chrome nutzt CDP (chrome.debugger), Firefox die Fallbacks.
import type { Collector } from '@/lib/context';
import type { Area } from '@/lib/types';
import { collectDomChrome } from './chrome/dom';
import { collectSourcesChrome } from './chrome/sources';
import { collectDomFallback } from './firefox/dom';
import { collectSourcesFallback } from './firefox/sources';
import { collectNetwork } from './shared/network';
import { collectStorage } from './shared/storage';

const chromeCollectors: Partial<Record<Area, Collector>> = {
  dom: collectDomChrome,
  sources: collectSourcesChrome,
  network: collectNetwork,
  storage: collectStorage,
};

const firefoxCollectors: Partial<Record<Area, Collector>> = {
  dom: collectDomFallback,
  sources: collectSourcesFallback,
  network: collectNetwork,
  storage: collectStorage,
};

export const collectors: Partial<Record<Area, Collector>> = import.meta.env.FIREFOX ? firefoxCollectors : chromeCollectors;
