import type {
  Action, DesignDocument, Easing, Effect, FlowStartingPoint, Matrix, NodeId, OverlayPosition, Paint, PrototypeDevice, Reaction, RGB, RGBA,
  SceneNode, Transition, TransitionDirection, Trigger, Vec,
} from './types';
import {FRAME_LIKE_TYPES} from './types';
import {IDENTITY, localMatrix, multiply, transformRect, translation, type Rect} from './geometry';
import {DESIGN_FIELD_LIMITS} from './document-limits';
import {nextNumberedName} from './tree';

// Prototyping, pure (docs/design-tool.md). The "Prototype" tab, the connections on
// the canvas and the player (src/design/prototype/) share what is here: device presets, easing
// curves, the rules a reaction must follow to play, flows, scrolling geometry, hotspots, the
// session (screens, overlays, history) and smart animate's layer matching and interpolation.
//
// Units follow Figma's plugin API, so a Figma file maps one to one: a transition's `duration` and an
// after-delay trigger's `timeout` are SECONDS (0.3 = 300 ms); the panel shows milliseconds. A key
// trigger's `keyCode` is a shortcut string of src/design/ui/shortcuts.ts ('Enter', 'Shift+KeyA').
// Nothing here touches the DOM.

// ── Defaults ───────────────────────────────────────────────────────────────────────────────────

export const DEFAULT_DURATION = 0.3;
export const DEFAULT_EASING: Easing = 'EASE_OUT';
export const DEFAULT_TIMEOUT = 0.8;
export const DEFAULT_KEY = 'Enter';
/** The scrim behind an overlay when "Dim background" is turned on. */
export const DEFAULT_OVERLAY_BACKGROUND: RGBA = {r: 0, g: 0, b: 0, a: 0.25};
/** The player's backdrop when the page sets none. */
export const DEFAULT_PROTOTYPE_BACKGROUND: RGB = {r: 30 / 255, g: 30 / 255, b: 30 / 255};
/** Longest transition the panel accepts, seconds. */
export const MAX_DURATION = 10;
/** Longest after-delay, seconds. */
export const MAX_TIMEOUT = 3600;
/** Back steps kept by a session. */
export const HISTORY_LIMIT = 100;

// ── Devices ────────────────────────────────────────────────────────────────────────────────────

export type DeviceKind = 'phone' | 'tablet' | 'laptop' | 'desktop';
export type DevicePreset = {
  id: string;
  name: string;
  kind: DeviceKind;
  /** Screen in CSS px, portrait. */
  width: number;
  height: number;
  /** Corner radius of the screen, px. */
  screenRadius: number;
  /** What sits in the screen's top edge: a pill (island), a dot (punch) or nothing. */
  cutout: 'island' | 'punch' | 'none';
};

/** Neutral device frames: sizes of the real screens, no makers' marks. */
export const DEVICE_PRESETS: readonly DevicePreset[] = [
  {id: 'iphone-16', name: 'iPhone 16', kind: 'phone', width: 393, height: 852, screenRadius: 55, cutout: 'island'},
  {id: 'iphone-16-pro-max', name: 'iPhone 16 Pro Max', kind: 'phone', width: 440, height: 956, screenRadius: 60, cutout: 'island'},
  {id: 'android', name: 'Android', kind: 'phone', width: 412, height: 917, screenRadius: 36, cutout: 'punch'},
  {id: 'ipad', name: 'iPad', kind: 'tablet', width: 834, height: 1194, screenRadius: 18, cutout: 'none'},
  {id: 'macbook', name: 'MacBook', kind: 'laptop', width: 1280, height: 832, screenRadius: 10, cutout: 'none'},
  {id: 'desktop', name: 'Desktop', kind: 'desktop', width: 1440, height: 1024, screenRadius: 0, cutout: 'none'},
];

export function devicePreset(device: PrototypeDevice | undefined): DevicePreset | null {
  if (device?.type !== 'PRESET') return null;
  return DEVICE_PRESETS.find(preset => preset.id === device.presetId) ?? null;
}

/** The device's screen as the prototype sees it (turned when rotated), or null without a device. */
export function deviceScreen(device: PrototypeDevice | undefined): {preset: DevicePreset; width: number; height: number; landscape: boolean} | null {
  const preset = devicePreset(device);
  if (!preset || device?.type !== 'PRESET') return null;
  const landscape = device.rotation === 90 && preset.kind !== 'desktop';
  return {preset, width: landscape ? preset.height : preset.width, height: landscape ? preset.width : preset.height, landscape};
}

// ── Easing ─────────────────────────────────────────────────────────────────────────────────────

export type SpringParams = {mass: number; stiffness: number; damping: number};
type Bezier = readonly [number, number, number, number];

/** Curves of the eased presets (the CSS values Figma uses). */
export const BEZIER_EASINGS: Readonly<Partial<Record<Easing, Bezier>>> = {
  LINEAR: [0, 0, 1, 1],
  EASE_IN: [0.42, 0, 1, 1],
  EASE_OUT: [0, 0, 0.58, 1],
  EASE_IN_AND_OUT: [0.42, 0, 0.58, 1],
  EASE_IN_BACK: [0.3, -0.05, 0.7, -0.5],
  EASE_OUT_BACK: [0.45, 1.45, 0.8, 1],
};

/** Figma's spring presets. A spring decides its own duration (`springDuration`). */
export const SPRING_EASINGS: Readonly<Partial<Record<Easing, SpringParams>>> = {
  GENTLE: {mass: 1, stiffness: 100, damping: 15},
  QUICK: {mass: 1, stiffness: 300, damping: 20},
  BOUNCY: {mass: 1, stiffness: 600, damping: 15},
  SLOW: {mass: 1, stiffness: 80, damping: 20},
};

export const isSpringEasing = (easing: Easing) => !!SPRING_EASINGS[easing];

/** A CSS cubic-bezier as a function of progress (0..1 → value, which may leave 0..1 between the ends). */
export function cubicBezier(x1: number, y1: number, x2: number, y2: number): (x: number) => number {
  const cx = 3 * x1, bx = 3 * (x2 - x1) - cx, ax = 1 - cx - bx;
  const cy = 3 * y1, by = 3 * (y2 - y1) - cy, ay = 1 - cy - by;
  const sampleX = (t: number) => ((ax * t + bx) * t + cx) * t;
  const sampleY = (t: number) => ((ay * t + by) * t + cy) * t;
  const slopeX = (t: number) => (3 * ax * t + 2 * bx) * t + cx;
  const solve = (x: number) => {
    let t = x;
    for (let i = 0; i < 8; i++) {
      const error = sampleX(t) - x;
      if (Math.abs(error) < 1e-7) return t;
      const slope = slopeX(t);
      if (Math.abs(slope) < 1e-6) break;
      t -= error / slope;
    }
    let low = 0, high = 1;
    t = x;
    for (let i = 0; i < 64 && high - low > 1e-7; i++) {
      const value = sampleX(t);
      if (Math.abs(value - x) < 1e-7) return t;
      if (x > value) low = t;
      else high = t;
      t = (low + high) / 2;
    }
    return t;
  };
  return x => (x <= 0 ? 0 : x >= 1 ? 1 : sampleY(solve(x)));
}

/** Position of a unit spring released from 0 towards 1 after `seconds`. */
export function springValue({mass, stiffness, damping}: SpringParams, seconds: number): number {
  if (!(seconds > 0)) return 0;
  const w0 = Math.sqrt(stiffness / mass);
  const zeta = damping / (2 * Math.sqrt(stiffness * mass));
  const t = seconds;
  if (zeta < 1) {
    const wd = w0 * Math.sqrt(1 - zeta * zeta);
    return 1 - Math.exp(-zeta * w0 * t) * (Math.cos(wd * t) + ((zeta * w0) / wd) * Math.sin(wd * t));
  }
  if (zeta === 1) return 1 - Math.exp(-w0 * t) * (1 + w0 * t);
  const s = Math.sqrt(zeta * zeta - 1);
  const r1 = -w0 * (zeta - s), r2 = -w0 * (zeta + s);
  return 1 - (r2 * Math.exp(r1 * t) - r1 * Math.exp(r2 * t)) / (r2 - r1);
}

