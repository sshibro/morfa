import type {ColorStop, Effect, GradientPaint, GradientType, ImagePaint, IndividualStrokeWeights, NodeType, Paint, RGB, RGBA, SceneNode, ShadowEffect, SolidPaint, Vec} from '../../../../../shared/design/types';
import {BLACK, SHAPE_GREY, WHITE, solid} from '../../../../../shared/design/defaults';
import {colorAt, normalizedStops} from '../../../engine/render/gradient-math';
import {clamp01, toHex} from './color';

// The paint lists of the "Design" tab as data: which order the rows show (top-first, while the model
// keeps fills[0] at the bottom), what "+" adds, what a type switch keeps, and the gradient edits
// the picker makes. Pure, tested in node (tests/design-paint.test.ts).

export type PaintField = 'fills' | 'strokes';
export type PaintKind = 'SOLID' | GradientType | 'IMAGE';

export const GRADIENT_TYPES: readonly GradientType[] = ['GRADIENT_LINEAR', 'GRADIENT_RADIAL', 'GRADIENT_ANGULAR', 'GRADIENT_DIAMOND'];
export const isGradient = (paint: Paint | null | undefined): paint is GradientPaint => !!paint && (GRADIENT_TYPES as readonly string[]).includes(paint.type);

export const PAINT_KIND_LABELS: Record<PaintKind, string> = {
  SOLID: 'Solid',
  GRADIENT_LINEAR: 'Linear',
  GRADIENT_RADIAL: 'Radial',
  GRADIENT_ANGULAR: 'Angular',
  GRADIENT_DIAMOND: 'Diamond',
  IMAGE: 'Image',
};

// ── Order ──────────────────────────────────────────────────────────────────────────────────────

/** The rows as the panel lists them: the top paint first. */
export const displayOrder = <T>(list: readonly T[]): T[] => [...list].reverse();
/** The model index (bottom-first) of row `row` in a list of `length`. */
export const modelIndex = (row: number, length: number) => length - 1 - row;
/** The row of model index `index`. */
export const rowIndex = (index: number, length: number) => length - 1 - index;

/** Moves the paint shown in row `from` to row `to` (rows are top-first); returns the model list. */
export function reorderRows<T>(list: readonly T[], from: number, to: number): T[] {
  const rows = displayOrder(list);
  if (from < 0 || from >= rows.length) return [...list];
  const [moved] = rows.splice(from, 1);
  rows.splice(Math.max(0, Math.min(rows.length, to)), 0, moved);
  return displayOrder(rows);
}

// ── Defaults ───────────────────────────────────────────────────────────────────────────────────

const FRAME_FILL_TYPES = new Set<NodeType>(['FRAME', 'COMPONENT', 'COMPONENT_SET', 'INSTANCE', 'SECTION']);
/** Types that take fills in the panel. */
const NO_FILLS = new Set<NodeType>(['PAGE', 'GROUP', 'SLICE', 'LINE']);
const NO_STROKES = new Set<NodeType>(['PAGE', 'GROUP', 'SLICE', 'SECTION']);
const NO_EFFECTS = new Set<NodeType>(['PAGE', 'SLICE']);
export const takesFills = (type: NodeType) => !NO_FILLS.has(type);
export const takesStrokes = (type: NodeType) => !NO_STROKES.has(type);
export const takesEffects = (type: NodeType) => !NO_EFFECTS.has(type);
/** Lines and open vectors draw markers at their ends. */
export const takesMarkers = (node: Pick<SceneNode, 'type' | 'vectorPaths'>) =>
  node.type === 'LINE' || (node.type === 'VECTOR' && !!node.vectorPaths?.some(path => path.commands.length > 1 && path.commands[path.commands.length - 1].type !== 'Z'));
/** Rectangles and frame-likes may weigh each side on its own. */
export const takesSideWeights = (type: NodeType) => type === 'RECTANGLE' || FRAME_FILL_TYPES.has(type) && type !== 'SECTION';

/** What "+" adds to a fill list, as Figma does: the type's default colour on an empty list
 *  (#D9D9D9 shapes, #FFFFFF frames, black text), a 20 % black layer over existing paints. */
export function newFill(type: NodeType, existing: readonly Paint[]): SolidPaint {
  if (existing.length) return solid(BLACK, 0.2);
  if (type === 'TEXT') return solid(BLACK);
  return solid(FRAME_FILL_TYPES.has(type) ? WHITE : SHAPE_GREY);
}

