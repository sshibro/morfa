import type {DesignDocument, NodeId, SceneNode} from '../../../../shared/design/types';
import {importSvgString} from '../svg-dom';

// Texts set in an icon font the catalogue lacks (Material Symbols ligatures and the like): Figma draws "gas_station" as
// one icon, a fallback font spells it letter by letter and wraps it down its 24 px box. The mapping marks such texts
// (pluginData.figmaIcon = their Figma id, shared/design/figma-import/nodes.ts); here Figma renders each as SVG and the
// text is replaced, in place and under the same id, by the editable vectors of that render.

export type IconText = {id: NodeId; figmaId: string};

/** Figma ids per render request (the images endpoint takes a list). */
const RENDER_BATCH = 50;
/** What the vector frame keeps of the text it replaces: place, layout behaviour, visibility. */
const KEPT = ['name', 'x', 'y', 'rotation', 'visible', 'locked', 'opacity', 'constraints', 'layoutPositioning', 'layoutSizingHorizontal', 'layoutSizingVertical'] as const;

export function iconTextsOf(doc: DesignDocument): IconText[] {
  const found: IconText[] = [];
  for (const node of Object.values(doc.nodes)) {
    const figmaId = node.type === 'TEXT' ? node.pluginData?.figmaIcon : undefined;
    if (figmaId && node.parentId) found.push({id: node.id, figmaId});
  }
  return found;
}

/** Swaps one icon text for the vectors of its SVG render; false (the text stays) when the render is unusable. */
export function replaceWithSvg(doc: DesignDocument, id: NodeId, svg: string): boolean {
  const text = doc.nodes[id];
  if (!text || text.type !== 'TEXT' || !text.parentId) return false;
  const result = importSvgString(svg, {name: text.name, parentId: text.parentId, x: text.x, y: text.y});
  if ('error' in result || result.images.length) return false;
  const root = result.nodes.find(node => node.id === result.rootId);
  if (!root) return false;
  const source = text as unknown as Record<string, unknown>;
  const kept = Object.fromEntries(KEPT.filter(key => key in source).map(key => [key, source[key]]));
  // The same id: the parent's children, instance overrides and prototype links that name the layer keep pointing at it.
  const frame = {...root, ...kept, id} as SceneNode;
  delete doc.nodes[id];
  for (const node of result.nodes) {
    if (node.id === result.rootId) continue;
    doc.nodes[node.id] = node.parentId === result.rootId ? {...node, parentId: id} : node;
  }
  doc.nodes[id] = frame;
  return true;
}

export type IconRenderDeps = {
  /** Figma's SVG renders of these nodes (null: Figma could not render one). */
  render: (figmaIds: string[]) => Promise<Record<string, string | null>>;
  download: (url: string, signal?: AbortSignal) => Promise<Blob>;
};

/** Replaces every icon text it can; the others stay as they were mapped. */
export async function replaceIconTexts(doc: DesignDocument, icons: readonly IconText[], deps: IconRenderDeps, signal?: AbortSignal): Promise<{replaced: number; failed: number}> {
  let replaced = 0, failed = 0;
  for (let start = 0; start < icons.length; start += RENDER_BATCH) {
    const batch = icons.slice(start, start + RENDER_BATCH);
    let links: Record<string, string | null>;
    try {
      links = await deps.render(batch.map(icon => icon.figmaId));
    } catch (error) {
      signal?.throwIfAborted();
      if (error instanceof Error && error.name === 'FigmaApiError' && 'kind' in error && (error.kind === 'token' || error.kind === 'scope')) throw error;
      failed += batch.length;
      continue;
    }
    for (const icon of batch) {
      const link = links[icon.figmaId];
      try {
        if (link && replaceWithSvg(doc, icon.id, await (await deps.download(link, signal)).text())) replaced++;
        else failed++;
      } catch {
        signal?.throwIfAborted();
        failed++;
      }
    }
  }
  return {replaced, failed};
}
