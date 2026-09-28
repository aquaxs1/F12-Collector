// Barrierefreiheit (Annäherung ohne Browser-Accessibility-API):
// Rollen (explizit/implizit), ARIA-Attribute, Zustände und zugängliche Namen (vereinfachte AccName-Berechnung).
import type { A11yNode } from '../types';
import { getShadowRoot } from './util';

const MAX_NODES = 20000;

const NAME_FROM_CONTENT = new Set([
  'button', 'cell', 'checkbox', 'columnheader', 'gridcell', 'heading', 'link', 'menuitem', 'menuitemcheckbox',
  'menuitemradio', 'option', 'radio', 'row', 'rowheader', 'switch', 'tab', 'tooltip', 'treeitem', 'listitem', 'legend', 'caption',
]);

function hasAncestor(el: Element, sel: string) {
  return !!el.parentElement?.closest(sel);
}

export function implicitRole(el: Element): string | undefined {
  const tag = el.localName;
  switch (tag) {
    case 'a':
    case 'area':
      return el.hasAttribute('href') ? 'link' : undefined;
    case 'article': return 'article';
    case 'aside': return 'complementary';
    case 'button': return 'button';
    case 'datalist': return 'listbox';
    case 'details': return 'group';
    case 'dialog': return 'dialog';
    case 'fieldset': return 'group';
    case 'figure': return 'figure';
    case 'footer': return hasAncestor(el, 'article,aside,main,nav,section') ? undefined : 'contentinfo';
    case 'form': return 'form';
    case 'h1': case 'h2': case 'h3': case 'h4': case 'h5': case 'h6': return 'heading';
    case 'header': return hasAncestor(el, 'article,aside,main,nav,section') ? undefined : 'banner';
    case 'hr': return 'separator';
    case 'img': return el.getAttribute('alt') === '' ? 'presentation' : 'img';
    case 'svg': return 'graphics-document';
    case 'input': {
      const t = (el.getAttribute('type') ?? 'text').toLowerCase();
      if (['button', 'submit', 'reset', 'image'].includes(t)) return 'button';
      if (t === 'checkbox') return 'checkbox';
      if (t === 'radio') return 'radio';
      if (t === 'range') return 'slider';
      if (t === 'number') return 'spinbutton';
      if (t === 'search') return el.hasAttribute('list') ? 'combobox' : 'searchbox';
      if (t === 'hidden') return undefined;
      return el.hasAttribute('list') ? 'combobox' : 'textbox';
    }
    case 'li': return 'listitem';
    case 'main': return 'main';
    case 'math': return 'math';
    case 'menu': case 'ol': case 'ul': return 'list';
    case 'meter': return 'meter';
    case 'nav': return 'navigation';
    case 'optgroup': return 'group';
    case 'option': return 'option';
    case 'output': return 'status';
    case 'p': return 'paragraph';
    case 'progress': return 'progressbar';
    case 'section': return el.hasAttribute('aria-label') || el.hasAttribute('aria-labelledby') ? 'region' : undefined;
    case 'select': return el.hasAttribute('multiple') || Number(el.getAttribute('size')) > 1 ? 'listbox' : 'combobox';
    case 'summary': return 'button';
    case 'table': return 'table';
    case 'tbody': case 'thead': case 'tfoot': return 'rowgroup';
    case 'td': return 'cell';
    case 'textarea': return 'textbox';
    case 'th': return el.getAttribute('scope') === 'row' ? 'rowheader' : 'columnheader';
    case 'tr': return 'row';
    case 'dl': return 'list';
    case 'dt': return 'term';
    case 'dd': return 'definition';
    case 'blockquote': return 'blockquote';
    case 'code': return 'code';
    case 'caption': return 'caption';
    case 'legend': return 'legend';
    case 'label': return 'label';
    case 'iframe': return 'iframe';
    case 'video': case 'audio': return 'media';
    case 'body': return 'document';
  }
  return undefined;
}

function norm(s: string | null | undefined, max = 300) {
  const t = (s ?? '').replace(/\s+/g, ' ').trim();
  return t.length > max ? t.slice(0, max) + '…' : t;
}

function isHidden(el: Element): boolean {
  if (el.getAttribute('aria-hidden') === 'true') return true;
  if ((el as HTMLElement).hidden) return true;
  const cs = getComputedStyle(el);
  return cs.display === 'none' || cs.visibility === 'hidden';
}

function textOf(node: Node, depth = 0): string {
  if (depth > 20) return '';
  if (node.nodeType === Node.TEXT_NODE) return node.textContent ?? '';
  if (node.nodeType !== Node.ELEMENT_NODE) return '';
  const el = node as Element;
  if (isHidden(el)) return '';
  if (el.localName === 'img') return el.getAttribute('alt') ?? '';
  const label = el.getAttribute('aria-label');
  if (label) return label;
  let s = '';
  const root = getShadowRoot(el);
  for (const c of Array.from((root ?? el).childNodes)) s += ' ' + textOf(c, depth + 1);
  return s;
}

