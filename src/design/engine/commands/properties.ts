import type {
  BlendMode, DesignDocument, Effect, ImageAsset, ImageRef, LayoutGrid, NodeId, Paint, SceneNode, StyleId, TextProps, TextStyle, VariableAlias,
} from '../../../../shared/design/types';
import {FRAME_LIKE_TYPES} from '../../../../shared/design/types';
import {TEXT_STYLE_KEYS} from '../../../../shared/design/styles';
import {applyFillsToRange, applyStyleToRange, normalizeRuns} from '../../../../shared/design/text-edit';
import type {Transaction} from '../../../../shared/design/transaction';
import {notify} from './components';
import {userUpdate} from '../user-edit';
import {registerCommand, type Command, type CommandContext} from './registry';

// "Copy properties" (⌥⌘C) and "Paste properties" (⌥⌘V), as in Figma: the look of one layer —
// fills, strokes, effects, opacity and blend mode, corner radius, the type of a text, layout grids,
// with the styles and variables they come from — onto every selected layer in one undo step.
// What a target cannot have is skipped (no corners on an ellipse, no grids outside frames, no type
// outside texts). Each write goes through `userUpdate`, so copies inside instances record overrides.

export type CopiedText = Pick<TextProps, 'textAlignHorizontal' | 'textAlignVertical' | 'paragraphSpacing' | 'paragraphIndent'> & {
  /** The type of the first character (Figma takes the first one of mixed text). */
  style: TextStyle;
  textStyleId?: StyleId;
};

export type CopiedProperties = {
  fills: Paint[];
  fillStyleId?: StyleId;
  strokes: Paint[];
  strokeStyleId?: StyleId;
  stroke: Pick<SceneNode, 'strokeWeight' | 'strokeAlign' | 'strokeCap' | 'strokeJoin' | 'strokeMiterLimit' | 'dashPattern' | 'individualStrokeWeights'>;
  effects: Effect[];
  effectStyleId?: StyleId;
  opacity: number;
  blendMode: BlendMode;
  /** Present when the source has corners. */
  corners?: Pick<SceneNode, 'cornerRadius' | 'rectangleCornerRadii' | 'cornerSmoothing'>;
  text?: CopiedText;
  /** Present when the source is a frame. */
  layoutGrids?: LayoutGrid[];
  gridStyleId?: StyleId;
  /** Variables bound to the copied number fields (opacity, radii, stroke weights). */
  boundVariables: Record<string, VariableAlias>;
  /** Pictures the fills and strokes use, so a paste in another file can register them. */
  images: Record<ImageRef, ImageAsset>;
};

const clone = <T>(value: T): T => (value === undefined ? value : structuredClone(value));
const CORNER_FIELDS = ['cornerRadius', 'topLeftRadius', 'topRightRadius', 'bottomRightRadius', 'bottomLeftRadius'];
const STROKE_FIELDS = ['strokeWeight', 'strokeTopWeight', 'strokeRightWeight', 'strokeBottomWeight', 'strokeLeftWeight'];
const hasCorners = (node: SceneNode) => node.cornerRadius !== undefined;
const hasSideCorners = (node: SceneNode) => node.type === 'RECTANGLE' || FRAME_LIKE_TYPES.includes(node.type);
const isFrameLike = (node: SceneNode) => FRAME_LIKE_TYPES.includes(node.type);

