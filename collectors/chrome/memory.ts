// Memory (Chrome).
//
// A real heap snapshot (HeapProfiler.takeHeapSnapshot → .heapsnapshot) is NOT possible for extensions:
// chrome.debugger only allows a fixed list of CDP domains, and HeapProfiler and Memory are not among them
// ("'HeapProfiler.enable' wasn't found"). Instead we export what the allowed domains provide:
//  - memory/heap-usage.json          Runtime.getHeapUsage + performance.memory
//  - memory/object-counts.json       object statistics per constructor (Runtime.queryObjects, like "Summary" in a heap snapshot)
//  - memory/memory-infra.trace.json  memory dump via Tracing (disabled-by-default-memory-infra), loadable in Perfetto
import type { Collector } from '@/lib/context';
import { errMsg, formatBytes } from '@/lib/fetcher';
import type { CollectorResult } from '@/lib/types';
import type { CdpSession } from './cdp';

const GROUP = 'f12c-memory';

const PROTOTYPES = [
  'Object', 'Array', 'Function', 'Promise', 'Map', 'Set', 'WeakMap', 'WeakSet', 'Date', 'RegExp', 'Error',
  'ArrayBuffer', 'Uint8Array', 'EventTarget', 'Node', 'Element', 'HTMLElement', 'Text', 'Event', 'Blob',
];

/** Groups all objects of the array by constructor name (runs in the page without triggering getters). */
const HISTOGRAM_FN = `function () {
  const m = {};
  for (const o of this) {
    let n = '(unknown)';
    try {
      const p = Object.getPrototypeOf(o);
      const d = p && Object.getOwnPropertyDescriptor(p, 'constructor');
      n = (d && typeof d.value === 'function' && d.value.name) || (p === null ? '(null-prototype)' : '(anonymous)');
    } catch (e) {}
    m[n] = (m[n] || 0) + 1;
  }
  return m;
}`;

async function objectStats(cdp: CdpSession) {
  const counts: Record<string, number | string> = {};
  let histogram: Record<string, number> | undefined;
  for (const name of PROTOTYPES) {
    try {
      const proto = await cdp.send('Runtime.evaluate', { expression: `${name}.prototype`, objectGroup: GROUP, silent: true });
      if (!proto.result?.objectId) continue;
      const q = await cdp.send('Runtime.queryObjects', { prototypeObjectId: proto.result.objectId, objectGroup: GROUP });
      const len = await cdp.send('Runtime.callFunctionOn', {
        objectId: q.objects.objectId,
        functionDeclaration: 'function(){return this.length}',
        returnByValue: true,
        silent: true,
      });
      counts[name] = len.result?.value ?? 0;
      if (name === 'Object') {
        const h = await cdp.send('Runtime.callFunctionOn', { objectId: q.objects.objectId, functionDeclaration: HISTOGRAM_FN, returnByValue: true, silent: true });
        histogram = h.result?.value;
      }
    } catch (e) {
      counts[name] = `Error: ${errMsg(e)}`;
    } finally {
      await cdp.send('Runtime.releaseObjectGroup', { objectGroup: GROUP }).catch(() => {});
    }
  }
  const byConstructor = histogram
    ? Object.entries(histogram)
        .sort((a, b) => b[1] - a[1])
        .map(([constructor, count]) => ({ constructor, count }))
    : [];
  return { instancesByPrototype: counts, objectsByConstructor: byConstructor };
}

async function memoryTrace(cdp: CdpSession, detail: (t: string) => void): Promise<string> {
  let resolve!: (p: any) => void;
  const complete = new Promise<any>((r) => (resolve = r));
  const off = cdp.on('Tracing.tracingComplete', (p) => resolve(p));
  try {
    await cdp.send('Tracing.start', {
      traceConfig: { includedCategories: ['disabled-by-default-memory-infra'], memoryDumpConfig: { triggers: [] } },
      transferMode: 'ReturnAsStream',
    });
    detail('requesting memory dump');
    const dump = await cdp.send('Tracing.requestMemoryDump', { deterministic: true, levelOfDetail: 'detailed' });
    if (!dump.success) throw new Error('requestMemoryDump failed');
    await cdp.send('Tracing.end');
    const done = await Promise.race([complete, new Promise((_, rej) => setTimeout(() => rej(new Error('Tracing: timed out')), 60000))]);
    const handle = (done as any).stream;
    if (!handle) throw new Error('no trace stream');
    const parts: string[] = [];
    for (let i = 0; i < 10000; i++) {
      const c = await cdp.send<{ data: string; eof: boolean; base64Encoded?: boolean }>('IO.read', { handle, size: 4 * 1024 * 1024 });
      parts.push(c.base64Encoded ? atob(c.data) : c.data);
      if (c.eof) break;
    }
    await cdp.send('IO.close', { handle }).catch(() => {});
    return parts.join('');
  } finally {
    off();
  }
}

