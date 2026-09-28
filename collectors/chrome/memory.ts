// Memory (Chrome).
//
// Ein echter Heap Snapshot (HeapProfiler.takeHeapSnapshot → .heapsnapshot) ist für Extensions NICHT möglich:
// chrome.debugger erlaubt nur eine feste Liste von CDP-Domains, HeapProfiler und Memory gehören nicht dazu
// ("'HeapProfiler.enable' wasn't found"). Stattdessen exportieren wir, was über erlaubte Domains geht:
//  - memory/heap-usage.json       Runtime.getHeapUsage + performance.memory
//  - memory/object-counts.json    Objekt-Statistik je Konstruktor (Runtime.queryObjects, wie "Summary" im Heap Snapshot)
//  - memory/memory-infra.trace.json  Memory-Dump über Tracing (disabled-by-default-memory-infra), ladbar in Perfetto
import type { Collector } from '@/lib/context';
import { errMsg, formatBytes } from '@/lib/fetcher';
import type { CollectorResult } from '@/lib/types';
import type { CdpSession } from './cdp';

const GROUP = 'f12c-memory';

const PROTOTYPES = [
  'Object', 'Array', 'Function', 'Promise', 'Map', 'Set', 'WeakMap', 'WeakSet', 'Date', 'RegExp', 'Error',
  'ArrayBuffer', 'Uint8Array', 'EventTarget', 'Node', 'Element', 'HTMLElement', 'Text', 'Event', 'Blob',
];

/** Gruppiert alle Objekte des Arrays nach Konstruktor-Namen (läuft in der Seite, ohne Getter auszulösen). */
const HISTOGRAM_FN = `function () {
  const m = {};
  for (const o of this) {
    let n = '(unbekannt)';
    try {
      const p = Object.getPrototypeOf(o);
      const d = p && Object.getOwnPropertyDescriptor(p, 'constructor');
      n = (d && typeof d.value === 'function' && d.value.name) || (p === null ? '(null-prototype)' : '(anonym)');
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
      counts[name] = `Fehler: ${errMsg(e)}`;
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
    detail('Memory-Dump anfordern');
    const dump = await cdp.send('Tracing.requestMemoryDump', { deterministic: true, levelOfDetail: 'detailed' });
    if (!dump.success) throw new Error('requestMemoryDump fehlgeschlagen');
    await cdp.send('Tracing.end');
    const done = await Promise.race([complete, new Promise((_, rej) => setTimeout(() => rej(new Error('Tracing: Zeitüberschreitung')), 60000))]);
    const handle = (done as any).stream;
    if (!handle) throw new Error('kein Trace-Stream');
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
  if (!ctx.cdp) throw new Error('Memory-Daten benötigen den Chrome-Debugger (chrome.debugger), der nicht verbunden werden konnte.');
  const cdp = ctx.cdp;
  const result: CollectorResult = { files: {}, warnings: [] };

  ctx.detail('Heap-Nutzung');
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

  ctx.detail('Objekt-Statistik (Runtime.queryObjects)');
  try {
    const stats = await objectStats(cdp);
    result.files['memory/object-counts.json'] = JSON.stringify(
      {
        note: 'Anzahl lebender Objekte je Prototyp bzw. Konstruktor (entspricht grob der "Summary"-Ansicht eines Heap Snapshots, ohne Größen und Retainer). Mehr Node-Objekte als DOM-Elemente im Dokument können auf abgelöste (detached) DOM-Knoten hinweisen.',
        ...stats,
      },
      null,
      2,
    );
  } catch (e) {
    result.warnings.push(`Objekt-Statistik: ${errMsg(e)}`);
  }

  ctx.detail('Memory-Trace (memory-infra)');
  try {
    const trace = await memoryTrace(cdp, ctx.detail);
    result.files['memory/memory-infra.trace.json'] = trace;
  } catch (e) {
    result.warnings.push(`Memory-Trace: ${errMsg(e)}`);
  }

  result.files['memory/LIESMICH.txt'] = [
    'F12 Collector – Memory',
    '',
    'Ein echter Heap Snapshot (.heapsnapshot) kann von Browser-Extensions nicht erstellt werden:',
    'Chrome erlaubt über chrome.debugger nur bestimmte DevTools-Protocol-Domains, "HeapProfiler" gehört nicht dazu.',
    '',
    'Enthalten sind stattdessen:',
    '  heap-usage.json            – belegter/gesamter JS-Heap (Runtime.getHeapUsage, performance.memory)',
    '  object-counts.json         – Anzahl lebender Objekte je Konstruktor (Runtime.queryObjects)',
    '  memory-infra.trace.json    – detaillierter Memory-Dump (V8-Heap-Spaces, Blink, Malloc …)',
    '                               → in https://ui.perfetto.dev per "Open trace file" öffnen (läuft lokal im Browser)',
    '',
    'Echten Heap Snapshot manuell erstellen:',
    '  DevTools (F12) → Tab "Memory" → "Heap snapshot" → "Take snapshot" → Rechtsklick auf den Snapshot → "Save…"',
    '  Die gespeicherte .heapsnapshot-Datei kann in DevTools > Memory über "Load" wieder geöffnet werden.',
  ].join('\n');
  result.warnings.push('Kein .heapsnapshot möglich (HeapProfiler ist für Extensions gesperrt) – stattdessen Heap-Statistik, Objekt-Zählung und Memory-Trace, siehe memory/LIESMICH.txt.');
  return result;
};
