// Orchestrates an export: attach the debugger, (optionally) record & reload,
// run the content script in all frames, run each collector in isolation, build the ZIP, start the download.
import { browser } from 'wxt/browser';
import { collectors } from '@/collectors';
import { CdpSession } from '@/collectors/chrome/cdp';
import { BROWSER_NAME, IS_FIREFOX, getAreas } from './areas';
import type { JobContext } from './context';
import { buildZip, downloadZip } from './export';
import { errMsg, formatBytes, withTimeout } from './fetcher';
import { collectFromFrames } from './frames';
import { startRecording, type NetworkRecording } from './recording';
import { hostOf, sanitizeSegment, timestampForFile } from './paths';
import type { Area, FileContent, JobState, ProgressStep, StartJobMessage, StepStatus } from './types';

/** Only these areas are subject to the per-file size limit (the network collector checks HAR bodies itself). */
const LIMITED_PREFIXES = ['sources/', 'styles/stylesheets/', 'storage/cache/', 'dom/frames/'];
const COLLECTOR_TIMEOUT_MS = 5 * 60 * 1000;

export type StateListener = (state: JobState) => void;

export async function runJob(msg: StartJobMessage, publish: StateListener): Promise<void> {
  const { tabId, mode, settings } = msg;
  const started = new Date();
  const areaInfos = getAreas();
  const selected = areaInfos.filter((a) => settings.areas[a.id] && a.support !== 'unavailable').map((a) => a.id);

  const steps: ProgressStep[] = [
    { id: 'prepare', label: 'Preparation', status: 'pending' },
    ...(mode === 'record' ? [{ id: 'record', label: 'Record & reload', status: 'pending' as StepStatus }] : []),
    { id: 'frames', label: 'Read page (all frames)', status: 'pending' },
    ...areaInfos.map((a) => ({
      id: a.id,
      label: a.label,
      status: (selected.includes(a.id) ? 'pending' : 'skipped') as StepStatus,
      detail: a.support === 'unavailable' ? a.note : undefined,
    })),
    { id: 'zip', label: 'Create & download ZIP', status: 'pending' },
  ];
  const state: JobState = { running: true, tabId, mode, steps, message: 'Export running …' };
  const emit = () => publish(structuredClone(state));
  const setStep = (id: string, status: StepStatus, detail?: string) => {
    const s = steps.find((x) => x.id === id);
    if (s) {
      s.status = status;
      if (detail !== undefined) s.detail = detail;
    }
    emit();
  };
  let current = 'prepare';
  const detail = (text: string) => {
    const s = steps.find((x) => x.id === current);
    if (s && s.detail !== text) {
      s.detail = text;
      emit();
    }
  };

  const warnings: string[] = [];
  const areaReport: Record<string, { selected: boolean; status: string; files: number; warnings: string[]; durationMs?: number; note?: string }> = {};
  const files = new Map<string, FileContent>();
  let cdp: CdpSession | null = null;
  let recording: NetworkRecording | null = null;
  // Keep the service worker (Chrome) / event page (Firefox) alive during long exports
  const keepAlive = setInterval(() => browser.runtime.getPlatformInfo().catch(() => {}), 20000);

  try {
    // ---------- Preparation ----------
    setStep('prepare', 'running');
    const tab = await browser.tabs.get(tabId);
    const url = tab.url ?? '';
    state.url = url;
    if (!/^(https?|file):/i.test(url))
      throw new Error(`This page cannot be exported (${url || 'unknown URL'}). Internal browser pages are off-limits for extensions.`);

    const ctx: JobContext = {
      tabId,
      url,
      title: tab.title ?? '',
      mode,
      settings,
      startedAt: started,
      frames: [],
      cdp: null,
      cookieStoreId: (tab as any).cookieStoreId,
      devtools: msg.devtools,
      shared: {},
      maxBytes: Math.round(settings.maxFileSizeMB * 1024 * 1024),
      skipped: [],
      detail,
    };

    if (!IS_FIREFOX && (mode === 'record' || selected.some((a) => a !== 'storage'))) {
      detail('Attaching debugger');
      cdp = new CdpSession(tabId);
      try {
        await cdp.attach();
        ctx.cdp = cdp;
      } catch (e) {
        cdp = null;
        warnings.push(`Could not attach the Chrome debugger (${errMsg(e)}). Using the content script fallbacks instead.`);
      }
    }
    setStep('prepare', 'done', ctx.cdp ? 'debugger attached' : IS_FIREFOX ? 'Firefox mode' : 'without debugger');

    // ---------- Record & reload ----------
    if (mode === 'record') {
      current = 'record';
      setStep('record', 'running', 'enabling listeners');
      recording = await startRecording(ctx);
      detail('reloading page');
      const info = await recording.reloadAndWait((t) => detail(t));
      ctx.url = (await browser.tabs.get(tabId)).url ?? ctx.url;
      state.url = ctx.url;
      setStep('record', info.timedOut ? 'warning' : 'done', info.summary);
      if (info.timedOut) warnings.push(`Recording: ${info.summary}`);
    }

    // ---------- Chrome: debugger state (paused?) + script list ----------
    if (ctx.cdp) {
      const parsed: any[] = ctx.shared.parsedScripts ?? [];
      const offParsed = ctx.cdp.on('Debugger.scriptParsed', (p) => parsed.push(p));
      const offPaused = ctx.cdp.on('Debugger.paused', (p) => (ctx.shared.pausedEvent = p));
      const offResumed = ctx.cdp.on('Debugger.resumed', () => (ctx.shared.pausedEvent = undefined));
      try {
        await ctx.cdp.send('Debugger.enable', { maxScriptsCacheSize: 100_000_000 });
        await new Promise((r) => setTimeout(r, 400));
        ctx.shared.parsedScripts = parsed;
        // Our own session must never pause the page (e.g. through "debugger;" statements)
        if (!ctx.shared.pausedEvent) await ctx.cdp.send('Debugger.setSkipAllPauses', { skip: true }).catch(() => {});
      } catch (e) {
        warnings.push(`Debugger.enable failed: ${errMsg(e)}`);
      } finally {
        offParsed();
        offPaused();
        offResumed();
      }
    }

    // ---------- Content script in all frames ----------
    current = 'frames';
    setStep('frames', 'running');
    if (ctx.shared.pausedEvent) {
      setStep('frames', 'warning', 'skipped – page is paused in the debugger');
      warnings.push('The page is paused in the debugger: content scripts cannot run, so localStorage/IndexedDB/computed styles and frame contents are missing.');
    } else {
      try {
        const res = await collectFromFrames(tabId, contentOptions(ctx, selected), 60000);
        ctx.frames = res.frames;
        warnings.push(...res.warnings);
        setStep('frames', res.frames.length ? 'done' : 'warning', `${res.frames.length} frame(s)`);
      } catch (e) {
        warnings.push(`Content Script: ${errMsg(e)}`);
        setStep('frames', 'error', errMsg(e));
      }
    }

    // ---------- Collectors (each isolated) ----------
    for (const info of areaInfos) {
      const area = info.id;
      if (info.support === 'unavailable') {
        areaReport[area] = { selected: !!settings.areas[area], status: 'unavailable', files: 0, warnings: [], note: info.note };
        continue;
      }
      if (!selected.includes(area)) {
        areaReport[area] = { selected: false, status: 'skipped', files: 0, warnings: [] };
        continue;
      }
      current = area;
      setStep(area, 'running');
      const t0 = Date.now();
      const collector = collectors[area];
      const report = (areaReport[area] = { selected: true, status: 'ok', files: 0, warnings: [] as string[], durationMs: 0, note: info.note });
      try {
        if (!collector) throw new Error('Not implemented in this browser');
        const res = await withTimeout(
          area === 'network' ? collector({ ...ctx, recordedHar: recording ? () => recording!.toHar(ctx) : undefined }) : collector(ctx),
          COLLECTOR_TIMEOUT_MS,
          info.label,
        );
        for (const [path, content] of Object.entries(res.files)) {
          if (LIMITED_PREFIXES.some((p) => path.startsWith(p)) && !path.endsWith('.json')) {
            const size = typeof content === 'string' ? content.length : content.byteLength;
            if (size > ctx.maxBytes) {
              ctx.skipped.push({ path, reason: `larger than limit (${formatBytes(size)})`, size });
              continue;
            }
          }
          files.set(path, content);
          report.files++;
        }
        report.warnings = res.warnings;
        report.status = res.warnings.length ? 'warning' : 'ok';
        setStep(area, res.warnings.length ? 'warning' : 'done', `${report.files} file(s)${res.warnings.length ? `, ${res.warnings.length} note(s)` : ''}`);
      } catch (e) {
        report.status = 'error';
        report.warnings.push(`Error: ${errMsg(e)}`);
        setStep(area, 'error', errMsg(e));
      }
      report.durationMs = Date.now() - t0;
      warnings.push(...report.warnings.map((w) => `[${info.label}] ${w}`));
    }

    // Always detach the debugger before building the ZIP
    await recording?.stop();
    recording = null;
    await cdp?.detach();
    cdp = null;

    // ---------- manifest.json + ZIP ----------
    current = 'zip';
    setStep('zip', 'running', 'manifest.json');
    const rootName = `f12-collector_${sanitizeSegment(hostOf(ctx.url))}_${timestampForFile(started)}`;
    const missing = areaInfos
      .filter((a) => a.support !== 'full' || areaReport[a.id]?.status === 'error')
      .map((a) => ({
        area: a.id,
        label: a.label,
        reason:
          a.support === 'unavailable'
            ? a.note
            : areaReport[a.id]?.status === 'error'
              ? areaReport[a.id]!.warnings.join('; ')
              : `limited: ${a.note}`,
      }));
    const manifest = {
      tool: 'F12 Collector',
      extensionVersion: browser.runtime.getManifest().version,
      browser: BROWSER_NAME,
      userAgent: navigator.userAgent,
      url: ctx.url,
      title: ctx.title,
      createdAt: started.toISOString(),
      durationMs: Date.now() - started.getTime(),
      mode: mode === 'record' ? 'Record & reload' : 'Snapshot',
      startedFrom: msg.source,
      activeAreas: selected,
      areas: areaReport,
      missing,
      redaction: settings.redact
        ? { enabled: true, note: 'Cookie values, Authorization/Cookie/Set-Cookie headers and token-like values were replaced with [REDACTED].' }
        : { enabled: false, note: 'WARNING: this export contains unredacted cookies, tokens and auth headers.' },
      settings,
      frames: ctx.frames.map((f) => ({ frameId: f.frameId, url: f.url, errors: f.errors })),
      warnings,
      skippedFiles: ctx.skipped,
      fileCount: files.size + 1,
      totalSize: formatBytes(Array.from(files.values()).reduce((n, c) => n + (typeof c === 'string' ? c.length : c.byteLength), 0)),
      privacy: 'All data was collected locally. F12 Collector uploads nothing and sends no telemetry.',
    };
    files.set('manifest.json', JSON.stringify(manifest, null, 2));
    detail('compressing …');
    const zipBytes = await buildZip(rootName, files, (pct) => detail(`compressing … ${Math.round(pct)} %`));
    detail(`starting download (${formatBytes(zipBytes.byteLength)})`);
    await downloadZip(zipBytes, `${rootName}.zip`);
    setStep('zip', 'done', `${rootName}.zip (${formatBytes(zipBytes.byteLength)})`);

    state.running = false;
    state.finishedAt = new Date().toISOString();
    state.fileName = `${rootName}.zip`;
    state.warningsCount = warnings.length;
    state.warnings = warnings.slice(0, 100);
    state.skippedCount = ctx.skipped.length;
    state.missing = missing.map((m) => ({ label: m.label, reason: m.reason }));
    state.message = warnings.length ? `Done – with ${warnings.length} note(s), see manifest.json` : 'Done!';
    emit();
  } catch (e) {
    const s = steps.find((x) => x.id === current);
    if (s) s.status = 'error';
    state.running = false;
    state.error = errMsg(e);
    state.message = 'Export failed';
    emit();
  } finally {
    clearInterval(keepAlive);
    await recording?.stop().catch(() => {});
    await cdp?.detach();
  }
}

function contentOptions(ctx: JobContext, selected: Area[]) {
  const has = (a: Area) => selected.includes(a);
  return {
    dom: has('dom'),
    resources: has('sources') || has('debugger') || has('network'),
    storage: has('storage'),
    styles: has('styles'),
    styleSheets: has('styles') && !ctx.cdp,
    a11y: has('accessibility') && !ctx.cdp,
    computedStylesMode: ctx.settings.computedStylesMode,
    computedStylesLimit: ctx.settings.computedStylesLimit,
    computedStylesDiffOnly: ctx.settings.computedStylesDiffOnly,
    indexedDbMaxRecords: ctx.settings.indexedDbMaxRecords,
    maxBodyBytes: ctx.maxBytes,
  };
}