export function accessibleName(el: Element, role: string | undefined): string {
  const doc = el.ownerDocument;
  const labelledby = el.getAttribute('aria-labelledby');
  if (labelledby) {
    const t = labelledby
      .split(/\s+/)
      .map((id) => doc.getElementById(id))
      .filter(Boolean)
      .map((e) => textOf(e!))
      .join(' ');
    if (norm(t)) return norm(t);
  }
  const al = el.getAttribute('aria-label');
  if (al && norm(al)) return norm(al);
  const tag = el.localName;
  if (tag === 'input' || tag === 'textarea' || tag === 'select' || tag === 'meter' || tag === 'progress') {
    const labels = (el as HTMLInputElement).labels;
    if (labels?.length) return norm(Array.from(labels).map((l) => textOf(l)).join(' '));
    const t = (el.getAttribute('type') ?? '').toLowerCase();
    if (['button', 'submit', 'reset'].includes(t)) return norm((el as HTMLInputElement).value || (t === 'submit' ? 'Submit' : t === 'reset' ? 'Reset' : ''));
    if (t === 'image') return norm(el.getAttribute('alt') ?? el.getAttribute('value') ?? '');
  }
  if (tag === 'img' || tag === 'area') {
    const alt = el.getAttribute('alt');
    if (alt !== null) return norm(alt);
  }
  if (tag === 'fieldset') {
    const lg = el.querySelector(':scope > legend');
    if (lg) return norm(textOf(lg));
  }
  if (tag === 'table') {
    const cap = el.querySelector(':scope > caption');
    if (cap) return norm(textOf(cap));
  }
  if (tag === 'figure') {
    const fc = el.querySelector(':scope > figcaption');
    if (fc) return norm(textOf(fc));
  }
  if (tag === 'svg') {
    const title = el.querySelector(':scope > title');
    if (title) return norm(title.textContent);
  }
  if (role && NAME_FROM_CONTENT.has(role)) {
    const t = norm(textOf(el));
    if (t) return t;
  }
  const title = el.getAttribute('title');
  if (title) return norm(title);
  const ph = el.getAttribute('placeholder');
  if (ph) return norm(ph);
  return '';
}

function isFocusable(el: Element) {
  const ti = el.getAttribute('tabindex');
  if (ti !== null && Number(ti) >= 0) return true;
  return el.matches('a[href],button,input:not([type=hidden]),select,textarea,summary,[contenteditable=""],[contenteditable=true]') && !(el as any).disabled;
}

export function collectA11y(): { tree: A11yNode; nodeCount: number; truncated: boolean } {
  let count = 0;
  let truncated = false;

  const build = (el: Element): A11yNode[] => {
    if (count >= MAX_NODES) {
      truncated = true;
      return [];
    }
    if (['script', 'style', 'noscript', 'template', 'head', 'meta', 'link'].includes(el.localName)) return [];
    const hidden = isHidden(el);
    if (hidden) return []; // wie im Accessibility Tree: ausgeblendete Teilbäume fehlen
    const explicit = el.getAttribute('role')?.trim().split(/\s+/)[0];
    const role = explicit || implicitRole(el);
    const aria: Record<string, string> = {};
    for (const a of Array.from(el.attributes)) if (a.name.startsWith('aria-')) aria[a.name] = a.value;
    const states: Record<string, string | boolean> = {};
    const anyEl = el as any;
    if (anyEl.disabled) states.disabled = true;
    if (el.localName === 'input' && ['checkbox', 'radio'].includes(anyEl.type)) states.checked = anyEl.indeterminate ? 'mixed' : !!anyEl.checked;
    if (anyEl.required) states.required = true;
    if (anyEl.readOnly) states.readonly = true;
    if (el.localName === 'details') states.expanded = !!anyEl.open;
    if (isFocusable(el)) states.focusable = true;
    if (el === el.ownerDocument.activeElement) states.focused = true;
    if (['textbox', 'searchbox', 'spinbutton', 'slider', 'combobox'].includes(role ?? '') && typeof anyEl.value === 'string') states.value = anyEl.value;

    const kids: A11yNode[] = [];
    const root = getShadowRoot(el);
    for (const c of Array.from((root ?? el).children)) kids.push(...build(c));
    // Text direkt unter semantischen Knoten als "text"-Knoten (für Namen aus Inhalt ohnehin im Namen)
    const interesting = !!role && role !== 'presentation' && role !== 'none' || Object.keys(aria).length > 0 || !!states.focusable;
    if (!interesting) return kids;
    count++;
    const node: A11yNode = { role: role ?? 'generic', tag: el.localName };
    const name = accessibleName(el, role);
    if (name) node.name = name;
    if (role === 'heading') node.level = Number(el.getAttribute('aria-level')) || Number(el.localName.slice(1)) || undefined;
    if (Object.keys(aria).length) node.aria = aria;
    if (Object.keys(states).length) node.states = states;
    if (kids.length) node.children = kids;
    return [node];
  };

  const rootNode: A11yNode = { role: 'document', name: norm(document.title), children: document.body ? build(document.body).flatMap((n) => (n.role === 'document' ? n.children ?? [] : [n])) : [] };
  return { tree: rootNode, nodeCount: count, truncated };
}