const springDurations = new Map<SpringParams, number>();
/** How long a spring moves: the last moment it is farther than 0.1 % from rest, seconds. */
export function springDuration(params: SpringParams): number {
  const known = springDurations.get(params);
  if (known !== undefined) return known;
  let last = 0;
  for (let ms = 1; ms <= 10_000; ms++) if (Math.abs(springValue(params, ms / 1000) - 1) > 0.001) last = ms;
  const seconds = Math.round(last + 1) / 1000;
  springDurations.set(params, seconds);
  return seconds;
}

const bezierFunctions = new Map<Easing, (x: number) => number>();
/** The eased value at `progress` (0..1 of the transition's duration). Back and spring curves overshoot. */
export function evaluateEasing(easing: Easing, progress: number): number {
  if (progress <= 0) return 0;
  if (progress >= 1) return 1;
  const spring = SPRING_EASINGS[easing];
  if (spring) return springValue(spring, progress * springDuration(spring));
  let fn = bezierFunctions.get(easing);
  if (!fn) {
    const curve = BEZIER_EASINGS[easing] ?? BEZIER_EASINGS.EASE_OUT!;
    bezierFunctions.set(easing, (fn = cubicBezier(curve[0], curve[1], curve[2], curve[3])));
  }
  return fn(progress);
}

/** Seconds a transition plays (a spring's own length; 0 for INSTANT). */
export function transitionDuration(transition: Transition): number {
  if (transition.type === 'INSTANT') return 0;
  const spring = SPRING_EASINGS[transition.easing];
  if (spring) return springDuration(spring);
  return Number.isFinite(transition.duration) ? Math.min(MAX_DURATION, Math.max(0, transition.duration)) : DEFAULT_DURATION;
}

/** SVG path data of the curve in a `width` × `height` box: time runs right, the value up; overshoot
 *  stays inside the box (the 0 and 1 lines move in to make room). Also returns where 0 and 1 are. */
export function easingPath(easing: Easing, width: number, height: number, samples = 64): {d: string; zeroY: number; oneY: number} {
  const values: number[] = [];
  for (let i = 0; i <= samples; i++) values.push(evaluateEasing(easing, i / samples));
  const low = Math.min(0, ...values), high = Math.max(1, ...values);
  const y = (value: number) => height - ((value - low) / (high - low)) * height;
  const d = values.map((value, i) => `${i ? 'L' : 'M'}${round2((i / samples) * width)} ${round2(y(value))}`).join('');
  return {d, zeroY: round2(y(0)), oneY: round2(y(1))};
}

/** The easing as a CSS timing function (`linear(…)` samples for springs). */
export function easingCss(easing: Easing): string {
  const curve = BEZIER_EASINGS[easing];
  if (curve) return `cubic-bezier(${curve.join(', ')})`;
  const points: string[] = [];
  for (let i = 0; i <= 40; i++) points.push(String(round4(evaluateEasing(easing, i / 40))));
  return `linear(${points.join(', ')})`;
}

const round2 = (value: number) => Math.round(value * 100) / 100;
const round4 = (value: number) => Math.round(value * 10_000) / 10_000;

// ── Transitions, triggers, actions ─────────────────────────────────────────────────────────────

export type TransitionType = Transition['type'];
export type TriggerType = Trigger['type'];
export type ActionKind = 'NAVIGATE' | 'OVERLAY' | 'SWAP' | 'SCROLL_TO' | 'CHANGE_TO' | 'BACK' | 'CLOSE' | 'URL';
export type NodeAction = Extract<Action, {type: 'NODE'}>;

export const DIRECTIONAL_TRANSITIONS: readonly TransitionType[] = ['MOVE_IN', 'MOVE_OUT', 'PUSH', 'SLIDE_IN', 'SLIDE_OUT'];
export const isDirectional = (type: TransitionType) => DIRECTIONAL_TRANSITIONS.includes(type);
export const actionKind = (action: Action): ActionKind => (action.type === 'NODE' ? action.navigation : action.type);
export const needsDestination = (kind: ActionKind) => kind === 'NAVIGATE' || kind === 'OVERLAY' || kind === 'SWAP' || kind === 'SCROLL_TO' || kind === 'CHANGE_TO';

/** Animations each action can play. */
export function transitionsFor(kind: ActionKind): readonly TransitionType[] {
  if (kind === 'SCROLL_TO') return ['INSTANT', 'SMART_ANIMATE'];
  if (kind === 'CHANGE_TO') return ['INSTANT', 'DISSOLVE', 'SMART_ANIMATE'];
  if (needsDestination(kind)) return ['INSTANT', 'DISSOLVE', 'SMART_ANIMATE', ...DIRECTIONAL_TRANSITIONS];
  return [];
}

/** A transition of `type`, keeping the duration, easing and direction of `previous` where they apply. */
export function makeTransition(type: TransitionType, previous?: Transition): Transition {
  if (type === 'INSTANT') return {type};
  const duration = previous && previous.type !== 'INSTANT' ? previous.duration : DEFAULT_DURATION;
  const easing = previous && previous.type !== 'INSTANT' ? previous.easing : DEFAULT_EASING;
  if (type === 'DISSOLVE' || type === 'SMART_ANIMATE') return {type, duration, easing};
  const direction: TransitionDirection = previous && 'direction' in previous ? previous.direction : 'LEFT';
  return {type, direction, duration, easing};
}

const OPPOSITE: Record<TransitionDirection, TransitionDirection> = {LEFT: 'RIGHT', RIGHT: 'LEFT', TOP: 'BOTTOM', BOTTOM: 'TOP'};
/** What "Back" plays after a transition: the same motion run the other way. */
export function reverseTransition(transition: Transition): Transition {
  switch (transition.type) {
    case 'MOVE_IN': return {...transition, type: 'MOVE_OUT', direction: OPPOSITE[transition.direction]};
    case 'MOVE_OUT': return {...transition, type: 'MOVE_IN', direction: OPPOSITE[transition.direction]};
    case 'SLIDE_IN': return {...transition, type: 'SLIDE_OUT', direction: OPPOSITE[transition.direction]};
    case 'SLIDE_OUT': return {...transition, type: 'SLIDE_IN', direction: OPPOSITE[transition.direction]};
    case 'PUSH': return {...transition, direction: OPPOSITE[transition.direction]};
    default: return transition;
  }
}

/** The direction a layer travels, as a unit vector (LEFT: towards the left edge). */
export function directionVector(direction: TransitionDirection): Vec {
  return direction === 'LEFT' ? {x: -1, y: 0} : direction === 'RIGHT' ? {x: 1, y: 0} : direction === 'TOP' ? {x: 0, y: -1} : {x: 0, y: 1};
}

export function makeTrigger(type: TriggerType, previous?: Trigger): Trigger {
  if (type === 'AFTER_TIMEOUT') return {type, timeout: previous?.type === 'AFTER_TIMEOUT' ? previous.timeout : DEFAULT_TIMEOUT};
  if (type === 'ON_KEY_DOWN') return {type, keyCode: previous?.type === 'ON_KEY_DOWN' ? previous.keyCode : DEFAULT_KEY};
  return {type};
}

/** An action of `kind` carrying over what still fits from `previous`. Null when the action cannot be
 *  stored yet: a destination is needed and none fits, or a link has no valid address. The panel keeps
 *  such an action as a draft until it is complete, so a stored document never holds a broken one. */
export function makeAction(doc: DesignDocument, sourceId: NodeId, kind: ActionKind, previous?: Action | null, destinationId?: NodeId | null): Action | null {
  if (kind === 'BACK') return {type: 'BACK'};
  if (kind === 'CLOSE') return {type: 'CLOSE'};
  if (kind === 'URL') {
    const url = previous?.type === 'URL' ? previous.url : '';
    return isSafeUrl(url) ? {type: 'URL', url, openInNewTab: previous?.type === 'URL' ? previous.openInNewTab : true} : null;
  }
  const keep = previous?.type === 'NODE' ? previous : null;
  const destination = destinationId ?? keep?.destinationId ?? null;
  if (!destination) return null;
  const allowed = transitionsFor(kind);
  const transition = keep && allowed.includes(keep.transition.type) ? keep.transition : keep && keep.transition.type !== 'INSTANT' && allowed.includes('SMART_ANIMATE') ? makeTransition('SMART_ANIMATE', keep.transition) : {type: 'INSTANT' as const};
  const action: NodeAction = {type: 'NODE', navigation: kind, destinationId: destination, transition};
  if (keep?.overlayRelativePosition && (kind === 'OVERLAY' || kind === 'SWAP')) action.overlayRelativePosition = keep.overlayRelativePosition;
  if (keep?.preserveScrollPosition && kind === 'NAVIGATE') action.preserveScrollPosition = true;
  return actionIssue(doc, sourceId, action) ? null : action;
}

