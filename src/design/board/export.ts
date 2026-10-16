import type {DesignDocument, NodeId, SceneNode} from '../../../shared/design/types';
import {childPart, isSticky, isTable} from '../../../shared/design/board/model';
import {csvText, tableCsv} from '../../../shared/design/board/table';
import {EXPORT_MAX_PIXELS, EXPORT_MAX_SIDE} from '../engine/export-raster';

// "Export board" (docs/board.md §Export): what is exported and at what scale (the dialog is editor/ExportBoard.tsx).

export type BoardExportScope = 'page' | 'selection';

/** The top-level objects of the page that show: what "Whole board" exports. */
export function boardExportIds(doc: DesignDocument, pageId: NodeId, scope: BoardExportScope, selection: readonly NodeId[]): NodeId[] {
  if (scope === 'selection') return selection.filter(id => doc.nodes[id] && doc.nodes[id].type !== 'PAGE');
  return (doc.nodes[pageId]?.children ?? []).filter(id => doc.nodes[id]?.visible);
}

/** The largest scale up to `wanted` at which the picture still fits what a browser encodes. */
export function fittingScale(bounds: {width: number; height: number}, wanted: number): number {
  const side = EXPORT_MAX_SIDE / Math.max(bounds.width, bounds.height, 1);
  const area = Math.sqrt(EXPORT_MAX_PIXELS / Math.max(1, bounds.width * bounds.height));
  return Math.max(0.01, Math.min(wanted, Math.min(side, area) * 0.999));
}


// ── CSV (FigJam: "export your sticky notes and tables to CSV files") ─────────────────────────────

/** The objects among `ids` and inside them (a section's stickies) that `keep` answers. */
function collect(doc: DesignDocument, ids: readonly NodeId[], keep: (node: SceneNode) => boolean): SceneNode[] {
  const out: SceneNode[] = [];
  const walk = (id: NodeId) => {
    const node = doc.nodes[id];
    if (!node) return;
    if (keep(node)) out.push(node);
    else if (node.type === 'SECTION' || node.type === 'GROUP' || node.type === 'FRAME') for (const child of node.children ?? []) walk(child);
  };
  ids.forEach(walk);
  return out;
}

/** Stickies as FigJam writes them: a row each, its text ("Text") and, when its author line shows, who wrote it ("Author"). */
export function stickiesCsv(doc: DesignDocument, ids: readonly NodeId[]): string | null {
  const get = (id: NodeId | null | undefined) => (id ? doc.nodes[id] : undefined);
  const stickies = collect(doc, ids, isSticky).sort((a, b) => a.y - b.y || a.x - b.x);
  if (!stickies.length) return null;
  return csvText([['Text', 'Author'], ...stickies.map(sticky => {
    const author = childPart(get, sticky, 'author');
    return [childPart(get, sticky, 'text')?.text?.characters ?? '', author?.visible ? author.text?.characters ?? '' : ''];
  })]);
}

/** The tables among `ids` (and inside sections), each with its name, as CSV files. */
export function tablesCsv(doc: DesignDocument, ids: readonly NodeId[]): {name: string; csv: string}[] {
  const get = (id: NodeId | null | undefined) => (id ? doc.nodes[id] : undefined);
  return collect(doc, ids, isTable).map(table => ({name: table.name, csv: tableCsv(get, table.id)}));
}
