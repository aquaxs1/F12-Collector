// DOM-Serialisierung im Content Script (inkl. Shadow DOM als <template shadowrootmode>).
import type { ShadowRootInfo } from '../types';
import { cssPath, getShadowRoot } from './util';

const VOID = new Set(['area', 'base', 'br', 'col', 'embed', 'hr', 'img', 'input', 'link', 'meta', 'param', 'source', 'track', 'wbr']);
const RAW_TEXT = new Set(['script', 'style', 'xmp', 'iframe', 'noembed', 'noframes', 'plaintext']);
const MAX_NODES = 1_000_000;

export function escapeText(s: string) {
  return s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/ /g, '&nbsp;');
}
export function escapeAttr(s: string) {
  return s.replace(/&/g, '&amp;').replace(/"/g, '&quot;').replace(/ /g, '&nbsp;');
}

export function serializeDocument(doc: Document): { html: string; shadowRoots: ShadowRootInfo[]; nodeCount: number } {
  const shadowRoots: ShadowRootInfo[] = [];
  let count = 0;
  const out: string[] = [];

  const walk = (node: Node, parentTag: string | null) => {
    if (++count > MAX_NODES) return;
    switch (node.nodeType) {
      case Node.DOCUMENT_TYPE_NODE: {
        const dt = node as DocumentType;
        out.push(`<!DOCTYPE ${dt.name}${dt.publicId ? ` PUBLIC "${dt.publicId}"` : ''}${dt.systemId ? ` "${dt.systemId}"` : ''}>\n`);
        return;
      }
      case Node.TEXT_NODE:
        out.push(parentTag && RAW_TEXT.has(parentTag) ? (node as Text).data : escapeText((node as Text).data));
        return;
      case Node.CDATA_SECTION_NODE:
        out.push(`<![CDATA[${(node as CDATASection).data}]]>`);
        return;
      case Node.COMMENT_NODE:
        out.push(`<!--${(node as Comment).data}-->`);
        return;
      case Node.PROCESSING_INSTRUCTION_NODE:
        out.push(`<?${(node as ProcessingInstruction).target} ${(node as ProcessingInstruction).data}?>`);
        return;
      case Node.DOCUMENT_NODE:
      case Node.DOCUMENT_FRAGMENT_NODE:
        for (const c of Array.from(node.childNodes)) walk(c, null);
        return;
      case Node.ELEMENT_NODE: {
        const el = node as Element;
        const tag = el.localName;
        const name = el.namespaceURI === 'http://www.w3.org/1999/xhtml' ? tag : el.tagName;
        out.push(`<${name}`);
        for (const a of Array.from(el.attributes)) out.push(` ${a.name}="${escapeAttr(a.value)}"`);
        out.push('>');
        if (VOID.has(tag) && el.namespaceURI === 'http://www.w3.org/1999/xhtml') return;
        const sr = getShadowRoot(el);
        if (sr) {
          const start = out.length;
          out.push(`<template shadowrootmode="${sr.mode}">`);
          for (const c of Array.from(sr.childNodes)) walk(c, null);
          out.push('</template>');
          shadowRoots.push({ host: cssPath(el), mode: sr.mode, html: out.slice(start + 1, out.length - 1).join('') });
        }
        const children = tag === 'template' && (el as HTMLTemplateElement).content ? (el as HTMLTemplateElement).content.childNodes : el.childNodes;
        for (const c of Array.from(children)) walk(c, tag);
        out.push(`</${name}>`);
        return;
      }
    }
  };

  walk(doc, null);
  return { html: out.join(''), shadowRoots, nodeCount: count };
}