/** "On click → Navigate to …" with an instant transition (smart animate is opt-in). */
/** Overlay destinations of `reaction` whose overlay settings were never set (not the source itself): the editor turns on
 *  "Close when clicking outside" for them when they are first opened as an overlay, as Figma does. */
export function newOverlayFrames(doc: DesignDocument, sourceId: NodeId, reaction: Reaction): NodeId[] {
  const out: NodeId[] = [];
  for (const action of reaction.actions) {
    if (action.type !== 'NODE' || (action.navigation !== 'OVERLAY' && action.navigation !== 'SWAP')) continue;
    const frame = doc.nodes[action.destinationId];
    if (frame && frame.id !== sourceId && frame.overlayBackgroundInteraction === undefined && !out.includes(frame.id)) out.push(frame.id);
  }
  return out;
}

export function defaultReaction(destinationId: NodeId | null): Reaction {
  return {trigger: {type: 'ON_CLICK'}, actions: destinationId ? [{type: 'NODE', navigation: 'NAVIGATE', destinationId, transition: {type: 'INSTANT'}}] : []};
}

/** Prototype links: http(s) and mailto only (the schema's rule, without loading the schema). */
export function isSafeUrl(value: string): boolean {
  if (typeof value !== 'string' || !value || value.length > DESIGN_FIELD_LIMITS.url) return false;
  try {
    return ['http:', 'https:', 'mailto:'].includes(new URL(value).protocol);
  } catch {
    return false;
  }
}

// ── Frames and validation ──────────────────────────────────────────────────────────────────────

const isFrameLike = (node: SceneNode | undefined) => !!node && FRAME_LIKE_TYPES.includes(node.type);

/** A frame standing on the page (or in a section on it): what flows, navigation and overlays use. */
export function isTopLevelFrame(doc: DesignDocument, id: NodeId): boolean {
  const node = doc.nodes[id];
  if (!isFrameLike(node) || node.type === 'COMPONENT_SET') return false;
  let parent = node.parentId ? doc.nodes[node.parentId] : undefined;
  for (let guard = 0; parent && parent.type === 'SECTION' && guard < 64; guard++) parent = parent.parentId ? doc.nodes[parent.parentId] : undefined;
  return parent?.type === 'PAGE';
}

/** The top-level frame a node is in (itself when it is one), or null. */
export function topLevelFrameOf(doc: DesignDocument, id: NodeId): NodeId | null {
  for (let node = doc.nodes[id], guard = 0; node && guard < 10_000; node = node.parentId ? doc.nodes[node.parentId] : (undefined as never), guard++) {
    if (isTopLevelFrame(doc, node.id)) return node.id;
  }
  return null;
}

export function pageOfNode(doc: DesignDocument, id: NodeId): NodeId | null {
  let node = doc.nodes[id];
  for (let guard = 0; node && node.type !== 'PAGE' && guard < 10_000; guard++) node = node.parentId ? doc.nodes[node.parentId] : (undefined as never);
  return node?.type === 'PAGE' ? node.id : null;
}

/** Top-level frames of a page in the layers panel's order (topmost first), sections opened. */
export function topLevelFrames(doc: DesignDocument, pageId: NodeId): NodeId[] {
  const out: NodeId[] = [];
  const visit = (id: NodeId, depth: number) => {
    const children = doc.nodes[id]?.children ?? [];
    for (let i = children.length - 1; i >= 0; i--) {
      const child = doc.nodes[children[i]];
      if (!child) continue;
      if (child.type === 'SECTION' && depth < 64) visit(child.id, depth + 1);
      else if (isTopLevelFrame(doc, child.id)) out.push(child.id);
    }
  };
  visit(pageId, 0);
  return out;
}

/** The variant set a CHANGE_TO destination belongs to, or null when it is not a variant. */
function variantSetOf(doc: DesignDocument, id: NodeId): NodeId | null {
  const node = doc.nodes[id];
  const parent = node?.parentId ? doc.nodes[node.parentId] : undefined;
  return node?.type === 'COMPONENT' && parent?.type === 'COMPONENT_SET' ? parent.id : null;
}

/** The instance a CHANGE_TO acts on: the nearest instance at or above the source showing a variant of
 *  the destination's set. Null when there is none (a main component itself does not change). */
export function changeTarget(doc: DesignDocument, sourceId: NodeId, destinationId: NodeId): NodeId | null {
  const set = variantSetOf(doc, destinationId);
  if (!set) return null;
  for (let node = doc.nodes[sourceId], guard = 0; node && guard < 10_000; node = node.parentId ? doc.nodes[node.parentId] : (undefined as never), guard++) {
    if (node.type === 'INSTANCE' && node.componentId && variantSetOf(doc, node.componentId) === set) return node.id;
  }
  return null;
}

/** Whether the source sits in a variant of `setId` (or an instance of one): CHANGE_TO is offered there. */
function inVariantOf(doc: DesignDocument, sourceId: NodeId, setId: NodeId): boolean {
  for (let node = doc.nodes[sourceId], guard = 0; node && guard < 10_000; node = node.parentId ? doc.nodes[node.parentId] : (undefined as never), guard++) {
    if (node.type === 'COMPONENT' && node.parentId === setId) return true;
    if (node.type === 'INSTANCE' && node.componentId && variantSetOf(doc, node.componentId) === setId) return true;
  }
  return false;
}

/** The variants a CHANGE_TO from this source may pick (its own set), or [] when the source is in none. */
export function changeDestinations(doc: DesignDocument, sourceId: NodeId): NodeId[] {
  for (let node = doc.nodes[sourceId], guard = 0; node && guard < 10_000; node = node.parentId ? doc.nodes[node.parentId] : (undefined as never), guard++) {
    const set = node.type === 'COMPONENT' ? variantSetOf(doc, node.id) : node.type === 'INSTANCE' && node.componentId ? variantSetOf(doc, node.componentId) : null;
    if (set) return (doc.nodes[set]?.children ?? []).filter(id => doc.nodes[id]?.type === 'COMPONENT');
  }
  return [];
}

/** Layers a SCROLL_TO from this source may target: everything inside its top-level frame. */
export function scrollDestinations(doc: DesignDocument, sourceId: NodeId, limit = 2000): NodeId[] {
  const root = topLevelFrameOf(doc, sourceId);
  if (!root) return [];
  const out: NodeId[] = [];
  const stack = [...(doc.nodes[root]?.children ?? [])].reverse();
  while (stack.length && out.length < limit) {
    const id = stack.pop()!;
    const node = doc.nodes[id];
    if (!node) continue;
    out.push(id);
    if (node.children && node.type !== 'INSTANCE' && node.type !== 'BOOLEAN_OPERATION') for (let i = node.children.length - 1; i >= 0; i--) stack.push(node.children[i]);
  }
  return out;
}

export type ReactionIssueCode = 'no_action' | 'missing_destination' | 'not_top_level' | 'other_page' | 'scroll_outside' | 'not_variant' | 'unsafe_url' | 'bad_timeout' | 'bad_key';
export type ReactionIssue = {code: ReactionIssueCode; message: string; actionIndex?: number};

const ISSUE_TEXT: Record<ReactionIssueCode, string> = {
  no_action: 'Choose an action.',
  missing_destination: 'The destination layer no longer exists.',
  not_top_level: 'You can navigate only to a top-level frame.',
  other_page: 'The destination frame is on another page.',
  scroll_outside: 'You can scroll only to a layer of the same frame.',
  not_variant: 'Choose a variant from this component\'s set.',
  unsafe_url: 'The link must start with http://, https:// or mailto:.',
  bad_timeout: 'The delay must be between 0 and 3600 seconds.',
  bad_key: 'Choose a key.',
};
const issue = (code: ReactionIssueCode, actionIndex?: number): ReactionIssue => ({code, message: ISSUE_TEXT[code], ...(actionIndex === undefined ? {} : {actionIndex})});

