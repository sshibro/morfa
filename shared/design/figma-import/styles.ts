import type {DesignDocument, SceneNode, Style, StyleId} from '../types';
import {DESIGN_FIELD_LIMITS as L} from '../document-limits';
import type {FigmaFile} from './rest-types';
import type {StyleUse} from './nodes';
import type {ReportBuilder} from './report';
import {plainId} from './plan';

// Figma styles → local styles. The REST file lists a style's name and kind but not its values, so a
// style takes its values from the first imported layer that uses it (the layers hold the same values
// while the style is applied). Library styles become local ones; a style no imported layer uses has
// no values to read and is left out (reported).

const FIELD = {fill: 'fillStyleId', stroke: 'strokeStyleId', effect: 'effectStyleId', grid: 'gridStyleId', text: 'textStyleId'} as const;
const TYPE = {fill: 'FILL', stroke: 'FILL', effect: 'EFFECT', grid: 'GRID', text: 'TEXT'} as const;

function valuesOf(node: SceneNode, kind: StyleUse['kind']): Partial<Style> | null {
  switch (kind) {
    case 'fill':
      return {paints: node.fills};
    case 'stroke':
      return {paints: node.strokes};
    case 'effect':
      return {effects: node.effects};
    case 'grid':
      return node.layoutGrids ? {grids: node.layoutGrids} : null;
    case 'text':
      return node.text ? {text: node.text.style} : null;
  }
}

/** Writes `doc.styles` and the nodes' style ids in place (the document is still being built). */
export function attachStyles(doc: DesignDocument, file: FigmaFile, uses: readonly StyleUse[], report: ReportBuilder): void {
  const meta = file.styles && typeof file.styles === 'object' ? file.styles : {};
  const made = new Map<string, StyleId>();
  let libraries = 0;
  for (const use of uses) {
    const node = doc.nodes[use.nodeId];
    if (!node) continue;
    const info = Object.hasOwn(meta, use.figmaId) ? meta[use.figmaId] : undefined;
    const type = TYPE[use.kind];
    // A fill style used as a stroke is the same style; a mismatched kind is not ours to apply.
    if (info?.styleType && info.styleType !== type) continue;
    let id = made.get(use.figmaId);
    if (!id) {
      if (Object.keys(doc.styles).length >= L.styles) break;
      const values = valuesOf(node, use.kind);
      if (!values) continue;
      id = 'S' + plainId(use.figmaId);
      if (doc.styles[id]) continue;
      doc.styles[id] = {id, type, name: (info?.name ?? 'Style from Figma').slice(0, L.name), description: (info?.description ?? '').slice(0, L.description), ...values};
      made.set(use.figmaId, id);
      if (info?.remote) libraries++;
    }
    (node as unknown as Record<string, unknown>)[FIELD[use.kind]] = id;
  }
  if (libraries) report.note('styles-library', 'styles', 'Styles from libraries were imported as local styles of the file', undefined, libraries);
  const unused = Object.entries(meta).filter(([id, info]) => !made.has(id) && !info?.remote).length;
  if (unused) report.note('styles-unused', 'styles', 'Styles that are not applied to any layer were not imported: Figma does not provide their values', undefined, unused);
}
