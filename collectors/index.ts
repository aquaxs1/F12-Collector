// Auswahl der Collector je Browser. Chrome nutzt CDP (chrome.debugger), Firefox die Fallbacks.
import type { Collector } from '@/lib/context';
import type { Area } from '@/lib/types';
import { collectA11yChrome } from './chrome/accessibility';
import { collectDomChrome } from './chrome/dom';
import { collectSourcesChrome } from './chrome/sources';
import { collectStylesChrome } from './chrome/styles';
import { collectA11yFallback } from './firefox/accessibility';
import { collectDomFallback } from './firefox/dom';
import { collectSourcesFallback } from './firefox/sources';
import { collectStylesFallback } from './firefox/styles';
import { collectNetwork } from './shared/network';
import { collectStorage } from './shared/storage';

const chromeCollectors: Partial<Record<Area, Collector>> = {
  dom: collectDomChrome,
  sources: collectSourcesChrome,
  styles: collectStylesChrome,
  accessibility: collectA11yChrome,
  network: collectNetwork,
  storage: collectStorage,
};

const firefoxCollectors: Partial<Record<Area, Collector>> = {
  dom: collectDomFallback,
  sources: collectSourcesFallback,
  styles: collectStylesFallback,
  accessibility: collectA11yFallback,
  network: collectNetwork,
  storage: collectStorage,
};

export const collectors: Partial<Record<Area, Collector>> = import.meta.env.FIREFOX ? firefoxCollectors : chromeCollectors;