/** Why an action cannot play from `sourceId`, or null when it can. */
export function actionIssue(doc: DesignDocument, sourceId: NodeId, action: Action, actionIndex?: number): ReactionIssue | null {
  if (action.type === 'URL') return isSafeUrl(action.url) ? null : issue('unsafe_url', actionIndex);
  if (action.type !== 'NODE') return null;
  const destination = doc.nodes[action.destinationId];
  if (!destination) return issue('missing_destination', actionIndex);
  switch (action.navigation) {
    case 'NAVIGATE':
    case 'OVERLAY':
    case 'SWAP':
      if (!isTopLevelFrame(doc, destination.id)) return issue('not_top_level', actionIndex);
      if (pageOfNode(doc, destination.id) !== pageOfNode(doc, sourceId)) return issue('other_page', actionIndex);
      return null;
    case 'SCROLL_TO': {
      const root = topLevelFrameOf(doc, sourceId);
      return root && root !== destination.id && topLevelFrameOf(doc, destination.id) === root ? null : issue('scroll_outside', actionIndex);
    }
    case 'CHANGE_TO': {
      const set = variantSetOf(doc, destination.id);
      return set && inVariantOf(doc, sourceId, set) ? null : issue('not_variant', actionIndex);
    }
  }
  return null;
}

/** Everything that keeps a reaction from playing as stored. */
export function reactionIssues(doc: DesignDocument, sourceId: NodeId, reaction: Reaction): ReactionIssue[] {
  const out: ReactionIssue[] = [];
  const {trigger} = reaction;
  if (trigger.type === 'AFTER_TIMEOUT' && !(Number.isFinite(trigger.timeout) && trigger.timeout >= 0 && trigger.timeout <= MAX_TIMEOUT)) out.push(issue('bad_timeout'));
  if (trigger.type === 'ON_KEY_DOWN' && !trigger.keyCode) out.push(issue('bad_key'));
  if (!reaction.actions.length) out.push(issue('no_action'));
  reaction.actions.forEach((action, i) => {
    const found = actionIssue(doc, sourceId, action, i);
    if (found) out.push(found);
  });
  return out;
}

/** The actions of a reaction that can play; the rest are skipped by the player. */
export function playableActions(doc: DesignDocument, sourceId: NodeId, reaction: Reaction): Action[] {
  return reaction.actions.filter(action => !actionIssue(doc, sourceId, action));
}

// ── Connections (the canvas draws one per NODE action) ─────────────────────────────────────────

export type Connection = {sourceId: NodeId; reactionIndex: number; actionIndex: number; destinationId: NodeId; kind: ActionKind};

/** The node's actions that point at a layer, whether or not the layer still exists. */
export function connectionsOf(node: SceneNode): Connection[] {
  const out: Connection[] = [];
  node.reactions?.forEach((reaction, reactionIndex) => reaction.actions.forEach((action, actionIndex) => {
    if (action.type === 'NODE') out.push({sourceId: node.id, reactionIndex, actionIndex, destinationId: action.destinationId, kind: action.navigation});
  }));
  return out;
}

// ── Flows ──────────────────────────────────────────────────────────────────────────────────────

/** The page's flows whose starting frame still exists as a top-level frame on it. */
export function flowStartingPoints(doc: DesignDocument, pageId: NodeId): FlowStartingPoint[] {
  return (doc.nodes[pageId]?.flowStartingPoints ?? []).filter(point => isTopLevelFrame(doc, point.nodeId) && pageOfNode(doc, point.nodeId) === pageId);
}

/** The page's list with a flow starting at `nodeId` added ("Flow N"), or unchanged when it already is one. */
export function withFlowAdded(doc: DesignDocument, pageId: NodeId, nodeId: NodeId, name?: string): FlowStartingPoint[] {
  return withFlowsAdded(doc, pageId, [nodeId], name);
}

/** The page's list with a flow added for each top-level frame in `nodeIds` that does not start one yet. */
export function withFlowsAdded(doc: DesignDocument, pageId: NodeId, nodeIds: readonly NodeId[], name?: string): FlowStartingPoint[] {
  const original = doc.nodes[pageId]?.flowStartingPoints ?? [];
  let list = original;
  for (const nodeId of nodeIds) {
    if (list.some(point => point.nodeId === nodeId) || !isTopLevelFrame(doc, nodeId)) continue;
    const fresh = (nodeIds.length === 1 && name?.trim()) || nextNumberedName('Flow', list.map(point => point.name));
    list = [...list, {nodeId, name: fresh.slice(0, DESIGN_FIELD_LIMITS.name)}];
  }
  return list;
}

export function withFlowRenamed(list: readonly FlowStartingPoint[], nodeId: NodeId, name: string): FlowStartingPoint[] {
  const trimmed = name.trim().slice(0, DESIGN_FIELD_LIMITS.name);
  return list.map(point => (point.nodeId === nodeId && trimmed ? {...point, name: trimmed} : point));
}

export function withFlowRemoved(list: readonly FlowStartingPoint[], nodeId: NodeId): FlowStartingPoint[] {
  return list.filter(point => point.nodeId !== nodeId);
}

/** Frames of a flow in the order a viewer meets them: breadth first from the start along "Navigate to",
 *  each frame's links read top to bottom, left to right. The player's ←/→ walk this list. */
export function flowFrames(doc: DesignDocument, startId: NodeId, limit = 500): NodeId[] {
  if (!isTopLevelFrame(doc, startId)) return [];
  const order = [startId];
  const seen = new Set(order);
  for (let i = 0; i < order.length && order.length < limit; i++) {
    for (const destination of navigationTargets(doc, order[i])) {
      if (seen.has(destination) || !isTopLevelFrame(doc, destination)) continue;
      seen.add(destination);
      order.push(destination);
    }
  }
  return order;
}

/** Destinations of "Navigate to" inside a frame, in reading order of their sources. */
function navigationTargets(doc: DesignDocument, frameId: NodeId): NodeId[] {
  const found: {y: number; x: number; order: number; destination: NodeId}[] = [];
  const walk = (id: NodeId, m: Matrix, depth: number) => {
    const node = doc.nodes[id];
    if (!node || node.visible === false || depth > 256) return;
    const box = transformRect(m, {x: 0, y: 0, width: node.width, height: node.height});
    for (const reaction of node.reactions ?? []) for (const action of reaction.actions) {
      if (action.type === 'NODE' && action.navigation === 'NAVIGATE') found.push({y: box.y, x: box.x, order: found.length, destination: action.destinationId});
    }
    for (const child of node.children ?? []) {
      const c = doc.nodes[child];
      if (c) walk(child, multiply(m, localMatrix(c)), depth + 1);
    }
  };
  walk(frameId, IDENTITY, 0);
  found.sort((a, b) => a.y - b.y || a.x - b.x || a.order - b.order);
  return found.map(entry => entry.destination);
}

/** The flow a frame belongs to on its page: the one starting there, else the first that reaches it. */
export function flowOf(doc: DesignDocument, frameId: NodeId): FlowStartingPoint | null {
  const pageId = pageOfNode(doc, frameId);
  if (!pageId) return null;
  const flows = flowStartingPoints(doc, pageId);
  return flows.find(flow => flow.nodeId === frameId) ?? flows.find(flow => flowFrames(doc, flow.nodeId).includes(frameId)) ?? null;
}

/** What ▶ presents: the selected layer's top-level frame, else the page's first flow, else its first frame. */
export function playTarget(doc: DesignDocument, pageId: NodeId, selection: readonly NodeId[]): NodeId | null {
  for (const id of selection) {
    const frame = topLevelFrameOf(doc, id);
    if (frame && pageOfNode(doc, frame) === pageId) return frame;
  }
  return flowStartingPoints(doc, pageId)[0]?.nodeId ?? topLevelFrames(doc, pageId)[0] ?? null;
}

// ── Scrolling and placement ────────────────────────────────────────────────────────────────────

/** Scroll offsets by container id (content moves up/left by the offset). */
export type ScrollOffsets = Readonly<Record<NodeId, Vec>>;
export type Size = {width: number; height: number};
const ZERO: Vec = {x: 0, y: 0};

