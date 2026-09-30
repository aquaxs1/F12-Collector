// Application: service workers (registrations + script code), web app manifest, storage quota.
// Registrations, controller and storage estimate come from the page (content script); the
// background fetches the manifest JSON and SW scripts (cache-first).
import type { Collector } from '@/lib/context';
import { json } from '@/lib/context';
import { decodeUtf8, fetchResource, formatBytes, mapLimit } from '@/lib/fetcher';
import { PathAllocator, hostOf, isHttpUrl, urlToPath } from '@/lib/paths';

export const collectApplication: Collector = async (ctx) => {
  const result = { files: {} as Record<string, string>, warnings: [] as string[] };
  const alloc = new PathAllocator();

  // Merge per-origin application data from frames
  const byOrigin = new Map<string, { origin: string; url: string; app: NonNullable<(typeof ctx.frames)[number]['application']> }>();
  for (const f of ctx.frames) {
    if (!f.application) continue;
    if (!byOrigin.has(f.origin)) byOrigin.set(f.origin, { origin: f.origin, url: f.url, app: f.application });
  }
  if (!byOrigin.size) result.warnings.push('No application data from the content script (page may not have loaded with the extension installed).');

  // Storage quota per origin
  const quota = Array.from(byOrigin.values()).map((o) => ({
    origin: o.origin,
    estimate: o.app.storageEstimate,
    readable: o.app.storageEstimate
      ? { usage: formatBytes(o.app.storageEstimate.usage ?? 0), quota: formatBytes(o.app.storageEstimate.quota ?? 0) }
      : undefined,
    error: o.app.storageError,
  }));
  result.files['application/storage-quota.json'] = json(quota);

  // Web app manifest(s)
  const manifests: any[] = [];
  const manifestHrefs = Array.from(new Set(Array.from(byOrigin.values()).map((o) => o.app.manifestHref).filter(isHttpUrl)));
  await mapLimit(manifestHrefs, 4, async (href) => {
    const res = await fetchResource(href, ctx.maxBytes);
    if (res.ok && res.bytes) {
      const text = decodeUtf8(res.bytes);
      const path = alloc.allocate(urlToPath(href, 'application/manifest', '.webmanifest'));
      result.files[path] = text;
      let parsed: any;
      try {
        parsed = JSON.parse(text);
      } catch {
        /* keep raw */
      }
      manifests.push({ href, file: path.replace(/^application\//, ''), name: parsed?.name, short_name: parsed?.short_name, start_url: parsed?.start_url, display: parsed?.display, theme_color: parsed?.theme_color, icons: parsed?.icons?.length });
    } else {
      manifests.push({ href, error: res.error ?? res.skippedReason ?? `HTTP ${res.status}` });
    }
  });
  if (manifestHrefs.length) result.files['application/manifest.json'] = json(manifests);

  // Service worker registrations + script code
  const swIndex: any[] = [];
  const scripts = new Set<string>();
  for (const o of byOrigin.values()) {
    const app = o.app;
    swIndex.push({ origin: o.origin, controller: app.controllerScriptURL, registrations: app.serviceWorkers, error: app.serviceWorkerError });
    for (const r of app.serviceWorkers ?? []) for (const s of [r.active, r.waiting, r.installing]) if (s && isHttpUrl(s.scriptURL)) scripts.add(s.scriptURL);
    if (isHttpUrl(app.controllerScriptURL)) scripts.add(app.controllerScriptURL!);
  }

  // Chrome CDP: richer registration/version info (best-effort)
  if (ctx.cdp) {
    try {
      const versions: any[] = [];
      const regs: any[] = [];
      const offV = ctx.cdp.on('ServiceWorker.workerVersionUpdated', (p: any) => versions.push(...(p.versions ?? [])));
      const offR = ctx.cdp.on('ServiceWorker.workerRegistrationUpdated', (p: any) => regs.push(...(p.registrations ?? [])));
      await ctx.cdp.send('ServiceWorker.enable');
      await new Promise((r) => setTimeout(r, 400));
      offV();
      offR();
      await ctx.cdp.send('ServiceWorker.disable').catch(() => {});
      if (regs.length || versions.length) result.files['application/service-workers-cdp.json'] = json({ registrations: regs, versions });
      for (const v of versions) if (isHttpUrl(v.scriptURL)) scripts.add(v.scriptURL);
    } catch (e) {
      result.warnings.push(`CDP ServiceWorker info: ${String((e as Error).message ?? e)}`);
    }
  }

  let done = 0;
  const scriptList = Array.from(scripts);
  await mapLimit(scriptList, 4, async (url) => {
    ctx.detail(`SW scripts ${++done}/${scriptList.length}`);
    const res = await fetchResource(url, ctx.maxBytes);
    if (res.ok && res.bytes) {
      const path = alloc.allocate(urlToPath(url, `application/service-workers/${hostOf(url).replace(/[^\w.-]/g, '_')}`, '.js'));
      result.files[path] = decodeUtf8(res.bytes);
      const e = swIndex.find((x) => x.origin && url.startsWith(new URL(x.origin).origin));
      if (e) (e.savedScripts ??= []).push({ url, file: path.replace(/^application\//, '') });
    }
  });
  result.files['application/service-workers.json'] = json(swIndex);

  if (!scriptList.length && !manifestHrefs.length) result.warnings.push('No service workers or web app manifest found.');
  return result;
};
