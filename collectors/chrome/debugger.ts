// Debugger (Chrome): Script-Liste, Source Maps und – falls die Seite pausiert ist – Call Stack & Scope-Variablen.
import { collectDebuggerFallback, writeScriptLists } from '@/collectors/firefox/debugger';
import type { Collector, ScriptRecord } from '@/lib/context';
import { errMsg } from '@/lib/fetcher';
import { REDACTED, isSensitiveKey, redactDeep } from '@/lib/redact';
import type { CollectorResult } from '@/lib/types';
import type { CdpSession } from './cdp';
import { isExtensionUrl } from './sources';

const MAX_PROPS = 300;

/** RemoteObject → kompakte, JSON-taugliche Beschreibung */
function summarize(o: any): unknown {
  if (!o) return undefined;
  const out: Record<string, unknown> = { type: o.type };
  if (o.subtype) out.subtype = o.subtype;
  if (o.className) out.className = o.className;
  if ('value' in o) out.value = o.value;
  else if (o.unserializableValue) out.value = o.unserializableValue;
  else if (o.description) out.description = o.description.length > 500 ? o.description.slice(0, 500) + '…' : o.description;
  if (o.preview?.properties)
    out.preview = Object.fromEntries(o.preview.properties.map((p: any) => [p.name, p.valuePreview?.description ?? p.value ?? p.type]));
  return out;
}

async function scopeVariables(cdp: CdpSession, objectId: string) {
  const { result } = await cdp.send<{ result: any[] }>('Runtime.getProperties', { objectId, ownProperties: true, generatePreview: true });
  const vars: Record<string, unknown> = {};
  for (const p of result.slice(0, MAX_PROPS)) vars[p.name] = p.value ? summarize(p.value) : p.get ? { type: 'accessor' } : undefined;
  return { variables: vars, truncated: result.length > MAX_PROPS ? result.length : undefined };
}

export const collectDebuggerChrome: Collector = async (ctx) => {
  if (!ctx.cdp) {
    const r = await collectDebuggerFallback(ctx);
    r.warnings.unshift('Chrome-Debugger nicht verbunden.');
    return r;
  }
  const cdp = ctx.cdp;
  const result: CollectorResult = { files: {}, warnings: [] };

  const scripts: ScriptRecord[] =
    ctx.shared.scripts ??
    (ctx.shared.parsedScripts ?? [])
      .filter((p) => !isExtensionUrl(p.url ?? '') && p.executionContextAuxData?.type !== 'isolated')
      .map((p) => ({
        id: p.scriptId,
        url: p.url || `(dynamisch, scriptId ${p.scriptId})`,
        sourceMapURL: p.sourceMapURL || undefined,
        length: p.length,
        hash: p.hash,
        isModule: p.isModule,
        startLine: p.startLine,
        kind: p.url ? 'external' : 'dynamic',
      }));
  writeScriptLists(ctx, result, scripts);

  const paused = ctx.shared.pausedEvent;
  if (!paused) {
    result.files['debugger/paused-state.json'] = JSON.stringify(
      {
        paused: false,
        note: 'Die Seite war beim Export nicht im Debugger angehalten. Für Call Stack & Scope-Variablen: in den DevTools einen Breakpoint setzen, warten bis die Seite anhält, dann im Tab "F12 Collector" auf "Snapshot erstellen" klicken.',
      },
      null,
      2,
    );
    return result;
  }

  const pathOf = new Map(scripts.filter((s) => s.id).map((s) => [s.id!, s]));
  const frames = [];
  for (const [i, f] of (paused.callFrames ?? []).entries()) {
    ctx.detail(`Call Stack ${i + 1}/${paused.callFrames.length}`);
    const script = pathOf.get(f.location.scriptId);
    const scopes = [];
    for (const s of f.scopeChain ?? []) {
      const scope: Record<string, unknown> = {
        type: s.type,
        name: s.name,
        startLocation: s.startLocation ? { line: s.startLocation.lineNumber + 1, column: s.startLocation.columnNumber + 1 } : undefined,
      };
      if (s.type === 'global') scope.note = 'globaler Scope nicht exportiert (zu groß)';
      else if (s.object?.objectId) {
        try {
          const vars = await scopeVariables(cdp, s.object.objectId);
          if (ctx.settings.redact) {
            for (const [name, v] of Object.entries(vars.variables))
              if (isSensitiveKey(name) && v && typeof v === 'object' && ('value' in v || 'description' in v))
                vars.variables[name] = { ...(v as object), value: REDACTED, description: undefined, preview: undefined };
            vars.variables = redactDeep(vars.variables) as Record<string, unknown>;
          }
          Object.assign(scope, vars);
        } catch (e) {
          scope.error = errMsg(e);
        }
      }
      scopes.push(scope);
    }
    frames.push({
      index: i,
      functionName: f.functionName || '(anonym)',
      url: f.url || script?.url,
      file: script?.path,
      line: f.location.lineNumber + 1,
      column: (f.location.columnNumber ?? 0) + 1,
      this: summarize(f.this),
      returnValue: f.returnValue ? summarize(f.returnValue) : undefined,
      scopeChain: scopes,
    });
  }
  const asyncFrames: unknown[] = [];
  for (let st = paused.asyncStackTrace; st && asyncFrames.length < 50; st = st.parent)
    asyncFrames.push({
      description: st.description,
      callFrames: (st.callFrames ?? []).map((c: any) => ({ functionName: c.functionName || '(anonym)', url: c.url, line: c.lineNumber + 1, column: c.columnNumber + 1 })),
    });
  result.files['debugger/paused-state.json'] = JSON.stringify(
    {
      paused: true,
      reason: paused.reason,
      data: paused.data,
      hitBreakpoints: paused.hitBreakpoints,
      callStack: frames,
      asyncStackTrace: asyncFrames,
    },
    null,
    2,
  );
  result.warnings.push(`Seite war pausiert (${paused.reason}) – Call Stack mit ${frames.length} Frame(s) exportiert.`);
  return result;
};
