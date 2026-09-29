// Offscreen document (Chrome only): assembles ZIP chunks into a blob and returns a blob URL.
import { browser } from 'wxt/browser';

const parts = new Map<string, BlobPart[]>();

function b64ToBytes(b64: string): Uint8Array {
  const bin = atob(b64);
  const out = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) out[i] = bin.charCodeAt(i);
  return out;
}

browser.runtime.onMessage.addListener((msg: any, _sender, sendResponse) => {
  if (msg?.target !== 'offscreen') return;
  try {
    if (msg.type === 'chunk') {
      if (!parts.has(msg.id)) parts.set(msg.id, []);
      parts.get(msg.id)!.push(b64ToBytes(msg.data) as BlobPart);
      sendResponse({ ok: true });
    } else if (msg.type === 'finish') {
      const blob = new Blob(parts.get(msg.id) ?? [], { type: msg.mime });
      parts.delete(msg.id);
      sendResponse({ url: URL.createObjectURL(blob) });
    } else if (msg.type === 'revoke') {
      URL.revokeObjectURL(msg.url);
      sendResponse({ ok: true });
    }
  } catch (e) {
    sendResponse({ error: String(e) });
  }
  return true;
});