/** What "+" puts on layers whose fills differ ("Click '+' to replace mixed fills"): one fill for all of
 *  them, so they agree afterwards — the kinds' common default, #D9D9D9 when the kinds disagree (a text and a frame). */
export function replacingFill(types: readonly NodeType[]): SolidPaint {
  const defaults = types.map(type => newFill(type, []));
  const first = defaults[0];
  return first && defaults.every(each => toHex(each.color) === toHex(first.color)) ? first : solid(SHAPE_GREY);
}

/** What "+" adds to a stroke list: black, fully opaque. */
export const newStroke = (): SolidPaint => solid(BLACK);

/** Figma's first drop shadow: black 25 %, 4 px down, 4 px blur. */
export const newDropShadow = (): ShadowEffect => ({type: 'DROP_SHADOW', color: {r: 0, g: 0, b: 0, a: 0.25}, offset: {x: 0, y: 4}, radius: 4, spread: 0, visible: true, blendMode: 'NORMAL', showShadowBehindNode: false});

export const EFFECT_LABELS: Record<Effect['type'], string> = {
  DROP_SHADOW: 'Drop shadow',
  INNER_SHADOW: 'Inner shadow',
  LAYER_BLUR: 'Layer blur',
  BACKGROUND_BLUR: 'Background blur',
};

/** The effect turned into another type, keeping what both share (colour, offset, radius, visibility). */
export function convertEffect(effect: Effect, type: Effect['type']): Effect {
  if (effect.type === type) return effect;
  if (type === 'LAYER_BLUR' || type === 'BACKGROUND_BLUR') return {type, radius: effect.radius || 4, visible: effect.visible};
  const base = effect.type === 'DROP_SHADOW' || effect.type === 'INNER_SHADOW' ? effect : {...newDropShadow(), radius: effect.radius, visible: effect.visible};
  const next: ShadowEffect = {...base, type};
  if (type === 'INNER_SHADOW') delete next.showShadowBehindNode;
  else next.showShadowBehindNode ??= false;
  return next;
}

// ── Labels ─────────────────────────────────────────────────────────────────────────────────────

/** What a row prints for a paint: the hex of a solid, the kind of a gradient or picture. */
export const paintLabel = (paint: Paint) => (paint.type === 'SOLID' ? toHex(paint.color) : PAINT_KIND_LABELS[paint.type]);

/** A CSS background that previews a paint in a swatch (gradients as a straight bar, pictures by URL). */
export function paintPreview(paint: Paint, imageUrl?: string | null): string {
  if (paint.type === 'SOLID') return rgbaCss(paint.color, 1);
  if (paint.type === 'IMAGE') return imageUrl ? `center / cover no-repeat url("${imageUrl.replace(/["\\\n]/g, '')}")` : 'transparent';
  return gradientCss(paint, paint.type === 'GRADIENT_LINEAR' ? 'linear' : paint.type === 'GRADIENT_ANGULAR' ? 'conic' : 'radial');
}

export const rgbaCss = (color: RGB | RGBA, alpha = 'a' in color ? color.a : 1) =>
  `rgb(${Math.round(clamp01(color.r) * 255)} ${Math.round(clamp01(color.g) * 255)} ${Math.round(clamp01(color.b) * 255)} / ${Math.round(clamp01(alpha) * 1000) / 1000})`;

/** The stops as a CSS gradient; `bar` is the left-to-right strip the picker's stop editor shows. */
export function gradientCss(paint: Pick<GradientPaint, 'gradientStops'>, shape: 'linear' | 'radial' | 'conic' | 'bar' = 'bar'): string {
  const stops = normalizedStops(paint.gradientStops).map(stop => `${rgbaCss(stop.color)} ${Math.round(stop.position * 1000) / 10}%`).join(', ') || 'transparent 0%, transparent 100%';
  if (shape === 'radial') return `radial-gradient(circle closest-side, ${stops})`;
  if (shape === 'conic') return `conic-gradient(from 90deg, ${stops})`;
  return `linear-gradient(${shape === 'linear' ? '180deg' : '90deg'}, ${stops})`;
}

// ── Type switches ──────────────────────────────────────────────────────────────────────────────

/** Default handles in the node's unit box: linear runs top to bottom; the others are centred,
 *  reaching the right and bottom edges. The third handle of a linear gradient is perpendicular to
 *  its axis at half its length (only its direction matters). */
export function defaultHandles(type: GradientType): [Vec, Vec, Vec] {
  if (type === 'GRADIENT_LINEAR') return [{x: 0.5, y: 0}, {x: 0.5, y: 1}, {x: 0, y: 0}];
  return [{x: 0.5, y: 0.5}, {x: 1, y: 0.5}, {x: 0.5, y: 1}];
}