/** Where a frame scrolls: its "Scrolling" setting; a top-level frame taller than the screen also scrolls down. */
export function scrollAxes(node: SceneNode, view?: Size): {x: boolean; y: boolean} {
  const direction = node.overflowDirection ?? 'NONE';
  const x = direction === 'HORIZONTAL' || direction === 'BOTH';
  const y = direction === 'VERTICAL' || direction === 'BOTH' || (!!view && node.height > view.height + 0.5);
  return {x, y};
}

/** The area a container's content covers in its own space: its box and its children's boxes. */
export function contentBounds(doc: DesignDocument, id: NodeId): Rect {
  const node = doc.nodes[id];
  let left = 0, top = 0, right = node?.width ?? 0, bottom = node?.height ?? 0;
  for (const childId of node?.children ?? []) {
    const child = doc.nodes[childId];
    if (!child || child.visible === false || child.scrollBehavior === 'FIXED') continue;
    const box = transformRect(localMatrix(child), {x: 0, y: 0, width: child.width, height: child.height});
    left = Math.min(left, box.x);
    top = Math.min(top, box.y);
    right = Math.max(right, box.x + box.width);
    bottom = Math.max(bottom, box.y + box.height);
  }
  return {x: left, y: top, width: right - left, height: bottom - top};
}

/** The visible part of a container: its box, or for a session's root the screen (`rootView`). */
export const viewOf = (node: SceneNode, rootView?: Size): Size => rootView ?? {width: node.width, height: node.height};

/** How far a container scrolls on each axis (0 where it does not). */
export function maxScroll(doc: DesignDocument, id: NodeId, view: Size, isRoot = false): Vec {
  const node = doc.nodes[id];
  if (!node || !(isFrameLike(node))) return ZERO;
  const axes = scrollAxes(node, isRoot ? view : undefined);
  if (!axes.x && !axes.y) return ZERO;
  const content = contentBounds(doc, id);
  return {
    x: axes.x ? Math.max(0, content.x + content.width - view.width) : 0,
    y: axes.y ? Math.max(0, content.y + content.height - view.height) : 0,
  };
}

export const isScrollContainer = (doc: DesignDocument, id: NodeId, view: Size, isRoot = false) => {
  const max = maxScroll(doc, id, view, isRoot);
  return max.x > 0 || max.y > 0;
};

export function clampScroll(offset: Vec, max: Vec): Vec {
  const x = Math.min(max.x, Math.max(0, offset.x)), y = Math.min(max.y, Math.max(0, offset.y));
  return x === offset.x && y === offset.y ? offset : {x, y};
}

const negate = (value: number) => (value ? -value : 0);

/** The shift a scrolling parent applies to a child: the whole offset, none for "Fixed", and
 *  for "Sticky" only until the child reaches the parent's top or left edge. */
export function scrollShift(child: SceneNode, offset: Vec | undefined): Vec {
  if (!offset || (!offset.x && !offset.y) || child.scrollBehavior === 'FIXED') return ZERO;
  if (child.scrollBehavior === 'STICKY_SCROLLS') return {x: negate(Math.min(offset.x, Math.max(0, child.x))), y: negate(Math.min(offset.y, Math.max(0, child.y)))};
  return {x: negate(offset.x), y: negate(offset.y)};
}

/** Child space → parent space with the parent's scroll applied. */
export function placedLocal(child: SceneNode, parentScroll: Vec | undefined): Matrix {
  const shift = scrollShift(child, parentScroll);
  const local = localMatrix(child);
  return shift.x || shift.y ? multiply(translation(shift.x, shift.y), local) : local;
}

/** A node's space → its session root's space, scroll offsets applied. Null when it is not under the root. */
export function placedMatrix(doc: DesignDocument, rootId: NodeId, id: NodeId, scroll: ScrollOffsets): Matrix | null {
  const chain: SceneNode[] = [];
  let node = doc.nodes[id];
  for (let guard = 0; node && node.id !== rootId && guard < 10_000; guard++) {
    chain.push(node);
    node = node.parentId ? doc.nodes[node.parentId] : (undefined as never);
  }
  if (!node) return null;
  let m = IDENTITY;
  for (let i = chain.length - 1; i >= 0; i--) {
    const parentId = chain[i].parentId!;
    m = multiply(m, placedLocal(chain[i], scroll[parentId]));
  }
  return m;
}

/** Scroll containers above a node (innermost first, the root last when it scrolls). */
export function scrollAncestors(doc: DesignDocument, rootId: NodeId, id: NodeId, rootView: Size): NodeId[] {
  const out: NodeId[] = [];
  let node = doc.nodes[id];
  for (let guard = 0; node && node.id !== rootId && guard < 10_000; guard++) {
    const parent = node.parentId ? doc.nodes[node.parentId] : undefined;
    if (!parent) return [];
    const isRoot = parent.id === rootId;
    if (isScrollContainer(doc, parent.id, isRoot ? rootView : viewOf(parent), isRoot)) out.push(parent.id);
    node = parent;
  }
  return node ? out : [];
}

/** Offsets that bring `destinationId` to the top left of each container it scrolls in ("Scroll to"). */
export function scrollToTargets(doc: DesignDocument, rootId: NodeId, destinationId: NodeId, rootView: Size, current: ScrollOffsets): ScrollOffsets {
  const targets: Record<NodeId, Vec> = {...current};
  for (const containerId of scrollAncestors(doc, rootId, destinationId, rootView)) {
    targets[containerId] = ZERO;
    const m = placedMatrix(doc, containerId, destinationId, targets);
    if (!m) continue;
    const isRoot = containerId === rootId;
    const container = doc.nodes[containerId]!;
    const view = isRoot ? rootView : viewOf(container);
    const box = transformRect(m, {x: 0, y: 0, width: doc.nodes[destinationId]!.width, height: doc.nodes[destinationId]!.height});
    targets[containerId] = clampScroll({x: box.x, y: box.y}, maxScroll(doc, containerId, view, isRoot));
  }
  return targets;
}

// ── Hotspots ───────────────────────────────────────────────────────────────────────────────────

export type Hotspot = {
  id: NodeId;
  /** Node space → root space (scroll applied). */
  matrix: Matrix;
  width: number;
  height: number;
  /** Root-space rectangle the hotspot is visible through (its clipping ancestors and the screen). */
  clip: Rect;
  /** Root-space bounds of the box, clipped. */
  rect: Rect;
};

/** Layers with reactions under a root, topmost first, each where it shows now. The root counts too. */
export function hotspotsOf(doc: DesignDocument, rootId: NodeId, scroll: ScrollOffsets, rootView: Size): Hotspot[] {
  const out: Hotspot[] = [];
  const root = doc.nodes[rootId];
  if (!root) return out;
  const screen: Rect = {x: 0, y: 0, width: rootView.width, height: rootView.height};
  const walk = (node: SceneNode, m: Matrix, clip: Rect, depth: number) => {
    if (node.visible === false || depth > 256) return;
    if (node.reactions?.length) {
      const box = transformRect(m, {x: 0, y: 0, width: node.width, height: node.height});
      const rect = intersectRect(box, clip);
      if (rect) out.push({id: node.id, matrix: m, width: node.width, height: node.height, clip, rect});
    }
    if (!node.children || node.type === 'BOOLEAN_OPERATION') return;
    const own = node.id === rootId ? screen : isFrameLike(node) && node.clipsContent !== false ? transformRect(m, {x: 0, y: 0, width: node.width, height: node.height}) : null;
    const inner = own ? intersectRect(clip, own) : clip;
    if (!inner) return;
    const offset = scroll[node.id];
    for (const childId of paintOrderOf(node)) {
      const child = doc.nodes[childId];
      if (child) walk(child, multiply(m, placedLocal(child, offset)), inner, depth + 1);
    }
  };
  walk(root, IDENTITY, screen, 0);
  return out.reverse();
}

const paintOrderOf = (node: SceneNode): readonly NodeId[] =>
  node.autoLayout?.itemReverseZIndex && node.autoLayout.layoutMode !== 'NONE' && (node.children?.length ?? 0) > 1 ? [...node.children!].reverse() : node.children ?? [];

export function intersectRect(a: Rect, b: Rect): Rect | null {
  const x = Math.max(a.x, b.x), y = Math.max(a.y, b.y);
  const right = Math.min(a.x + a.width, b.x + b.width), bottom = Math.min(a.y + a.height, b.y + b.height);
  return right >= x && bottom >= y ? {x, y, width: right - x, height: bottom - y} : null;
}

