import type { CdpSession } from '../collectors/chrome/cdp';
import type { CollectorResult, DevtoolsExtras, FrameData, RunMode, Settings } from './types';

export interface SkippedFile {
  path: string;
  reason: string;
  size?: number;
}

/** A discovered script (for the debugger area and source maps). */
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

/** Everything a collector needs to know about the running export. */
export interface JobContext {
  tabId: number;
  url: string;
  title: string;
  mode: RunMode;
  settings: Settings;
  startedAt: Date;
  /** Content script results from all frames (frameId 0 = main frame). */
  frames: FrameData[];
  /** Chrome only: attached CDP session (null if unavailable). */
  cdp: CdpSession | null;
  /** Firefox only: the tab's cookie store (container). */
  cookieStoreId?: string;
  devtools?: DevtoolsExtras;
  /** Recorded network data ("Record & reload"). */
  recordedHar?: () => Promise<{ har: any; warnings: string[] }>;
  shared: {
    scripts?: ScriptRecord[];
    sourceMaps?: SourceMapRecord[];
    /** CDP Debugger.paused event, if the page was paused. */
    pausedEvent?: any;
    /** CDP Debugger.scriptParsed events */
    parsedScripts?: any[];
  };
  maxBytes: number;
  skipped: SkippedFile[];
  /** Update the detail text in the progress display. */
  detail(text: string): void;
}

export type Collector = (ctx: JobContext) => Promise<CollectorResult>;

export function emptyResult(): CollectorResult {
  return { files: {}, warnings: [] };
}

export function json(value: unknown): string {
  return JSON.stringify(value, null, 2);
}
