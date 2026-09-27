// Gemeinsame Typen für Background, UI, Content Script und Collector.

export type Area =
  | 'dom'
  | 'sources'
  | 'debugger'
  | 'network'
  | 'styles'
  | 'memory'
  | 'storage'
  | 'accessibility';

export type FileContent = string | Uint8Array;

/** Einheitliche Schnittstelle: jeder Collector liefert Dateien + Warnungen. */
export interface CollectorResult {
  files: Record<string, FileContent>;
  warnings: string[];
}

export type ComputedStylesMode = 'visible' | 'all' | 'none';

export interface Settings {
  areas: Record<Area, boolean>;
  /** Sensible Werte (Cookies, Auth-Header, Tokens) durch [REDACTED] ersetzen. */
  redact: boolean;
  /** Maximale Größe einer einzelnen Datei bzw. eines Response-Bodys in MB. */
  maxFileSizeMB: number;
  /** Response-Bodies in network.har aufnehmen. */
  includeBodies: boolean;
  computedStylesMode: ComputedStylesMode;
  computedStylesLimit: number;
  /** Nur Werte speichern, die vom Browser-Standard abweichen (spart viel Platz). */
  computedStylesDiffOnly: boolean;
  /** Netzwerk gilt als "ruhig" nach so vielen ms ohne neue Requests. */
  networkIdleMs: number;
  /** Maximale Wartezeit bei "Aufzeichnen & neu laden" in Sekunden. */
  networkMaxWaitSec: number;
  /** Maximale Anzahl Datensätze pro IndexedDB-Object-Store. */
  indexedDbMaxRecords: number;
  /** Maximale Anzahl Source Maps, die aufgelöst werden. */
  maxSourceMaps: number;
}

export type RunMode = 'snapshot' | 'record';

export type StepStatus = 'pending' | 'running' | 'done' | 'warning' | 'error' | 'skipped';

export interface ProgressStep {
  id: string;
  label: string;
  status: StepStatus;
  detail?: string;
}

export interface JobState {
  running: boolean;
  tabId?: number;
  url?: string;
  mode?: RunMode;
  steps: ProgressStep[];
  message?: string;
  error?: string;
  finishedAt?: string;
  fileName?: string;
  warningsCount?: number;
  /** Hinweise für die Anzeige im UI (vollständig in manifest.json) */
  warnings?: string[];
  skippedCount?: number;
  /** Bereiche, die in diesem Browser fehlen oder eingeschränkt sind */
  missing?: { label: string; reason?: string }[];
}

/** Daten, die das DevTools-Panel zusätzlich mitliefern kann. */
export interface DevtoolsExtras {
  har?: any;
  /** Response-Bodies, die das Panel über devtools.network.onRequestFinished gesammelt hat. */
  bodies?: { url: string; method: string; content: string; encoding?: string; mimeType?: string }[];
}

export interface StartJobMessage {
  type: 'start-job';
  tabId: number;
  mode: RunMode;
  settings: Settings;
  source: 'popup' | 'devtools';
  devtools?: DevtoolsExtras;
}

export type UiToBackground = StartJobMessage | { type: 'get-state' } | { type: 'get-tab'; tabId: number };

export type BackgroundToUi = { type: 'state'; state: JobState };

// ---------- Content Script ----------

export interface ContentCollectOptions {
  dom: boolean;
  resources: boolean;
  storage: boolean;
  styles: boolean;
  /** Stylesheets im Content Script lesen (nur nötig ohne CDP) */
  styleSheets: boolean;
  a11y: boolean;
  computedStylesMode: ComputedStylesMode;
  computedStylesLimit: number;
  computedStylesDiffOnly: boolean;
  indexedDbMaxRecords: number;
  maxBodyBytes: number;
}

export interface ShadowRootInfo {
  host: string;
  mode: string;
  html: string;
}

export interface ScriptInfo {
  src?: string;
  inline?: string;
  type?: string;
  index: number;
}

export interface StylesheetInfo {
  href?: string;
  /** Regeltext, falls lesbar (Same-Origin oder CORS). */
  text?: string;
  owner: string;
  media?: string;
  crossOriginBlocked?: boolean;
  index: number;
}

export interface PerfEntryInfo {
  name: string;
  initiatorType: string;
  startTime: number;
  duration: number;
  transferSize?: number;
  encodedBodySize?: number;
  decodedBodySize?: number;
  nextHopProtocol?: string;
  responseStatus?: number;
}

export interface IndexedDbDump {
  name: string;
  version: number;
  stores: {
    name: string;
    keyPath: unknown;
    autoIncrement: boolean;
    indexes: { name: string; keyPath: unknown; unique: boolean; multiEntry: boolean }[];
    count: number;
    truncated: boolean;
    records: { key: unknown; value: unknown }[];
  }[];
  error?: string;
}

export interface CacheDump {
  name: string;
  entries: {
    url: string;
    method: string;
    status: number;
    statusText: string;
    headers: [string, string][];
    size: number;
    body?: string;
    encoding?: 'base64';
    skipped?: string;
  }[];
  error?: string;
}

export interface ComputedStyleEntry {
  selector: string;
  tag: string;
  rect: { x: number; y: number; width: number; height: number };
  styles: Record<string, string>;
}

export interface A11yNode {
  role: string;
  name?: string;
  tag?: string;
  level?: number;
  states?: Record<string, string | boolean>;
  aria?: Record<string, string>;
  hidden?: boolean;
  children?: A11yNode[];
}

export interface FrameData {
  frameId: number;
  url: string;
  origin: string;
  isTop: boolean;
  title: string;
  errors: string[];
  dom?: { html: string; shadowRoots: ShadowRootInfo[]; nodeCount: number };
  resources?: {
    scripts: ScriptInfo[];
    stylesheets: StylesheetInfo[];
    performance: PerfEntryInfo[];
    timeOrigin: number;
    navigation?: PerfEntryInfo;
  };
  storage?: {
    local: Record<string, string> | { __error: string };
    session: Record<string, string> | { __error: string };
    indexedDB: IndexedDbDump[] | { __error: string };
    cache: CacheDump[] | { __error: string };
  };
  styles?: {
    sheets: StylesheetInfo[];
    computed: ComputedStyleEntry[];
    computedTotalCandidates: number;
  };
  a11y?: { tree: A11yNode; nodeCount: number; truncated: boolean };
}