export const collectMemoryChrome: Collector = async (ctx) => {
  if (!ctx.cdp) throw new Error('Memory data requires the Chrome debugger (chrome.debugger), which could not be attached.');
  const cdp = ctx.cdp;
  const result: CollectorResult = { files: {}, warnings: [] };

  ctx.detail('heap usage');
  const usage = await cdp.send('Runtime.getHeapUsage').catch((e) => ({ error: errMsg(e) }));
  const perf = await cdp
    .send('Runtime.evaluate', {
      expression:
        '(() => { const m = performance.memory; return m ? { jsHeapSizeLimit: m.jsHeapSizeLimit, totalJSHeapSize: m.totalJSHeapSize, usedJSHeapSize: m.usedJSHeapSize } : null })()',
      returnByValue: true,
      silent: true,
    })
    .then((r) => r.result?.value)
    .catch(() => null);
  const counts = await cdp
    .send('Runtime.evaluate', { expression: 'document.getElementsByTagName("*").length', returnByValue: true, silent: true })
    .then((r) => r.result?.value)
    .catch(() => null);
  result.files['memory/heap-usage.json'] = JSON.stringify(
    {
      runtimeGetHeapUsage: usage,
      performanceMemory: perf,
      domElementsInDocument: counts,
      readable: 'usedSize' in (usage as any) ? { used: formatBytes((usage as any).usedSize), total: formatBytes((usage as any).totalSize) } : undefined,
    },
    null,
    2,
  );

  ctx.detail('object statistics (Runtime.queryObjects)');
  try {
    const stats = await objectStats(cdp);
    result.files['memory/object-counts.json'] = JSON.stringify(
      {
        note: 'Number of live objects per prototype/constructor (roughly the "Summary" view of a heap snapshot, without sizes and retainers). More Node objects than DOM elements in the document can indicate detached DOM nodes.',
        ...stats,
      },
      null,
      2,
    );
  } catch (e) {
    result.warnings.push(`Object statistics: ${errMsg(e)}`);
  }

  ctx.detail('memory trace (memory-infra)');
  try {
    const trace = await memoryTrace(cdp, ctx.detail);
    result.files['memory/memory-infra.trace.json'] = trace;
  } catch (e) {
    result.warnings.push(`Memory trace: ${errMsg(e)}`);
  }

  result.files['memory/README.txt'] = [
    'F12 Collector – Memory',
    '',
    'Browser extensions cannot create a real heap snapshot (.heapsnapshot):',
    'Chrome only allows certain DevTools Protocol domains via chrome.debugger, and "HeapProfiler" is not one of them.',
    '',
    'Included instead:',
    '  heap-usage.json            – used/total JS heap (Runtime.getHeapUsage, performance.memory)',
    '  object-counts.json         – number of live objects per constructor (Runtime.queryObjects)',
    '  memory-infra.trace.json    – detailed memory dump (V8 heap spaces, Blink, malloc …)',
    '                               → open it in https://ui.perfetto.dev via "Open trace file" (runs locally in your browser)',
    '',
    'To take a real heap snapshot manually:',
    '  DevTools (F12) → "Memory" tab → "Heap snapshot" → "Take snapshot" → right-click the snapshot → "Save…"',
    '  The saved .heapsnapshot file can be reopened in DevTools > Memory via "Load".',
  ].join('\n');
  result.warnings.push('No .heapsnapshot possible (HeapProfiler is blocked for extensions) – exported heap statistics, object counts and a memory trace instead, see memory/README.txt.');
  return result;
};
