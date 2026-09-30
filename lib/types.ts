// Shared types for the background, UI, content script and collectors.

export type Area =
  | 'dom'
  | 'sources'
  | 'debugger'
  | 'network'
  | 'styles'
  | 'memory'
  | 'storage'
  | 'accessibility'
  // added areas
  | 'console'
  | 'windowGlobals'
  | 'eventListeners'
  | 'performance'
  | 'coverage'
  | 'pageCapture'
  | 'assets'
  | 'application'
  | 'websockets'
  | 'security'
  | 'techstack'
  | 'thirdParties'
  | 'meta'
  | 'findings';

export type FileContent = string | Uint8Array;

/** Common interface: every collector returns files + warnings. */
export interface CollectorResult {
  files: Record<string, FileContent>;
  warnings: string[];
}

export type ComputedStylesMode = 'visible' | 'all' | 'none';

export interface Settings {
  areas: Record<Area, boolean>;
  /** Replace sensitive values (cookies, auth headers, tokens) with [REDACTED]. */
  redact: boolean;
  /** Maximum size of a single file or response body in MB. */
  maxFileSizeMB: number;
  /** Include response bodies in network.har. */
  includeBodies: boolean;
  computedStylesMode: ComputedStylesMode;
  computedStylesLimit: number;
  /** Only store values that differ from browser defaults (saves a lot of space). */
  computedStylesDiffOnly: boolean;
  /** The network counts as "idle" after this many ms without new requests. */
  networkIdleMs: number;
  /** Maximum wait time for "Record & reload" in seconds. */
  networkMaxWaitSec: number;
  /** Maximum number of records per IndexedDB object store. */
  indexedDbMaxRecords: number;
  /** Maximum number of source maps to resolve. */
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
  /** Notes to display in the UI (complete list in manifest.json) */
  warnings?: string[];
  skippedCount?: number;
  /** Areas that are missing or limited in this browser */
  missing?: { label: string; reason?: string }[];
}

/** Extra data the DevTools panel can provide. */
export interface DevtoolsExtras {
  har?: any;
  /** Response bodies the panel collected via devtools.network.onRequestFinished. */
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
  /** Read stylesheets in the content script (only needed without CDP) */
  styleSheets: boolean;
  a11y: boolean;
  application: boolean;
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
  /** Rule text, if readable (same-origin or CORS). */
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
  application?: import('./content/application').AppData;
}

// ---------- MAIN-world probe (console, errors, websockets, web vitals, window globals) ----------

export interface ConsoleEntry {
  level: string;
  ts: number;
  args: string[];
  stack?: string;
  url?: string;
}

export interface PageErrorEntry {
  ts: number;
  kind: 'error' | 'unhandledrejection';
  message: string;
  source?: string;
  line?: number;
  column?: number;
  stack?: string;
}

export interface WsFrame {
  ts: number;
  dir: 'send' | 'receive';
  opcode?: string;
  text?: string;
  binaryByteLength?: number;
  truncated?: boolean;
}

export interface WsConnection {
  kind: 'WebSocket' | 'EventSource';
  url: string;
  protocols?: string;
  openedAt: number;
  closedAt?: number;
  closeCode?: number;
  closeReason?: string;
  frames: WsFrame[];
  framesDropped: number;
}

export interface WebVitals {
  lcp?: number;
  cls?: number;
  inp?: number;
  fcp?: number;
  ttfb?: number;
  longTasks?: number;
  longTaskTotalMs?: number;
}

export interface GlobalEntry {
  name: string;
  type: string;
  preview?: string;
}

/** One frame's snapshot of the MAIN-world probe buffers. */
export interface FrameProbe {
  frameUrl: string;
  isTop: boolean;
  installedAtDocumentStart: boolean;
  console: ConsoleEntry[];
  consoleDropped: number;
  errors: PageErrorEntry[];
  ws: WsConnection[];
  vitals: WebVitals;
  globals: GlobalEntry[];
  navigation?: Record<string, number>;
}
