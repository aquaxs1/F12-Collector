// DOM (Chrome): DOM.getDocument(depth -1, pierce true) → HTML incl. shadow DOM and iframes.
import { collectDomFallback, writeFrames } from '@/collectors/firefox/dom';
import type { Collector } from '@/lib/context';
import { escapeAttr, escapeText } from '@/lib/content/dom';
import { hostOf } from '@/lib/paths';
import type { CollectorResult } from '@/lib/types';

const VOID = new Set(['area', 'base', 'br', 'col', 'embed', 'hr', 'img', 'input', 'link', 'meta', 'param', 'source', 'track', 'wbr']);
const RAW_TEXT = new Set(['script', 'style', 'xmp', 'iframe', 'noembed', 'noframes', 'plaintext']);

interface CdpNode {
  nodeId: number;
  nodeType: number;
  nodeName: string;
  localName?: string;
  nodeValue?: string;
  attributes?: string[];
  children?: CdpNode[];
  shadowRoots?: CdpNode[];
  shadowRootType?: string;
  contentDocument?: CdpNode;
  templateContent?: CdpNode;
  documentURL?: string;
  publicId?: string;
  systemId?: string;
  frameId?: string;
}

interface ShadowOut {
  host: string;
  mode: string;
  html: string;
  frame: string;
}

function describe(node: CdpNode): string {
  const attrs = node.attributes ?? [];
  const get = (n: string) => {
    for (let i = 0; i < attrs.length; i += 2) if (attrs[i] === n) return attrs[i + 1];
  };
  const id = get('id');
  const cls = get('class')?.trim().split(/\s+/).slice(0, 2).join('.');
  return `${node.localName || node.nodeName.toLowerCase()}${id ? '#' + id : ''}${cls ? '.' + cls : ''}`;
}

class Serializer {
  frames: { url: string; file: string; html: string }[] = [];
  shadowRoots: ShadowOut[] = [];
  nodeCount = 0;

  serialize(doc: CdpNode, frameName: string): string {
    const out: string[] = [];
    this.walk(doc, out, null, [], frameName);
    return out.join('');
  }

  private walk(node: CdpNode, out: string[], parentTag: string | null, path: string[], frameName: string) {
    this.nodeCount++;
    switch (node.nodeType) {
      case 10:
        out.push(`<!DOCTYPE ${node.nodeName}${node.publicId ? ` PUBLIC "${node.publicId}"` : ''}${node.systemId ? ` "${node.systemId}"` : ''}>\n`);
        return;
      case 3:
        out.push(parentTag && RAW_TEXT.has(parentTag) ? node.nodeValue ?? '' : escapeText(node.nodeValue ?? ''));
        return;
      case 4:
        out.push(`<![CDATA[${node.nodeValue ?? ''}]]>`);
        return;
      case 8:
        out.push(`<!--${node.nodeValue ?? ''}-->`);
        return;
      case 7:
        out.push(`<?${node.nodeName} ${node.nodeValue ?? ''}?>`);
        return;
      case 9:
      case 11:
        for (const c of node.children ?? []) this.walk(c, out, null, path, frameName);
        return;
      case 1: {
        const tag = node.localName || node.nodeName.toLowerCase();
        const attrs = node.attributes ?? [];
        out.push(`<${tag}`);
        for (let i = 0; i < attrs.length; i += 2) out.push(` ${attrs[i]}="${escapeAttr(attrs[i + 1] ?? '')}"`);
        const here = [...path, describe(node)];
        // iframe content as a separate file
        if (node.contentDocument) {
          const url = node.contentDocument.documentURL ?? 'about:blank';
          const file = `frames/cdp-${this.frames.length + 1}_${hostOf(url).replace(/[^\w.-]/g, '_')}.html`;
          out.push(` data-f12c-frame="${file}"`);
          const entry = { url, file, html: '' };
          this.frames.push(entry);
          entry.html = this.serialize(node.contentDocument, file);
        }
        out.push('>');
        if (VOID.has(tag)) return;
        for (const sr of node.shadowRoots ?? []) {
          if (sr.shadowRootType === 'user-agent') continue; // browser-internal shadow roots (input, video …)
          const start = out.length;
          out.push(`<template shadowrootmode="${sr.shadowRootType ?? 'open'}">`);
          for (const c of sr.children ?? []) this.walk(c, out, null, [...here, '::shadow-root'], frameName);
          out.push('</template>');
          this.shadowRoots.push({ host: here.slice(-6).join(' > '), mode: sr.shadowRootType ?? 'open', html: out.slice(start + 1, out.length - 1).join(''), frame: frameName });
        }
        const children = tag === 'template' && node.templateContent ? node.templateContent.children ?? [] : node.children ?? [];
        for (const c of children) this.walk(c, out, tag, here, frameName);
        out.push(`</${tag}>`);
        return;
      }
    }
  }
}

export const collectDomChrome: Collector = async (ctx) => {
  if (!ctx.cdp) {
    const r = await collectDomFallback(ctx);
    r.warnings.unshift('Chrome debugger not attached – DOM from the content script (closed shadow roots may be incomplete).');
    return r;
  }
  const result: CollectorResult = { files: {}, warnings: [] };
  await ctx.cdp.send('DOM.enable');
  const { root } = await ctx.cdp.send<{ root: CdpNode }>('DOM.getDocument', { depth: -1, pierce: true });
  const ser = new Serializer();
  result.files['dom/index.html'] = ser.serialize(root, 'index.html');
  for (const f of ser.frames) result.files[`dom/${f.file}`] = f.html;
  result.files['dom/shadow-roots.json'] = JSON.stringify(ser.shadowRoots, null, 2);
  // Frames not reachable via CDP (e.g. cross-origin/out-of-process) come from the content script
  const cdpUrls = new Set(ser.frames.map((f) => f.url));
  writeFrames(ctx.frames, result, cdpUrls);
  const indexFrames = ser.frames.map((f) => ({ url: f.url, file: f.file, source: 'cdp' }));
  if (result.files['dom/frames/index.json']) {
    const extra = JSON.parse(result.files['dom/frames/index.json'] as string).map((e: any) => ({ ...e, source: 'content-script' }));
    indexFrames.push(...extra);
  }
  if (indexFrames.length) result.files['dom/frames/index.json'] = JSON.stringify(indexFrames, null, 2);
  ctx.detail(`${ser.nodeCount} nodes`);
  return result;
};