/** Whether a root-space point is on the hotspot's box and inside its clip. */
export function hotspotContains(hotspot: Hotspot, point: Vec): boolean {
  const {clip} = hotspot;
  if (point.x < clip.x || point.y < clip.y || point.x > clip.x + clip.width || point.y > clip.y + clip.height) return false;
  const [[a, c, e], [b, d, f]] = hotspot.matrix;
  const det = a * d - b * c;
  if (!det) return false;
  const px = point.x - e, py = point.y - f;
  const lx = (d * px - c * py) / det, ly = (a * py - b * px) / det;
  return lx >= 0 && ly >= 0 && lx <= hotspot.width && ly <= hotspot.height;
}

/** Hotspots under a point, topmost first. */
export const hotspotsAt = (hotspots: readonly Hotspot[], point: Vec): Hotspot[] => hotspots.filter(hotspot => hotspotContains(hotspot, point));

// ── Overlays ───────────────────────────────────────────────────────────────────────────────────

/** Top-left of an overlay on the screen (root space) for its position setting. MANUAL uses the anchor
 *  the session stored when it opened (the trigger's corner plus the action's offset). */
export function overlayOrigin(position: OverlayPosition | undefined, overlay: Size, screen: Size, anchor?: Vec): Vec {
  const centreX = (screen.width - overlay.width) / 2, centreY = (screen.height - overlay.height) / 2;
  switch (position ?? 'CENTER') {
    case 'TOP_LEFT': return {x: 0, y: 0};
    case 'TOP_CENTER': return {x: centreX, y: 0};
    case 'TOP_RIGHT': return {x: screen.width - overlay.width, y: 0};
    case 'BOTTOM_LEFT': return {x: 0, y: screen.height - overlay.height};
    case 'BOTTOM_CENTER': return {x: centreX, y: screen.height - overlay.height};
    case 'BOTTOM_RIGHT': return {x: screen.width - overlay.width, y: screen.height - overlay.height};
    case 'MANUAL': return anchor ?? {x: centreX, y: centreY};
    default: return {x: centreX, y: centreY};
  }
}

// ── The session (what the player shows and how it got there) ───────────────────────────────────

export type SurfaceState = {readonly frameId: NodeId; readonly scroll: ScrollOffsets};
export type OverlayState = SurfaceState & {
  readonly sourceId: NodeId | null;
  /** How it opened; closing plays this backwards. */
  readonly transition: Transition;
  /** MANUAL position: the overlay's top left in root space. */
  readonly anchor?: Vec;
};
export type SessionSnapshot = {readonly screen: SurfaceState; readonly overlays: readonly OverlayState[]};
export type HistoryEntry = {readonly snapshot: SessionSnapshot; readonly transition: Transition};
export type SessionState = SessionSnapshot & {
  readonly history: readonly HistoryEntry[];
  /** Instances shown as another variant of their set ("Change to"): instance id → variant id. */
  readonly variants: Readonly<Record<NodeId, NodeId>>;
};

/** What the player animates after a step. `present`: the screen or the overlay stack changed. */
export type SessionEffect =
  | {kind: 'none'}
  | {kind: 'present'; from: SessionSnapshot; transition: Transition; back: boolean}
  | {kind: 'scroll'; surface: number; destinationId: NodeId; transition: Transition}
  | {kind: 'variant'; instanceId: NodeId; from: NodeId | null; to: NodeId; transition: Transition}
  | {kind: 'url'; url: string; newTab: boolean};
export type SessionStep = {state: SessionState; effect: SessionEffect};
/** Where an action was triggered: the layer, which surface it is on (-1 the screen, i the i-th
 *  overlay) and its box in root space (MANUAL overlays open next to it). */
export type ActionSource = {id: NodeId; surface: number; rect?: Rect};

const NONE: SessionEffect = {kind: 'none'};
const INSTANT: Transition = {type: 'INSTANT'};

export function startSession(frameId: NodeId): SessionState {
  return {screen: {frameId, scroll: {}}, overlays: [], history: [], variants: {}};
}

const snapshotOf = (state: SessionSnapshot): SessionSnapshot => ({screen: state.screen, overlays: state.overlays});
const pushHistory = (state: SessionState, transition: Transition): readonly HistoryEntry[] =>
  [...state.history, {snapshot: snapshotOf(state), transition}].slice(-HISTORY_LIMIT);

/** Shows a frame as the screen: overlays close, variants reset, history grows. */
export function navigateTo(state: SessionState, frameId: NodeId, transition: Transition = INSTANT, options: {preserveScroll?: boolean; record?: boolean} = {}): SessionStep {
  const scroll = options.preserveScroll && state.screen.scroll[state.screen.frameId] ? {[frameId]: state.screen.scroll[state.screen.frameId]} : {};
  const next: SessionState = {
    screen: {frameId, scroll},
    overlays: [],
    history: options.record === false ? state.history : pushHistory(state, transition),
    variants: {},
  };
  return {state: next, effect: {kind: 'present', from: snapshotOf(state), transition, back: false}};
}

/** Closes the overlay at `index` and every one above it, playing the opening transition backwards. */
export function closeOverlays(state: SessionState, index = state.overlays.length - 1): SessionStep {
  if (index < 0 || index >= state.overlays.length) return {state, effect: NONE};
  const overlays = state.overlays.slice(0, index);
  let history = state.history;
  // "Back" right after closing should not reopen what was just closed: drop the step that opened it.
  const last = history.at(-1);
  if (last && sameSnapshot(last.snapshot, {screen: state.screen, overlays})) history = history.slice(0, -1);
  const transition = reverseTransition(state.overlays[index].transition);
  return {state: {...state, overlays, history}, effect: {kind: 'present', from: snapshotOf(state), transition, back: true}};
}

/** "Back": the previous screen and overlays, with the transition that led here played backwards. */
export function goBack(state: SessionState): SessionStep {
  const entry = state.history.at(-1);
  if (!entry) return {state, effect: NONE};
  const screenChanges = entry.snapshot.screen.frameId !== state.screen.frameId;
  const next: SessionState = {...entry.snapshot, history: state.history.slice(0, -1), variants: screenChanges ? {} : state.variants};
  return {state: next, effect: {kind: 'present', from: snapshotOf(state), transition: reverseTransition(entry.transition), back: true}};
}

export function sameSnapshot(a: SessionSnapshot, b: SessionSnapshot): boolean {
  return a.screen.frameId === b.screen.frameId && a.overlays.length === b.overlays.length && a.overlays.every((overlay, i) => overlay.frameId === b.overlays[i].frameId);
}

/** Shows `instanceId` as variant `variantId` (null puts back the main's own). */
export function withVariant(state: SessionState, instanceId: NodeId, variantId: NodeId | null): SessionState {
  const variants = {...state.variants};
  if (variantId) variants[instanceId] = variantId;
  else delete variants[instanceId];
  return {...state, variants};
}

/** Sets a surface's scroll offsets (-1 the screen, i an overlay). */
export function withScroll(state: SessionState, surface: number, scroll: ScrollOffsets): SessionState {
  if (surface < 0) return {...state, screen: {...state.screen, scroll}};
  if (!state.overlays[surface]) return state;
  const overlays = state.overlays.map((overlay, i) => (i === surface ? {...overlay, scroll} : overlay));
  return {...state, overlays};
}