const stopsFrom = (color: RGB, alpha: number): ColorStop[] => [
  {position: 0, color: {r: color.r, g: color.g, b: color.b, a: alpha}},
  {position: 1, color: {r: color.r, g: color.g, b: color.b, a: 0}},
];

/** The paint as another kind, keeping its colour where both have one: a solid becomes a gradient
 *  from its colour to transparent; a gradient becomes a solid of its first stop; gradients swap
 *  types keeping stops and handles; a picture starts empty ("Choose image"). */
export function convertPaint(paint: Paint, kind: PaintKind): Paint {
  if (paint.type === kind) return paint;
  const base = {opacity: paint.opacity, visible: paint.visible, blendMode: paint.blendMode};
  if (kind === 'SOLID') {
    if (isGradient(paint)) {
      const first = normalizedStops(paint.gradientStops)[0];
      return first ? {...base, type: 'SOLID', color: {r: first.color.r, g: first.color.g, b: first.color.b}, opacity: paint.opacity * first.color.a} : solid(SHAPE_GREY);
    }
    return {...solid(SHAPE_GREY), visible: paint.visible};
  }
  if (kind === 'IMAGE') return {...base, opacity: 1, type: 'IMAGE', imageRef: '', scaleMode: 'FILL'} satisfies ImagePaint;
  if (isGradient(paint)) {
    const linear = paint.type === 'GRADIENT_LINEAR' || kind === 'GRADIENT_LINEAR';
    return {...paint, type: kind, gradientHandlePositions: linear ? defaultHandles(kind) : paint.gradientHandlePositions};
  }
  const color = paint.type === 'SOLID' ? paint.color : SHAPE_GREY;
  const alpha = paint.type === 'SOLID' ? paint.opacity : 1;
  return {...base, opacity: 1, type: kind, gradientStops: stopsFrom(color, alpha), gradientHandlePositions: defaultHandles(kind)};
}

// ── Gradient stops ─────────────────────────────────────────────────────────────────────────────

/** A stop at `position` with the colour the gradient has there; returns the paint and the new stop's index. */
export function addStop(paint: GradientPaint, position: number): {paint: GradientPaint; index: number} {
  const at = clamp01(position);
  const color = colorAt(paint.gradientStops, at);
  const gradientStops = [...paint.gradientStops, {position: at, color: {r: color.r, g: color.g, b: color.b, a: color.a}}];
  return {paint: {...paint, gradientStops}, index: gradientStops.length - 1};
}

/** Removes a stop; a gradient keeps at least two. */
export function removeStop(paint: GradientPaint, index: number): GradientPaint {
  if (paint.gradientStops.length <= 2 || !paint.gradientStops[index]) return paint;
  return {...paint, gradientStops: paint.gradientStops.filter((_, i) => i !== index)};
}

export function updateStop(paint: GradientPaint, index: number, partial: Partial<ColorStop>): GradientPaint {
  if (!paint.gradientStops[index]) return paint;
  const gradientStops = paint.gradientStops.map((stop, i) => (i === index ? {...stop, ...partial, position: clamp01(partial.position ?? stop.position)} : stop));
  return {...paint, gradientStops};
}

/** Stops mirrored end to end (Figma's "Flip"). */
export const flipGradient = (paint: GradientPaint): GradientPaint => ({...paint, gradientStops: paint.gradientStops.map(stop => ({...stop, position: 1 - stop.position}))});

/** The handles turned 90° clockwise on screen about the box's centre, in the node's pixels so a
 *  wide box keeps the gradient's shape. */
export function rotateGradient(paint: GradientPaint, width: number, height: number): GradientPaint {
  const w = width > 0 ? width : 1, h = height > 0 ? height : 1;
  const turn = (p: Vec): Vec => {
    const x = (p.x - 0.5) * w, y = (p.y - 0.5) * h;
    return {x: -y / w + 0.5, y: x / h + 0.5};
  };
  const [a, b, c] = paint.gradientHandlePositions;
  return {...paint, gradientHandlePositions: [turn(a), turn(b), turn(c)]};
}

/** Stop indexes ordered by position (the stops list and keyboard order). */
export function stopOrder(paint: GradientPaint): number[] {
  return paint.gradientStops.map((stop, index) => ({stop, index})).sort((p, q) => p.stop.position - q.stop.position || p.index - q.index).map(entry => entry.index);
}

