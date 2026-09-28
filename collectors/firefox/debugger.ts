// Debugger (Fallback/Firefox): nur Script-Liste und Source Maps – kein Call Stack.
import type { Collector, JobContext, ScriptRecord } from '@/lib/context';
import type { CollectorResult } from '@/lib/types';

export function scriptsFromFrames(ctx: JobContext): ScriptRecord[] {
  return ctx.frames.flatMap((f) =>
    (f.resources?.scripts ?? []).map((s) =>
      s.src ? { url: s.src, kind: 'external' as const, isModule: s.type === 'module' } : { url: f.url, kind: 'inline' as const, length: s.inline?.length, isModule: s.type === 'module' },
    ),
  );
}

export function writeScriptLists(ctx: JobContext, result: CollectorResult, scripts: ScriptRecord[]) {
  result.files['debugger/scripts.json'] = JSON.stringify(
    {
      count: scripts.length,
      note: 'path = Datei im Ordner sources/ (falls exportiert)',
      scripts,
    },
    null,
    2,
  );
  result.files['debugger/sourcemaps.json'] = JSON.stringify(ctx.shared.sourceMaps ?? [], null, 2);
  if (!ctx.shared.sourceMaps) result.warnings.push('Source Maps werden nur aufgelöst, wenn auch "Quellcode & Source Maps" ausgewählt ist.');
}

export const collectDebuggerFallback: Collector = async (ctx) => {
  const result: CollectorResult = { files: {}, warnings: [] };
  writeScriptLists(ctx, result, ctx.shared.scripts ?? scriptsFromFrames(ctx));
  result.files['debugger/paused-state.json'] = JSON.stringify(
    {
      available: false,
      note: 'In Firefox haben Extensions keinen Zugriff auf den JavaScript-Debugger: Call Stack, Scope-Variablen und Breakpoints können nicht exportiert werden.',
    },
    null,
    2,
  );
  result.warnings.push('Nur Script-Liste und Source Maps – Call Stack und Scope-Variablen sind ohne Debugger-API nicht verfügbar.');
  return result;
};
