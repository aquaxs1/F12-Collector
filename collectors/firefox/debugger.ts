// Debugger (fallback/Firefox): script list and source maps only – no call stack.
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
      note: 'path = file in the sources/ folder (if exported)',
      scripts,
    },
    null,
    2,
  );
  result.files['debugger/sourcemaps.json'] = JSON.stringify(ctx.shared.sourceMaps ?? [], null, 2);
  if (!ctx.shared.sourceMaps) result.warnings.push('Source maps are only resolved if "Sources & source maps" is selected too.');
}

export const collectDebuggerFallback: Collector = async (ctx) => {
  const result: CollectorResult = { files: {}, warnings: [] };
  writeScriptLists(ctx, result, ctx.shared.scripts ?? scriptsFromFrames(ctx));
  result.files['debugger/paused-state.json'] = JSON.stringify(
    {
      available: false,
      note: 'In Firefox, extensions have no access to the JavaScript debugger: call stack, scope variables and breakpoints cannot be exported.',
    },
    null,
    2,
  );
  result.warnings.push('Script list and source maps only – call stack and scope variables are not available without a debugger API.');
  return result;
};
