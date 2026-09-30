// Console area. Primary source: the MAIN-world probe (console.* calls, window errors and
// unhandled rejections captured from document_start). On Chrome we additionally include
// browser-level messages captured live via CDP (Log/Runtime) during the job window.
import type { Collector } from '@/lib/context';
import { redactTokensInString } from '@/lib/redact';
import type { ConsoleEntry, PageErrorEntry } from '@/lib/types';
import { json } from '@/lib/context';

const red = (s: string | undefined) => (s === undefined ? undefined : redactTokensInString(s));

export const collectConsole: Collector = async (ctx) => {
  const result = { files: {} as Record<string, string>, warnings: [] as string[] };
  const redact = ctx.settings.redact;

  const frames = (ctx.shared.probe ?? []).map((f, i) => ({
    frameId: i === 0 ? 0 : undefined,
    url: f.frameUrl || (f.isTop ? ctx.url : undefined),
    isTop: f.isTop,
    installedAtDocumentStart: f.installedAtDocumentStart,
    consoleDropped: f.consoleDropped,
    console: (f.console as ConsoleEntry[]).map((e) => ({
      level: e.level,
      time: new Date(e.ts).toISOString(),
      args: redact ? e.args.map((a) => red(a)!) : e.args,
      stack: redact ? red(e.stack) : e.stack,
    })),
    errors: (f.errors as PageErrorEntry[]).map((e) => ({
      ...e,
      time: new Date(e.ts).toISOString(),
      message: redact ? red(e.message)! : e.message,
      stack: redact ? red(e.stack) : e.stack,
    })),
  }));

  const cdp = (ctx.shared.consoleEvents ?? []).map((e) => ({ source: e.source, ...formatCdp(e.entry, redact) }));

  const totalConsole = frames.reduce((n, f) => n + f.console.length, 0);
  const totalErrors = frames.reduce((n, f) => n + f.errors.length, 0);

  result.files['console/console.json'] = json({
    note: 'pageConsole/errors come from an in-page probe injected at document_start; they are only complete if the page loaded with the extension installed (use "Record & reload"). cdpLog (Chrome) adds browser-level messages captured while exporting.',
    summary: { frames: frames.length, consoleMessages: totalConsole, pageErrors: totalErrors, cdpLogEntries: cdp.length },
    frames,
    cdpLog: cdp,
  });

  if (!ctx.shared.probe || !frames.length)
    result.warnings.push('No in-page console data (probe missing). Reload the page with the extension installed, or use "Record & reload".');
  if (frames.some((f) => f.consoleDropped)) result.warnings.push('Some console messages were dropped (per-frame cap reached).');
  if (frames.some((f) => !f.installedAtDocumentStart))
    result.warnings.push('Probe attached after document_start in at least one frame – early messages may be missing.');
  return result;
};

function formatCdp(entry: any, redact: boolean) {
  // Runtime.consoleAPICalled / Runtime.exceptionThrown / Log.entryAdded
  if (entry.type && entry.args) {
    const args = (entry.args ?? []).map((a: any) => a.value ?? a.description ?? a.unserializableValue ?? a.type);
    return { kind: 'console', level: entry.type, time: entry.timestamp ? new Date(entry.timestamp).toISOString() : undefined, args: redact ? args.map((x: any) => (typeof x === 'string' ? redactTokensInString(x) : x)) : args };
  }
  if (entry.exceptionDetails) {
    const d = entry.exceptionDetails;
    const text = d.exception?.description ?? d.text ?? 'exception';
    return { kind: 'exception', level: 'error', text: redact ? redactTokensInString(text) : text, url: d.url, line: d.lineNumber, column: d.columnNumber };
  }
  // Log.entryAdded
  const text = entry.text ?? '';
  return { kind: 'log', level: entry.level, source: entry.source, time: entry.timestamp ? new Date(entry.timestamp).toISOString() : undefined, text: redact ? redactTokensInString(text) : text, url: entry.url, line: entry.lineNumber, networkRequestId: entry.networkRequestId };
}