/** The properties of one layer, deep-copied (later edits of the layer do not change them). */
export function copyProperties(doc: DesignDocument, id: NodeId): CopiedProperties | null {
  const node = doc.nodes[id];
  if (!node || node.type === 'PAGE') return null;
  // A text whose first characters have their own colour or type: Figma copies what the first one shows.
  const first = node.text?.runs.find(run => run.start === 0 && run.end > 0);
  const fills = first?.fills ?? node.fills;
  const bound: Record<string, VariableAlias> = {};
  for (const field of ['opacity', ...(hasCorners(node) ? CORNER_FIELDS : []), ...STROKE_FIELDS]) {
    const alias = node.boundVariables?.[field];
    if (alias) bound[field] = {...alias};
  }
  const images: Record<ImageRef, ImageAsset> = {};
  for (const paint of [...fills, ...node.strokes]) if (paint.type === 'IMAGE' && paint.imageRef && doc.images[paint.imageRef]) images[paint.imageRef] = {...doc.images[paint.imageRef]};
  const out: CopiedProperties = {
    fills: clone(fills),
    fillStyleId: first?.fills ? undefined : node.fillStyleId,
    strokes: clone(node.strokes),
    strokeStyleId: node.strokeStyleId,
    stroke: {
      strokeWeight: node.strokeWeight,
      strokeAlign: node.strokeAlign,
      strokeCap: node.strokeCap,
      strokeJoin: node.strokeJoin,
      strokeMiterLimit: node.strokeMiterLimit,
      dashPattern: [...node.dashPattern],
      individualStrokeWeights: node.individualStrokeWeights ? {...node.individualStrokeWeights} : null,
    },
    effects: clone(node.effects),
    effectStyleId: node.effectStyleId,
    opacity: node.opacity,
    blendMode: node.blendMode,
    boundVariables: bound,
    images,
  };
  if (hasCorners(node)) {
    out.corners = {cornerRadius: node.cornerRadius, rectangleCornerRadii: node.rectangleCornerRadii ? [...node.rectangleCornerRadii] : null, cornerSmoothing: node.cornerSmoothing};
  }
  if (node.text) {
    const style = {...node.text.style, ...(first?.style ?? {})};
    delete style.hyperlink;
    out.text = {
      style: clone(style),
      textStyleId: first?.textStyleId ?? (first && TEXT_STYLE_KEYS.some(key => first.style[key] !== undefined) ? undefined : node.textStyleId),
      textAlignHorizontal: node.text.textAlignHorizontal,
      textAlignVertical: node.text.textAlignVertical,
      paragraphSpacing: node.text.paragraphSpacing,
      paragraphIndent: node.text.paragraphIndent,
    };
  }
  if (isFrameLike(node) && node.layoutGrids) {
    out.layoutGrids = clone(node.layoutGrids);
    out.gridStyleId = node.gridStyleId;
  }
  return out;
}

/** Paints without bindings to variables this document does not have. */
function knownPaints(doc: DesignDocument, paints: Paint[]): Paint[] {
  return paints.map(paint => {
    if (paint.type !== 'SOLID' || !paint.boundVariables?.color || doc.variables[paint.boundVariables.color.id]) return paint;
    const {boundVariables: _unused, ...rest} = paint;
    void _unused;
    return rest;
  });
}

const knownStyle = (doc: DesignDocument, id: StyleId | undefined) => (id && doc.styles[id] ? id : undefined);

/** The fields to write on `target` (null when nothing applies or nothing would change). */
export function propertiesPatch(doc: DesignDocument, target: SceneNode, props: CopiedProperties): Partial<SceneNode> | null {
  if (target.type === 'PAGE') return null;
  const fills = knownPaints(doc, clone(props.fills));
  const patch: Partial<SceneNode> = {
    fills,
    fillStyleId: knownStyle(doc, props.fillStyleId),
    strokes: knownPaints(doc, clone(props.strokes)),
    strokeStyleId: knownStyle(doc, props.strokeStyleId),
    strokeWeight: props.stroke.strokeWeight,
    strokeAlign: props.stroke.strokeAlign,
    strokeCap: props.stroke.strokeCap,
    strokeJoin: props.stroke.strokeJoin,
    strokeMiterLimit: props.stroke.strokeMiterLimit,
    dashPattern: [...props.stroke.dashPattern],
    effects: clone(props.effects),
    effectStyleId: knownStyle(doc, props.effectStyleId),
    opacity: props.opacity,
    blendMode: props.blendMode,
  };
  if (hasSideCorners(target)) patch.individualStrokeWeights = props.stroke.individualStrokeWeights ? {...props.stroke.individualStrokeWeights} : null;
  if (props.corners && hasCorners(target)) {
    patch.cornerRadius = props.corners.cornerRadius ?? 0;
    if (hasSideCorners(target)) {
      patch.rectangleCornerRadii = props.corners.rectangleCornerRadii ? [...props.corners.rectangleCornerRadii] : null;
      patch.cornerSmoothing = props.corners.cornerSmoothing ?? 0;
    }
  }
  if (props.layoutGrids && isFrameLike(target)) {
    patch.layoutGrids = clone(props.layoutGrids);
    patch.gridStyleId = knownStyle(doc, props.gridStyleId);
  }
  if (target.text) {
    let text: TextProps = target.text;
    if (props.text) {
      const runs = text.runs.map(run => {
        const style = {...run.style};
        for (const key of TEXT_STYLE_KEYS) delete style[key];
        const next = {...run, style};
        delete next.textStyleId;
        return next;
      });
      const {hyperlink: _link, ...style} = props.text.style;
      void _link;
      text = applyStyleToRange({...text, runs, textAlignHorizontal: props.text.textAlignHorizontal, textAlignVertical: props.text.textAlignVertical,
        paragraphSpacing: props.text.paragraphSpacing, paragraphIndent: props.text.paragraphIndent}, 0, text.characters.length, clone(style));
      patch.textStyleId = knownStyle(doc, props.text.textStyleId);
    }
    // The copied colour covers the whole text: colours set on ranges give way.
    if (text.runs.some(run => run.fills)) text = applyFillsToRange(text, fills, 0, text.characters.length, fills).text;
    text = normalizeRuns(text, fills);
    if (text !== target.text) patch.text = text;
  }
  // Bindings: the copied fields take the source's (or none); other bindings of the target stay.
  const fields = ['opacity', ...STROKE_FIELDS, ...(props.corners && hasCorners(target) ? CORNER_FIELDS : [])];
  const bound: Record<string, VariableAlias> = {...(target.boundVariables ?? {})};
  for (const field of fields) delete bound[field];
  for (const field of fields) {
    const alias = props.boundVariables[field];
    if (alias && doc.variables[alias.id]) bound[field] = {...alias};
  }
  if (JSON.stringify(bound) !== JSON.stringify(target.boundVariables ?? {})) patch.boundVariables = Object.keys(bound).length ? bound : undefined;
  return changedOnly(target, patch);
}

