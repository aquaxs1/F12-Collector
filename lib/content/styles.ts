// Styles in the content script: stylesheets (fallback without CDP) and computed styles.
import type { ComputedStyleEntry, ContentCollectOptions, FrameData, StylesheetInfo } from '../types';
import { cssPath, getShadowRoot } from './util';

function sheetText(sheet: CSSStyleSheet): { text?: string; blocked?: boolean } {
  try {
    return { text: Array.from(sheet.cssRules).map((r) => r.cssText).join('\n') };
  } catch {
    return { blocked: true }; // cross-origin without CORS
  }
}

function ownerOf(sheet: CSSStyleSheet, fallback: string) {
  const n = sheet.ownerNode;
  return n instanceof Element ? cssPath(n) : fallback;
}

/** All elements, including those in open and (where allowed) closed shadow roots. */
export function allElements(root: Document | ShadowRoot = document, out: Element[] = [], roots: ShadowRoot[] = []): Element[] {
  const walker = document.createTreeWalker(root, NodeFilter.SHOW_ELEMENT);
  let n = walker.nextNode();
  while (n) {
    const el = n as Element;
    out.push(el);
    const sr = getShadowRoot(el);
    if (sr) {
      roots.push(sr);
      allElements(sr, out, roots);
    }
    n = walker.nextNode();
  }
  return out;
}

export function collectStyleSheets(): StylesheetInfo[] {
  const out: StylesheetInfo[] = [];
  const add = (sheet: CSSStyleSheet, owner: string) => {
    const t = sheetText(sheet);
    out.push({
      index: out.length,
      href: sheet.href ?? undefined,
      text: t.text,
      crossOriginBlocked: t.blocked,
      owner: ownerOf(sheet, owner),
      media: sheet.media?.mediaText || undefined,
    });
  };
  for (const s of Array.from(document.styleSheets)) add(s, 'document');
  for (const s of (document as any).adoptedStyleSheets ?? []) add(s, 'document (adoptedStyleSheets)');
  const roots: ShadowRoot[] = [];
  allElements(document, [], roots);
  for (const r of roots) {
    const host = cssPath(r.host);
    for (const s of Array.from(r.styleSheets)) add(s, `${host} ::shadow-root`);
    for (const s of (r as any).adoptedStyleSheets ?? []) add(s, `${host} ::shadow-root (adoptedStyleSheets)`);
  }
  return out;
}

/** Default values per tag from an invisible, empty iframe. */
class Baseline {
  private frame?: HTMLIFrameElement;
  private cache = new Map<string, Record<string, string>>();
  ok = false;
  constructor() {
    try {
      const f = document.createElement('iframe');
      f.setAttribute('aria-hidden', 'true');
      f.style.cssText = 'position:absolute;left:-10000px;top:0;width:10px;height:10px;visibility:hidden;border:0';
      (document.body ?? document.documentElement).appendChild(f);
      if (f.contentDocument) {
        this.frame = f;
        this.ok = true;
      } else f.remove();
    } catch {
      this.ok = false;
    }
  }
  get(tag: string, ns: string | null): Record<string, string> | undefined {
    if (!this.frame?.contentDocument) return undefined;
    const key = `${ns}|${tag}`;
    let v = this.cache.get(key);
    if (!v) {
      const doc = this.frame.contentDocument;
      const el = ns ? doc.createElementNS(ns, tag) : doc.createElement(tag);
      (doc.body ?? doc.documentElement).appendChild(el);
      const cs = this.frame.contentWindow!.getComputedStyle(el);
      v = {};
      for (let i = 0; i < cs.length; i++) {
        const p = cs.item(i);
        v[p] = cs.getPropertyValue(p);
      }
      el.remove();
      this.cache.set(key, v);
    }
    return v;
  }
  dispose() {
    this.frame?.remove();
  }
}

export function collectComputed(opts: ContentCollectOptions): { entries: ComputedStyleEntry[]; total: number } {
  if (opts.computedStylesMode === 'none') return { entries: [], total: 0 };
  const els = allElements();
  const vw = window.innerWidth;
  const vh = window.innerHeight;
  const candidates: { el: Element; rect: DOMRect; cs: CSSStyleDeclaration }[] = [];
  for (const el of els) {
    const rect = el.getBoundingClientRect();
    const cs = getComputedStyle(el);
    if (opts.computedStylesMode === 'visible') {
      if (rect.width <= 0 || rect.height <= 0) continue;
      if (rect.bottom < 0 || rect.right < 0 || rect.top > vh || rect.left > vw) continue;
      if (cs.visibility === 'hidden' || cs.display === 'none' || cs.opacity === '0') continue;
    }
    candidates.push({ el, rect, cs });
  }
  const base = opts.computedStylesDiffOnly ? new Baseline() : undefined;
  const entries: ComputedStyleEntry[] = [];
  try {
    for (const { el, rect, cs } of candidates.slice(0, opts.computedStylesLimit)) {
      const b = base?.ok ? base.get(el.localName, el.namespaceURI === 'http://www.w3.org/1999/xhtml' ? null : el.namespaceURI) : undefined;
      const styles: Record<string, string> = {};
      for (let i = 0; i < cs.length; i++) {
        const p = cs.item(i);
        const v = cs.getPropertyValue(p);
        if (b && b[p] === v) continue;
        styles[p] = v;
      }
      entries.push({
        selector: cssPath(el),
        tag: el.localName,
        rect: { x: Math.round(rect.x), y: Math.round(rect.y), width: Math.round(rect.width), height: Math.round(rect.height) },
        styles,
      });
    }
  } finally {
    base?.dispose();
  }
  return { entries, total: candidates.length };
}

export async function collectStyles(opts: ContentCollectOptions): Promise<NonNullable<FrameData['styles']>> {
  const computed = collectComputed(opts);
  return {
    sheets: opts.styleSheets ? collectStyleSheets() : [],
    computed: computed.entries,
    computedTotalCandidates: computed.total,
  };
}
