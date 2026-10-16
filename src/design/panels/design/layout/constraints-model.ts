import type {ConstraintType, DesignDocument, SceneNode} from '../../../../../shared/design/types';
import {isAutoLayout} from '../../../../../shared/design/constraints';

// The "Constraints" widget: Figma's square with a bar on each side and two centre lines, and the
// two dropdowns beside it. Pure mapping between clicks and `constraints`, covered by node tests.
//
// A click on a side bar pins that side (MIN for left/top, MAX for right/bottom); a click on a centre
// line centres. ⇧-click adds the opposite side to a pinned one (both sides = STRETCH) or takes one
// side off a stretched pair; on a centred or scaled layer ⇧ behaves like a plain click.

export type ConstraintPart = 'start' | 'end' | 'center';
export type ConstraintAxis = 'horizontal' | 'vertical';

export function constraintAfterClick(current: ConstraintType, part: ConstraintPart, shift: boolean): ConstraintType {
  if (part === 'center') return 'CENTER';
  const own: ConstraintType = part === 'start' ? 'MIN' : 'MAX';
  const other: ConstraintType = part === 'start' ? 'MAX' : 'MIN';
  if (!shift) return own;
  if (current === other) return 'STRETCH';
  if (current === 'STRETCH') return other;
  return own;
}

/** Which bars of the widget are lit for a constraint. SCALE lights none (the dropdown says "Scale"). */
export function constraintParts(type: ConstraintType | 'mixed' | null): Record<ConstraintPart, boolean> {
  return {
    start: type === 'MIN' || type === 'STRETCH',
    end: type === 'MAX' || type === 'STRETCH',
    center: type === 'CENTER',
  };
}

export const CONSTRAINT_LABELS: Record<ConstraintAxis, Record<ConstraintType, string>> = {
  horizontal: {MIN: 'Left', MAX: 'Right', STRETCH: 'Left and right', CENTER: 'Center', SCALE: 'Scale'},
  vertical: {MIN: 'Top', MAX: 'Bottom', STRETCH: 'Top and bottom', CENTER: 'Center', SCALE: 'Scale'},
};

export const CONSTRAINT_ORDER: readonly ConstraintType[] = ['MIN', 'MAX', 'STRETCH', 'CENTER', 'SCALE'];

/** What the position section shows about a layer's relation to its parent:
 *  - 'constraints': a child of a frame, component or section without auto layout, or an absolute
 *    child of an auto-layout frame (Figma's "Constraints");
 *  - 'flow': a child an auto-layout frame places (sizing and "Absolute position" instead);
 *  - null: on the page or inside a group (groups scale their children; Figma shows no constraints). */
export function parentRelation(doc: DesignDocument, node: SceneNode): 'constraints' | 'flow' | null {
  const parent = doc.nodes[node.parentId ?? ''];
  if (!parent || parent.type === 'PAGE' || parent.type === 'GROUP' || parent.type === 'BOOLEAN_OPERATION') return null;
  if (isAutoLayout(parent)) return node.layoutPositioning === 'ABSOLUTE' ? 'constraints' : 'flow';
  return 'constraints';
}

/** Children of an auto-layout frame can leave the flow. */
export function canBeAbsolute(doc: DesignDocument, node: SceneNode): boolean {
  return isAutoLayout(doc.nodes[node.parentId ?? '']);
}