/** One action of a reaction, played from `source`. `doc` is what the player shows (variants applied). */
export function sessionStep(doc: DesignDocument, state: SessionState, source: ActionSource, action: Action): SessionStep {
  if (actionIssue(doc, source.id, action)) return {state, effect: NONE};
  switch (action.type) {
    case 'BACK': return goBack(state);
    case 'CLOSE': {
      if (!state.overlays.length) return {state, effect: NONE};
      return closeOverlays(state, source.surface >= 0 ? source.surface : state.overlays.length - 1);
    }
    case 'URL': return {state, effect: {kind: 'url', url: action.url, newTab: action.openInNewTab}};
  }
  const {destinationId, transition} = action;
  switch (action.navigation) {
    case 'NAVIGATE':
      return navigateTo(state, destinationId, transition, {preserveScroll: action.preserveScrollPosition});
    case 'OVERLAY': {
      const anchor = manualAnchor(doc, destinationId, source, action);
      const overlay: OverlayState = {frameId: destinationId, scroll: {}, sourceId: source.id, transition, ...(anchor ? {anchor} : {})};
      const next: SessionState = {...state, overlays: [...state.overlays, overlay], history: pushHistory(state, transition)};
      return {state: next, effect: {kind: 'present', from: snapshotOf(state), transition, back: false}};
    }
    case 'SWAP': {
      if (!state.overlays.length) return navigateTo(state, destinationId, transition);
      const index = source.surface >= 0 ? source.surface : state.overlays.length - 1;
      const anchor = manualAnchor(doc, destinationId, source, action) ?? state.overlays[index].anchor;
      const overlay: OverlayState = {frameId: destinationId, scroll: {}, sourceId: source.id, transition, ...(anchor ? {anchor} : {})};
      const next: SessionState = {...state, overlays: [...state.overlays.slice(0, index), overlay], history: pushHistory(state, transition)};
      return {state: next, effect: {kind: 'present', from: snapshotOf(state), transition, back: false}};
    }
    case 'SCROLL_TO':
      return {state, effect: {kind: 'scroll', surface: source.surface, destinationId, transition}};
    case 'CHANGE_TO': {
      const instanceId = changeTarget(doc, source.id, destinationId);
      if (!instanceId) return {state, effect: NONE};
      const from = doc.nodes[instanceId]?.componentId ?? null;
      if (from === destinationId) return {state, effect: NONE};
      return {state: withVariant(state, instanceId, destinationId), effect: {kind: 'variant', instanceId, from, to: destinationId, transition}};
    }
  }
}

function manualAnchor(doc: DesignDocument, destinationId: NodeId, source: ActionSource, action: NodeAction): Vec | undefined {
  if (doc.nodes[destinationId]?.overlayPositionType !== 'MANUAL' || !source.rect) return undefined;
  const offset = action.overlayRelativePosition ?? {x: 0, y: source.rect.height};
  return {x: source.rect.x + offset.x, y: source.rect.y + offset.y};
}

// ── Smart animate ──────────────────────────────────────────────────────────────────────────────

/** Each layer's key under a root: the names on the way down, with "#n" for the n-th sibling of the same
 *  name. Smart animate pairs layers of two frames whose keys are equal. The root has key ''. */
export function layerKeys(doc: DesignDocument, rootId: NodeId): Map<NodeId, string> {
  const keys = new Map<NodeId, string>([[rootId, '']]);
  const walk = (id: NodeId, key: string, depth: number) => {
    const node = doc.nodes[id];
    if (!node?.children || depth > 256) return;
    const counts = new Map<string, number>();
    for (const childId of node.children) {
      const child = doc.nodes[childId];
      if (!child) continue;
      const n = counts.get(child.name) ?? 0;
      counts.set(child.name, n + 1);
      const childKey = `${key}/${child.name.replace(/[/#\\]/g, '\\$&')}${n ? '#' + n : ''}`;
      keys.set(childId, childKey);
      walk(childId, childKey, depth + 1);
    }
  };
  walk(rootId, '', 0);
  return keys;
}

export type LayerMatch = {pairs: Map<NodeId, NodeId>; onlyA: Set<NodeId>; onlyB: Set<NodeId>};

/** Pairs the layers of two frames by key (the roots always pair). */
export function matchLayers(docA: DesignDocument, rootA: NodeId, docB: DesignDocument, rootB: NodeId): LayerMatch {
  const keysA = layerKeys(docA, rootA), keysB = layerKeys(docB, rootB);
  const byKey = new Map<string, NodeId>();
  for (const [id, key] of keysB) byKey.set(key, id);
  const pairs = new Map<NodeId, NodeId>(), onlyA = new Set<NodeId>(), onlyB = new Set<NodeId>(keysB.keys());
  for (const [id, key] of keysA) {
    const match = byKey.get(key);
    if (match !== undefined) {
      pairs.set(id, match);
      onlyB.delete(match);
    } else onlyA.add(id);
  }
  return {pairs, onlyA, onlyB};
}

/** Fields that place a node or say how it behaves, not how it looks. */
const NOT_LOOK = new Set([
  'id', 'name', 'parentId', 'children', 'locked', 'reactions', 'pluginData', 'mainId', 'overrides', 'componentId', 'componentProperties',
  'componentPropertyReferences', 'componentPropertyDefinitions', 'description', 'exportSettings', 'constraints', 'layoutPositioning',
  'layoutSizingHorizontal', 'layoutSizingVertical', 'minWidth', 'maxWidth', 'minHeight', 'maxHeight', 'overflowDirection',
  'overlayPositionType', 'overlayBackground', 'overlayBackgroundInteraction', 'scrollBehavior', 'flowStartingPoints', 'prototypeDevice',
  'prototypeBackground', 'fillStyleId', 'strokeStyleId', 'effectStyleId', 'textStyleId', 'gridStyleId', 'boundVariables', 'autoLayout',
]);
const PLACEMENT = new Set(['x', 'y', 'rotation', 'opacity']);

export function deepEqual(a: unknown, b: unknown): boolean {
  if (a === b) return true;
  if (typeof a !== 'object' || typeof b !== 'object' || !a || !b) return typeof a === 'number' && typeof b === 'number' && Number.isNaN(a) && Number.isNaN(b);
  if (Array.isArray(a) !== Array.isArray(b)) return false;
  if (Array.isArray(a)) {
    const other = b as unknown[];
    return a.length === other.length && a.every((value, i) => deepEqual(value, other[i]));
  }
  const ra = a as Record<string, unknown>, rb = b as Record<string, unknown>;
  const keys = Object.keys(ra);
  if (keys.length !== Object.keys(rb).length) return false;
  return keys.every(key => key in rb && deepEqual(ra[key], rb[key]));
}

/** Whether two nodes look the same, leaving out where they are (and their opacity) when `placement` is false. */
export function sameOwnLook(a: SceneNode, b: SceneNode, placement = true): boolean {
  if (a === b) return true;
  const ra = a as unknown as Record<string, unknown>, rb = b as unknown as Record<string, unknown>;
  const skip = (key: string) => NOT_LOOK.has(key) || (!placement && PLACEMENT.has(key));
  for (const key in ra) if (!skip(key) && !deepEqual(ra[key], rb[key])) return false;
  for (const key in rb) if (!skip(key) && !(key in ra) && rb[key] !== undefined) return false;
  return true;
}

/** Whether two subtrees draw the same picture (the roots may sit elsewhere and differ in opacity). */
export function sameSubtree(docA: DesignDocument, a: SceneNode, docB: DesignDocument, b: SceneNode, rootPlacement = false, depth = 0): boolean {
  if (a === b && docA === docB) return true;
  if (depth > 256 || !sameOwnLook(a, b, rootPlacement)) return false;
  const ca = a.children ?? [], cb = b.children ?? [];
  if (ca.length !== cb.length) return false;
  for (let i = 0; i < ca.length; i++) {
    const na = docA.nodes[ca[i]], nb = docB.nodes[cb[i]];
    if (!na || !nb || !sameSubtree(docA, na, docB, nb, true, depth + 1)) return false;
  }
  return true;
}

/** How a layer animates: `same` moves as one picture, `morph` interpolates its own look and animates its
 *  children one by one, `crossfade` fades one picture into the other inside the moving box, `in` and
 *  `out` fade layers that exist on one side only. */
export type MorphMode = 'same' | 'morph' | 'crossfade' | 'in' | 'out';
export type MorphNode = {a: NodeId | null; b: NodeId | null; mode: MorphMode; children: MorphNode[]};

const SHAPED: ReadonlySet<string> = new Set(['VECTOR', 'BOOLEAN_OPERATION', 'TEXT', 'LINE']);

function compatiblePaints(a: readonly Paint[], b: readonly Paint[]): boolean {
  if (a.length !== b.length) return false;
  return a.every((paint, i) => {
    const other = b[i];
    if (paint.type !== other.type) return false;
    if (paint.type === 'IMAGE') return other.type === 'IMAGE' && paint.imageRef === other.imageRef && paint.scaleMode === other.scaleMode;
    if (paint.type !== 'SOLID') return 'gradientStops' in other && paint.gradientStops.length === other.gradientStops.length;
    return true;
  });
}

