import type {FigmaFile, FigmaNode} from './rest-types';
import {FigmaIndex} from './plan';

// What the page picker shows, and which main components a page-by-page read still has to fetch.

export type FigmaPageSummary = {
  id: string;
  name: string;
  /** Top-level layers; null when the page was listed without its content. */
  frames: number | null;
  /** Layers in the page; null when unknown. */
  layers: number | null;
  /** Main components on the page. */
  components: number;
};

export function figmaPages(file: FigmaFile): FigmaPageSummary[] {
  const index = new FigmaIndex(file);
  return index.pages.map(page => {
    const listed = Array.isArray(page.node.children);
    let components = 0;
    if (listed) {
      const stack = [...index.children(page)];
      while (stack.length) {
        const entry = stack.pop()!;
        if (entry.node.type === 'COMPONENT') components++;
        if (entry.node.type !== 'INSTANCE') stack.push(...index.children(entry));
      }
    }
    return {
      id: page.node.id,
      name: typeof page.node.name === 'string' && page.node.name.trim() ? page.node.name : 'Untitled',
      frames: listed ? index.children(page).length : null,
      layers: listed ? page.size - 1 : null,
      components,
    };
  });
}

/** The page that holds a layer (a link's `node-id`: a page, or a frame or anything else on one); null when the read does not show it
 *  (a page listed without its content). */
export function pageOfNode(file: FigmaFile, nodeId: string): string | null {
  for (const page of file.document?.children ?? []) {
    const stack: FigmaNode[] = [page];
    while (stack.length) {
      const node = stack.pop()!;
      if (node.id === nodeId) return page.id;
      if (Array.isArray(node.children)) stack.push(...node.children);
    }
  }
  return null;
}

/** Component (or variant set) ids that instances on the chosen pages show but the read did not
 *  bring: neither in these pages and `extra`, nor from a library. Fetch them, then ask again. */
export function missingComponents(file: FigmaFile, pageIds: readonly string[], extra: readonly FigmaNode[] = []): string[] {
  const index = new FigmaIndex(file, extra);
  const chosen = new Set(pageIds);
  const missing = new Set<string>();
  const roots = [...index.pages.filter(page => chosen.has(page.node.id)), ...index.loose];
  const stack = roots.flatMap(root => index.children(root).concat(root.node.type === 'CANVAS' ? [] : [root]));
  const seen = new Set<string>();
  while (stack.length) {
    const entry = stack.pop()!;
    if (seen.has(entry.node.id)) continue;
    seen.add(entry.node.id);
    const componentId = entry.node.componentId;
    if (entry.node.type === 'INSTANCE' && typeof componentId === 'string' && !index.get(componentId)) {
      const meta = file.components && Object.hasOwn(file.components, componentId) ? file.components[componentId] : undefined;
      if (!meta?.remote) {
        const setId = meta?.componentSetId;
        missing.add(setId && !index.get(setId) ? setId : componentId);
      }
    }
    stack.push(...index.children(entry));
  }
  return [...missing];
}
