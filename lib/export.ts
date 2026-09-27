// ZIP bauen und lokal herunterladen – keine Daten verlassen den Rechner.
import JSZip from 'jszip';
import { browser } from 'wxt/browser';
import { IS_FIREFOX } from './areas';
import { bytesToBase64 } from './fetcher';
import type { FileContent } from './types';

/** Bereits komprimierte Formate nicht erneut komprimieren. */
const STORE_EXT = /\.(png|jpe?g|gif|webp|avif|ico|woff2?|ttf|otf|mp[34]|webm|ogg|zip|gz|br|pdf)$/i;

export async function buildZip(rootName: string, files: Map<string, FileContent>, onProgress: (pct: number) => void): Promise<Uint8Array> {
  const zip = new JSZip();
  const folder = zip.folder(rootName)!;
  for (const [path, content] of files) {
    folder.file(path, content, {
      binary: typeof content !== 'string',
      compression: STORE_EXT.test(path) ? 'STORE' : 'DEFLATE',
      compressionOptions: { level: 6 },
    });
  }
  return zip.generateAsync({ type: 'uint8array', streamFiles: true }, (m) => onProgress(m.percent));
}

// ---------- Chrome: Blob-URL über ein Offscreen-Dokument (Service Worker hat kein URL.createObjectURL) ----------

const OFFSCREEN_URL = '/offscreen.html';
const CHUNK = 8 * 1024 * 1024; // 8 MB Rohdaten je Nachricht (≈ 11 MB Base64)

async function ensureOffscreen() {
  const chromeAny = (globalThis as any).chrome;
  const contexts = await chromeAny.runtime.getContexts?.({ contextTypes: ['OFFSCREEN_DOCUMENT'] });
  if (contexts?.length) return;
  await chromeAny.offscreen.createDocument({
    url: OFFSCREEN_URL,
    reasons: ['BLOBS'],
    justification: 'ZIP-Export als Blob-URL für downloads.download bereitstellen',
  });
}

async function blobUrlViaOffscreen(bytes: Uint8Array): Promise<string> {
  await ensureOffscreen();
  const id = crypto.randomUUID();
  for (let off = 0; off < bytes.byteLength; off += CHUNK) {
    const data = bytesToBase64(bytes.subarray(off, Math.min(off + CHUNK, bytes.byteLength)));
    await browser.runtime.sendMessage({ target: 'offscreen', type: 'chunk', id, data });
  }
  const res = (await browser.runtime.sendMessage({ target: 'offscreen', type: 'finish', id, mime: 'application/zip' })) as { url?: string; error?: string };
  if (!res?.url) throw new Error(res?.error ?? 'Offscreen-Dokument hat keine URL geliefert');
  return res.url;
}

function revokeLater(downloadId: number, revoke: () => void) {
  const listener = (delta: any) => {
    if (delta.id !== downloadId || !delta.state) return;
    if (delta.state.current === 'complete' || delta.state.current === 'interrupted') {
      browser.downloads.onChanged.removeListener(listener);
      setTimeout(revoke, 1000);
    }
  };
  browser.downloads.onChanged.addListener(listener);
  setTimeout(() => {
    browser.downloads.onChanged.removeListener(listener);
    revoke();
  }, 10 * 60 * 1000);
}

export async function downloadZip(bytes: Uint8Array, fileName: string): Promise<number> {
  let url: string;
  let revoke = () => {};
  if (IS_FIREFOX) {
    url = URL.createObjectURL(new Blob([bytes as BlobPart], { type: 'application/zip' }));
    revoke = () => URL.revokeObjectURL(url);
  } else {
    try {
      url = await blobUrlViaOffscreen(bytes);
      revoke = () => {
        browser.runtime.sendMessage({ target: 'offscreen', type: 'revoke', url }).catch(() => {});
      };
    } catch (e) {
      console.warn('[F12 Collector] Offscreen fehlgeschlagen, nutze data:-URL', e);
      url = 'data:application/zip;base64,' + bytesToBase64(bytes);
    }
  }
  const id = await browser.downloads.download({ url, filename: fileName, saveAs: false, conflictAction: 'uniquify' });
  revokeLater(id, revoke);
  return id;
}
