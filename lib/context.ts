import type { CdpSession } from '../collectors/chrome/cdp';
import type { CollectorResult, DevtoolsExtras, FrameData, RunMode, Settings } from './types';

export interface SkippedFile {
  path: string;
  reason: string;
  size?: number;
}

/** Ein gefundenes Script (für Debugger-Bereich und Source Maps). */
export interface ScriptRecord {
  id?: string;
  url: string;
  path?: string;
  sourceMapURL?: string;
  length?: number;
  hash?: string;
  isModule?: boolean;
  startLine?: number;
  kind: 'external' | 'inline' | 'dynamic' | 'stylesheet';
}

export interface SourceMapRecord {
  forUrl: string;
  mapUrl: string;
  path?: string;
  sources: number;
  reconstructed: number;
  error?: string;
}

/** Alles, was ein Collector über den laufenden Export wissen muss. */
export interface JobContext {
  tabId: number;
  url: string;
  title: string;
  mode: RunMode;
  settings: Settings;
  startedAt: Date;
  /** Ergebnisse des Content Scripts aus allen Frames (frameId 0 = Hauptframe). */
  frames: FrameData[];
  /** Nur Chrome: verbundene CDP-Session (null, wenn nicht verfügbar). */
  cdp: CdpSession | null;
  /** Nur Firefox: Cookie-Store des Tabs (Container). */
  cookieStoreId?: string;
  devtools?: DevtoolsExtras;
  /** Aufgezeichnete Netzwerkdaten ("Aufzeichnen & neu laden"). */
  recordedHar?: () => Promise<{ har: any; warnings: string[] }>;
  shared: {
    scripts?: ScriptRecord[];
    sourceMaps?: SourceMapRecord[];
    /** CDP Debugger.paused-Event, falls die Seite pausiert war. */
    pausedEvent?: any;
    /** CDP Debugger.scriptParsed-Events */
    parsedScripts?: any[];
  };
  maxBytes: number;
  skipped: SkippedFile[];
  /** Detailtext in der Fortschrittsanzeige aktualisieren. */
  detail(text: string): void;
}

export type Collector = (ctx: JobContext) => Promise<CollectorResult>;

export function emptyResult(): CollectorResult {
  return { files: {}, warnings: [] };
}

export function json(value: unknown): string {
  return JSON.stringify(value, null, 2);
}