function compatibleEffects(a: readonly Effect[], b: readonly Effect[]): boolean {
  return a.length === b.length && a.every((effect, i) => effect.type === b[i].type);
}

/** Whether `interpolateNode` can draw the way from `a` to `b` (else the two are cross-faded). */
export function canMorph(a: SceneNode, b: SceneNode): boolean {
  if (a.type !== b.type) return false;
  if (SHAPED.has(a.type) && !sameOwnLook({...a, width: b.width, height: b.height}, b, false)) {
    // Shapes drawn from paths, and text, only move and resize as they are.
    return false;
  }
  if ((a.type === 'POLYGON' || a.type === 'STAR') && a.pointCount !== b.pointCount) return false;
  if (!compatiblePaints(a.fills, b.fills) || !compatiblePaints(a.strokes, b.strokes) || !compatibleEffects(a.effects, b.effects)) return false;
  if (a.isMask !== b.isMask || a.blendMode !== b.blendMode) return false;
  return true;
}

/** The animation plan between two frames (or two variants of an instance). */
export function smartAnimatePlan(docA: DesignDocument, rootA: NodeId, docB: DesignDocument, rootB: NodeId): MorphNode {
  const match = matchLayers(docA, rootA, docB, rootB);
  const plan = (a: SceneNode, b: SceneNode, isRoot: boolean, depth: number): MorphNode => {
    if (!isRoot && sameSubtree(docA, a, docB, b)) return {a: a.id, b: b.id, mode: 'same', children: []};
    const container = !!a.children && !!b.children && a.type !== 'BOOLEAN_OPERATION' && depth < 256;
    if (!isRoot && (!canMorph(a, b) || (!container && (a.children || b.children)))) return {a: a.id, b: b.id, mode: 'crossfade', children: []};
    const children: MorphNode[] = [];
    if (container) {
      for (const id of a.children!) if (match.onlyA.has(id) && docA.nodes[id]) children.push({a: id, b: null, mode: 'out', children: []});
      const reverse = new Map<NodeId, NodeId>();
      for (const id of a.children!) {
        const pair = match.pairs.get(id);
        if (pair !== undefined) reverse.set(pair, id);
      }
      for (const id of paintOrderOf(b)) {
        const nb = docB.nodes[id];
        if (!nb) continue;
        const pairA = reverse.get(id);
        const na = pairA !== undefined ? docA.nodes[pairA] : undefined;
        children.push(na ? plan(na, nb, false, depth + 1) : {a: null, b: id, mode: 'in', children: []});
      }
    }
    return {a: a.id, b: b.id, mode: 'morph', children};
  };
  const a = docA.nodes[rootA], b = docB.nodes[rootB];
  if (!a || !b) return {a: a ? rootA : null, b: b ? rootB : null, mode: 'crossfade', children: []};
  return plan(a, b, true, 0);
}

export const lerp = (a: number, b: number, t: number) => a + (b - a) * t;
const clamp01 = (value: number) => Math.min(1, Math.max(0, value));

/** The shorter way round between two angles in degrees. */
export function lerpAngle(a: number, b: number, t: number): number {
  let delta = ((b - a) % 360 + 540) % 360 - 180;
  if (delta === -180 && b > a) delta = 180;
  return a + delta * t;
}

export function lerpColor<C extends RGB | RGBA>(a: C, b: C, t: number): C {
  const out = {r: clamp01(lerp(a.r, b.r, t)), g: clamp01(lerp(a.g, b.g, t)), b: clamp01(lerp(a.b, b.b, t))} as C;
  if ('a' in a && 'a' in b) (out as RGBA).a = clamp01(lerp(a.a, b.a, t));
  return out;
}

function lerpPaint(a: Paint, b: Paint, t: number): Paint {
  const opacity = clamp01(lerp(a.opacity, b.opacity, t));
  if (a.type === 'SOLID' && b.type === 'SOLID') return {...b, opacity, color: lerpColor(a.color, b.color, t)};
  if (a.type !== 'SOLID' && a.type !== 'IMAGE' && b.type !== 'SOLID' && b.type !== 'IMAGE' && a.gradientStops.length === b.gradientStops.length) {
    return {
      ...b, opacity,
      gradientStops: b.gradientStops.map((stop, i) => ({position: clamp01(lerp(a.gradientStops[i].position, stop.position, t)), color: lerpColor(a.gradientStops[i].color, stop.color, t)})),
      gradientHandlePositions: b.gradientHandlePositions.map((handle, i) => ({x: lerp(a.gradientHandlePositions[i].x, handle.x, t), y: lerp(a.gradientHandlePositions[i].y, handle.y, t)})) as [Vec, Vec, Vec],
    };
  }
  return {...b, opacity};
}

const lerpPaints = (a: readonly Paint[], b: readonly Paint[], t: number): Paint[] => (a.length === b.length ? b.map((paint, i) => lerpPaint(a[i], paint, t)) : [...(t < 0.5 ? a : b)]);

function lerpEffects(a: readonly Effect[], b: readonly Effect[], t: number): Effect[] {
  if (a.length !== b.length) return [...(t < 0.5 ? a : b)];
  return b.map((effect, i) => {
    const from = a[i];
    if (from.type !== effect.type) return effect;
    if ((effect.type === 'DROP_SHADOW' || effect.type === 'INNER_SHADOW') && (from.type === 'DROP_SHADOW' || from.type === 'INNER_SHADOW')) {
      return {...effect, color: lerpColor(from.color, effect.color, t), offset: {x: lerp(from.offset.x, effect.offset.x, t), y: lerp(from.offset.y, effect.offset.y, t)}, radius: Math.max(0, lerp(from.radius, effect.radius, t)), spread: lerp(from.spread, effect.spread, t)};
    }
    return {...effect, radius: Math.max(0, lerp(from.radius, effect.radius, t))};
  });
}

const radii = (node: SceneNode): [number, number, number, number] => {
  const r = node.rectangleCornerRadii;
  if (r && r.length === 4) return [r[0], r[1], r[2], r[3]];
  const one = node.cornerRadius ?? 0;
  return [one, one, one, one];
};

/** `b` with its position, size, rotation, opacity, corner radii, stroke weight, paints and effects taken
 *  `t` of the way from `a` (t may overshoot: sizes, opacity and colours stay in range). */
export function interpolateNode(a: SceneNode, b: SceneNode, t: number): SceneNode {
  if (t === 1) return b;
  const out: SceneNode = {
    ...b,
    x: lerp(a.x, b.x, t),
    y: lerp(a.y, b.y, t),
    width: Math.max(0, lerp(a.width, b.width, t)),
    height: b.type === 'LINE' ? 0 : Math.max(0, lerp(a.height, b.height, t)),
    rotation: lerpAngle(a.rotation || 0, b.rotation || 0, t),
    opacity: clamp01(lerp(a.opacity, b.opacity, t)),
    strokeWeight: Math.max(0, lerp(a.strokeWeight, b.strokeWeight, t)),
    fills: lerpPaints(a.fills, b.fills, t),
    strokes: lerpPaints(a.strokes, b.strokes, t),
    effects: lerpEffects(a.effects, b.effects, t),
  };
  if (a.cornerRadius !== undefined || b.cornerRadius !== undefined || a.rectangleCornerRadii || b.rectangleCornerRadii) {
    const ra = radii(a), rb = radii(b);
    const r = rb.map((value, i) => Math.max(0, lerp(ra[i], value, t))) as [number, number, number, number];
    if (r.every(value => value === r[0])) {
      out.cornerRadius = r[0];
      out.rectangleCornerRadii = null;
    } else out.rectangleCornerRadii = r;
  }
  if (a.arcData && b.arcData) out.arcData = {startingAngle: lerp(a.arcData.startingAngle, b.arcData.startingAngle, t), endingAngle: lerp(a.arcData.endingAngle, b.arcData.endingAngle, t), innerRadius: clamp01(lerp(a.arcData.innerRadius, b.arcData.innerRadius, t))};
  if (a.innerRadius !== undefined && b.innerRadius !== undefined) out.innerRadius = clamp01(lerp(a.innerRadius, b.innerRadius, t));
  return out;
}