/** The patch without fields that already hold the same value (an unchanged field records no override). */
function changedOnly(target: SceneNode, patch: Partial<SceneNode>): Partial<SceneNode> | null {
  const out: Record<string, unknown> = {};
  const current = target as unknown as Record<string, unknown>;
  for (const [key, value] of Object.entries(patch)) {
    // null and a missing field both mean "none" (no individual weights, no per-corner radii).
    if (value == null ? current[key] == null : JSON.stringify(current[key]) === JSON.stringify(value)) continue;
    out[key] = value;
  }
  return Object.keys(out).length ? (out as Partial<SceneNode>) : null;
}

/** Writes the properties onto each target inside an open transaction; returns how many changed. */
export function pasteProperties(tx: Transaction, ids: readonly NodeId[], props: CopiedProperties): number {
  for (const [ref, asset] of Object.entries(props.images)) if (!tx.doc.images[ref]) tx.setImage(ref, asset);
  let changed = 0;
  for (const id of ids) {
    const node = tx.get(id);
    const patch = node && propertiesPatch(tx.doc, node, props);
    if (!patch) continue;
    userUpdate(tx, id, patch);
    changed++;
  }
  return changed;
}

// ── Commands ─────────────────────────────────────────────────────────────────────────────────────

let copied: CopiedProperties | null = null;

/** What "Copy properties" holds (tests). */
export const copiedProperties = () => copied;
export const setCopiedProperties = (next: CopiedProperties | null) => {
  copied = next;
};

const targets = (ctx: CommandContext) => {
  const {doc, selection} = ctx.store.getState();
  return selection.filter(id => doc.nodes[id] && doc.nodes[id].type !== 'PAGE');
};

export const PROPERTY_COMMANDS: Command[] = [
  {
    id: 'edit.copy-properties',
    label: 'Copy properties',
    group: 'edit',
    shortcut: {code: 'KeyC', mod: true, alt: true},
    enabled: ctx => targets(ctx).length === 1,
    run: ctx => {
      const [id] = targets(ctx);
      const next = id ? copyProperties(ctx.store.getState().doc, id) : null;
      if (!next) return;
      copied = next;
      notify(ctx.store, 'Properties copied', 'success');
    },
  },
  {
    id: 'edit.paste-properties',
    label: 'Paste properties',
    group: 'edit',
    shortcut: {code: 'KeyV', mod: true, alt: true},
    enabled: ctx => copied !== null && targets(ctx).length > 0,
    run: ctx => {
      const props = copied;
      const ids = targets(ctx);
      if (!props || !ids.length) return;
      ctx.store.transact('Paste properties', tx => void pasteProperties(tx, ids, props));
    },
  },
];

let registered = false;
/** Idempotent. */
export function registerPropertyCommands() {
  if (registered) return;
  registered = true;
  for (const command of PROPERTY_COMMANDS) registerCommand(command);
}
