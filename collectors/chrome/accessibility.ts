// Accessibility (Chrome): Accessibility.getFullAXTree (the real accessibility tree).
import { collectA11yFallback } from '@/collectors/firefox/accessibility';
import type { Collector } from '@/lib/context';
import { errMsg } from '@/lib/fetcher';
import type { CollectorResult } from '@/lib/types';

interface AXNode {
  nodeId: string;
  ignored: boolean;
  role?: { value?: string };
  name?: { value?: string };
  description?: { value?: string };
  value?: { value?: unknown };
  properties?: { name: string; value: { value?: unknown } }[];
  childIds?: string[];
  parentId?: string;
  backendDOMNodeId?: number;
  frameId?: string;
}

interface TreeNode {
  role: string;
  name?: string;
  description?: string;
  value?: unknown;
  properties?: Record<string, unknown>;
  children?: TreeNode[];
}

/** Flat AX node list → nested tree (ignored nodes are skipped). */
function buildTree(nodes: AXNode[]): TreeNode[] {
  const byId = new Map(nodes.map((n) => [n.nodeId, n]));
  const roots = nodes.filter((n) => !n.parentId || !byId.has(n.parentId));
  const visit = (n: AXNode, depth: number): TreeNode[] => {
    if (depth > 500) return [];
    const kids = (n.childIds ?? []).flatMap((id) => {
      const c = byId.get(id);
      return c ? visit(c, depth + 1) : [];
    });
    if (n.ignored) return kids;
    const t: TreeNode = { role: String(n.role?.value ?? 'unknown') };
    if (n.name?.value) t.name = String(n.name.value);
    if (n.description?.value) t.description = String(n.description.value);
    if (n.value?.value !== undefined && n.value.value !== '') t.value = n.value.value;
    if (n.properties?.length) t.properties = Object.fromEntries(n.properties.map((p) => [p.name, p.value?.value]));
    if (kids.length) t.children = kids;
    return [t];
  };
  return roots.flatMap((r) => visit(r, 0));
}

export const collectA11yChrome: Collector = async (ctx) => {
  if (!ctx.cdp) {
    const r = await collectA11yFallback(ctx);
    r.warnings.unshift('Chrome debugger not attached – approximation only.');
    return r;
  }
  const cdp = ctx.cdp;
  const result: CollectorResult = { files: {}, warnings: [] };
  await cdp.send('Accessibility.enable');
  try {
    const main = await cdp.send<{ nodes: AXNode[] }>('Accessibility.getFullAXTree', {});
    // Additional frames (if in the same process)
    const frames: { frameId: string; url: string; nodes: AXNode[] }[] = [];
    try {
      const { frameTree } = await cdp.send('Page.getFrameTree');
      const walk = (n: any, top: boolean): { id: string; url: string }[] => [
        ...(top ? [] : [{ id: n.frame.id, url: n.frame.url }]),
        ...(n.childFrames ?? []).flatMap((c: any) => walk(c, false)),
      ];
      for (const f of walk(frameTree, true)) {
        try {
          const r = await cdp.send<{ nodes: AXNode[] }>('Accessibility.getFullAXTree', { frameId: f.id });
          frames.push({ frameId: f.id, url: f.url, nodes: r.nodes });
        } catch (e) {
          result.warnings.push(`A11y tree for frame ${f.url}: ${errMsg(e)}`);
        }
      }
    } catch {
      /* ignore */
    }
    result.files['accessibility.json'] = JSON.stringify(
      {
        source: 'Chrome DevTools Protocol (Accessibility.getFullAXTree)',
        url: ctx.url,
        nodeCount: main.nodes.length,
        tree: buildTree(main.nodes),
        frames: frames.map((f) => ({ frameId: f.frameId, url: f.url, nodeCount: f.nodes.length, tree: buildTree(f.nodes) })),
        rawNodes: main.nodes,
      },
      null,
      1,
    );
    ctx.detail(`${main.nodes.length} nodes`);
  } finally {
    await cdp.send('Accessibility.disable').catch(() => {});
  }
  return result;
};