// ── Strokes per side ───────────────────────────────────────────────────────────────────────────

export type SideMode = 'ALL' | 'TOP' | 'BOTTOM' | 'LEFT' | 'RIGHT' | 'CUSTOM';
export const SIDE_LABELS: Record<SideMode, string> = {ALL: 'All', TOP: 'Top', BOTTOM: 'Bottom', LEFT: 'Left', RIGHT: 'Right', CUSTOM: 'Custom'};
export const SIDE_KEYS: Record<'TOP' | 'BOTTOM' | 'LEFT' | 'RIGHT', keyof IndividualStrokeWeights> = {TOP: 'top', BOTTOM: 'bottom', LEFT: 'left', RIGHT: 'right'};

/** Which sides a weight set draws: all (none set), one side alone, or its own per side. */
export function sideMode(sides: IndividualStrokeWeights | null | undefined): SideMode {
  if (!sides) return 'ALL';
  const drawn = (Object.keys(SIDE_KEYS) as (keyof typeof SIDE_KEYS)[]).filter(key => sides[SIDE_KEYS[key]] > 0);
  return drawn.length === 1 ? drawn[0] : 'CUSTOM';
}

/** The fields a side mode writes, from the weight the stroke has now. */
export function sidePatch(mode: SideMode, weight: number): Partial<SceneNode> {
  if (mode === 'ALL') return {individualStrokeWeights: null, strokeWeight: weight};
  if (mode === 'CUSTOM') return {individualStrokeWeights: {top: weight, right: weight, bottom: weight, left: weight}, strokeWeight: weight};
  const sides = {top: 0, right: 0, bottom: 0, left: 0};
  sides[SIDE_KEYS[mode]] = weight;
  return {individualStrokeWeights: sides, strokeWeight: weight};
}

// ── Comparing ──────────────────────────────────────────────────────────────────────────────────

/** Structural equality of plain model values (paints, effects). */
export function deepEqual(a: unknown, b: unknown): boolean {
  if (Object.is(a, b)) return true;
  if (typeof a !== 'object' || typeof b !== 'object' || !a || !b) return false;
  if (Array.isArray(a)) return Array.isArray(b) && a.length === b.length && a.every((value, i) => deepEqual(value, b[i]));
  if (Array.isArray(b)) return false;
  const keysA = Object.keys(a).filter(key => (a as Record<string, unknown>)[key] !== undefined);
  const keysB = Object.keys(b).filter(key => (b as Record<string, unknown>)[key] !== undefined);
  return keysA.length === keysB.length && keysA.every(key => deepEqual((a as Record<string, unknown>)[key], (b as Record<string, unknown>)[key]));
}

export const MIXED = 'mixed' as const;
export type Mixed = typeof MIXED;

/** The one list every node shows, or 'mixed' when they differ. */
export function commonList<T>(lists: readonly (readonly T[])[]): readonly T[] | Mixed {
  if (!lists.length) return [];
  const first = lists[0];
  for (let i = 1; i < lists.length; i++) if (lists[i] !== first && !deepEqual(lists[i], first)) return MIXED;
  return first;
}

/** One shared value of `pick` across nodes, or 'mixed'. */
export function commonValue<T, N>(nodes: readonly N[], pick: (node: N) => T): T | Mixed | null {
  if (!nodes.length) return null;
  const first = pick(nodes[0]);
  for (let i = 1; i < nodes.length; i++) if (!deepEqual(pick(nodes[i]), first)) return MIXED;
  return first;
}

/** Writes paint `index` (model order) of a list. */
export const replaceAt = <T>(list: readonly T[], index: number, value: T): T[] => list.map((item, i) => (i === index ? value : item));
export const removeAt = <T>(list: readonly T[], index: number): T[] => list.filter((_, i) => i !== index);

/** A solid paint whose colour is typed or picked by hand: a variable binding no longer holds. */
export function unbound(paint: SolidPaint): SolidPaint {
  if (!paint.boundVariables) return paint;
  const next = {...paint};
  delete next.boundVariables;
  return next;
}

/** The top visible solid fill takes the colour (keeping its opacity); a list without one gets a solid fill (the pipette). */
export function fillsWithColor(fills: readonly Paint[], color: RGB): Paint[] {
  for (let i = fills.length - 1; i >= 0; i--) {
    const paint = fills[i];
    if (paint.type === 'SOLID' && paint.visible !== false) return replaceAt(fills, i, {...unbound(paint), color: {...color}});
  }
  return [...fills, solid(color)];
}
