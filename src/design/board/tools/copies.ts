import type {DesignDocument, SceneNode} from '../../../../shared/design/types';
import {newId} from '../../../../shared/design/defaults';
import {childPart, isSticky} from '../../../../shared/design/board/model';
import {createShape, createSticky, type BoardBuild} from '../../../../shared/design/board/create';
import {swatchOf, STICKY_COLORS, rgbToHex} from '../../../../shared/design/board/palette';
import {boardIdentity} from './place';

// A blank copy of a sticky or a shape with text (FigJam's quick create: the four dots, ⌘↵): an empty sticky of the same colour and
// width, or an empty shape of the same figure, size, fill and outline, carrying the author's name like any new sticky.

/** A blank copy of `object` with its top-left at (x, y) in the object's parent, or null for any other object. */
export function blankCopy(doc: DesignDocument, object: SceneNode, x: number, y: number): BoardBuild | null {
  if (isSticky(object)) {
    const fill = object.fills.find(paint => paint.type === 'SOLID');
    const color = (fill?.type === 'SOLID' && swatchOf(STICKY_COLORS, fill.color)?.id) || 'yellow';
    const author = boardIdentity().name || undefined;
    return createSticky(newId, {x, y, color, author, showAuthor: !!author, wide: object.board?.kind === 'sticky' && object.board.wide});
  }
  if (object.board?.kind !== 'shape') return null;
  const figure = childPart(id => (id ? doc.nodes[id] : undefined), object, 'shape');
  const fill = figure?.fills.find(paint => paint.type === 'SOLID');
  const stroke = figure?.strokes.find(paint => paint.type === 'SOLID');
  return createShape(newId, {x, y, width: object.width, height: object.minHeight ?? object.height, shape: object.board.shape,
    fill: fill?.type === 'SOLID' ? rgbToHex(fill.color) : undefined, stroke: stroke?.type === 'SOLID' ? rgbToHex(stroke.color) : null});
}
