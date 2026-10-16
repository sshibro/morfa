import type {Action, Easing, NodeId, OverlayPosition, Reaction, RGBA, SceneNode, Transition, TransitionDirection, Trigger} from '../types';
import {isSafeDesignUrl} from '../schema';
import {DESIGN_FIELD_LIMITS as L} from '../document-limits';
import type {FigmaAction, FigmaInteraction, FigmaNode, FigmaTransition, FigmaTrigger} from './rest-types';
import {bool, coord, finite, rgba, type Note} from './values';

// Prototyping: `interactions` (or the older `reactions`, or the frame-level `transitionNodeID`) →
// Reaction / Action / Transition, overflow and overlay settings. Durations stay in seconds, as Figma
// gives them. Destinations outside the import, variables, conditions and media are noted and left out.

const EASINGS = new Set<Easing>(['LINEAR', 'EASE_IN', 'EASE_OUT', 'EASE_IN_AND_OUT', 'EASE_IN_BACK', 'EASE_OUT_BACK', 'GENTLE', 'QUICK', 'BOUNCY', 'SLOW']);
const DIRECTIONS = new Set<TransitionDirection>(['LEFT', 'RIGHT', 'TOP', 'BOTTOM']);
const NAVIGATIONS = new Set(['NAVIGATE', 'OVERLAY', 'SWAP', 'SCROLL_TO', 'CHANGE_TO']);
const SIMPLE_TRIGGERS = new Set(['ON_CLICK', 'ON_HOVER', 'ON_PRESS', 'ON_DRAG', 'MOUSE_ENTER', 'MOUSE_LEAVE', 'MOUSE_DOWN', 'MOUSE_UP']);

// KeyboardEvent.keyCode → KeyboardEvent.code, for the keys prototypes use.
const KEY_CODES: Record<number, string> = {
  8: 'Backspace', 9: 'Tab', 13: 'Enter', 16: 'ShiftLeft', 17: 'ControlLeft', 18: 'AltLeft', 27: 'Escape', 32: 'Space',
  33: 'PageUp', 34: 'PageDown', 35: 'End', 36: 'Home', 37: 'ArrowLeft', 38: 'ArrowUp', 39: 'ArrowRight', 40: 'ArrowDown', 46: 'Delete',
  91: 'MetaLeft', 186: 'Semicolon', 187: 'Equal', 188: 'Comma', 189: 'Minus', 190: 'Period', 191: 'Slash', 192: 'Backquote', 219: 'BracketLeft', 220: 'Backslash', 221: 'BracketRight', 222: 'Quote',
};
const MODIFIERS = new Set([16, 17, 18, 91, 93]);

function keyCode(code: number): string | undefined {
  if (code >= 65 && code <= 90) return 'Key' + String.fromCharCode(code);
  if (code >= 48 && code <= 57) return 'Digit' + (code - 48);
  if (code >= 112 && code <= 123) return 'F' + (code - 111);
  return KEY_CODES[code];
}

function triggerOf(trigger: FigmaTrigger | null | undefined, note: Note): Trigger | null {
  if (!trigger || typeof trigger.type !== 'string') return null;
  if (SIMPLE_TRIGGERS.has(trigger.type)) {
    if (finite(trigger.delay) > 0) note('proto-delay', 'prototype', 'The delay on "Mouse enter" and "Mouse leave" is not imported');
    return {type: trigger.type as 'ON_CLICK'};
  }
  if (trigger.type === 'AFTER_TIMEOUT') return {type: 'AFTER_TIMEOUT', timeout: Math.min(1_000_000, Math.max(0, finite(trigger.timeout)))};
  if (trigger.type === 'ON_KEY_DOWN') {
    const codes = (Array.isArray(trigger.keyCodes) ? trigger.keyCodes : []).filter((code): code is number => typeof code === 'number');
    const main = codes.filter(code => !MODIFIERS.has(code));
    const code = keyCode(main[main.length - 1] ?? codes[codes.length - 1] ?? -1);
    if (!code) return null;
    if (codes.length > 1) note('proto-combo', 'prototype', 'Key combinations in the prototype were reduced to a single key');
    return {type: 'ON_KEY_DOWN', keyCode: code};
  }
  note('proto-trigger-' + trigger.type, 'prototype', 'Video triggers are not imported');
  return null;
}

function easingOf(easing: FigmaTransition['easing'], note: Note): Easing {
  const type = easing?.type;
  if (typeof type === 'string' && EASINGS.has(type as Easing)) return type as Easing;
  if (type === 'EASE_IN_AND_OUT_BACK') {
    note('proto-easing-back', 'prototype', 'The "Ease in and out back" curve was replaced with "Ease in and out"');
    return 'EASE_IN_AND_OUT';
  }
  if (type === 'CUSTOM_CUBIC_BEZIER' || type === 'CUSTOM_SPRING') {
    note('proto-easing-custom', 'prototype', 'Custom animation curves were replaced with the nearest standard ones');
    return type === 'CUSTOM_SPRING' ? 'GENTLE' : 'EASE_IN_AND_OUT';
  }
  return 'EASE_OUT';
}

function transitionOf(transition: FigmaTransition | null | undefined, note: Note): Transition {
  if (!transition || typeof transition.type !== 'string') return {type: 'INSTANT'};
  const duration = Math.min(1_000_000, Math.max(0, finite(transition.duration, 0.3)));
  const easing = easingOf(transition.easing, note);
  switch (transition.type) {
    case 'DISSOLVE':
    case 'SMART_ANIMATE':
      return {type: transition.type, duration, easing};
    case 'SCROLL_ANIMATE':
      note('proto-scroll-animate', 'prototype', 'The scroll animation was replaced with "Smart animate"');
      return {type: 'SMART_ANIMATE', duration, easing};
    case 'MOVE_IN':
    case 'MOVE_OUT':
    case 'PUSH':
    case 'SLIDE_IN':
    case 'SLIDE_OUT': {
      const direction = DIRECTIONS.has(transition.direction as TransitionDirection) ? (transition.direction as TransitionDirection) : 'LEFT';
      const out: Transition = {type: transition.type, direction, duration, easing};
      if (transition.matchLayers) out.matchLayers = true;
      return out;
    }
    default:
      return {type: 'INSTANT'};
  }
}

function actionOf(action: FigmaAction | null | undefined, nodeRef: (id: string) => NodeId | undefined, note: Note): Action | null {
  if (!action || typeof action.type !== 'string') return null;
  switch (action.type) {
    case 'BACK':
      return {type: 'BACK'};
    case 'CLOSE':
      return {type: 'CLOSE'};
    case 'URL':
      if (typeof action.url === 'string' && isSafeDesignUrl(action.url)) return {type: 'URL', url: action.url, openInNewTab: bool(action.openInNewTab, true)};
      note('proto-url', 'prototype', 'Links other than http(s) and mailto were removed from the prototype');
      return null;
    case 'NODE': {
      if (typeof action.destinationId !== 'string') return null;
      const destinationId = nodeRef(action.destinationId);
      if (!destinationId) {
        note('proto-destination', 'prototype', 'Navigations to frames that are not in the file were removed');
        return null;
      }
      const navigation = NAVIGATIONS.has(String(action.navigation)) ? (action.navigation as 'NAVIGATE') : 'NAVIGATE';
      const out: Action = {type: 'NODE', navigation, destinationId, transition: transitionOf(action.transition, note)};
      if (action.preserveScrollPosition) out.preserveScrollPosition = true;
      if (action.resetScrollPosition) out.resetScrollPosition = true;
      if (action.overlayRelativePosition && typeof action.overlayRelativePosition === 'object')
        out.overlayRelativePosition = {x: coord(action.overlayRelativePosition.x), y: coord(action.overlayRelativePosition.y)};
      return out;
    }
    case 'SET_VARIABLE':
    case 'SET_VARIABLE_MODE':
    case 'CONDITIONAL':
      note('proto-variables', 'prototype', 'Variable actions and conditions in the prototype are not imported');
      return null;
    default:
      note('proto-action-' + action.type, 'prototype', 'Video actions and other special actions are not imported');
      return null;
  }
}

/** A node's prototype reactions. */
export function reactionsOf(node: FigmaNode, nodeRef: (id: string) => NodeId | undefined, note: Note): Reaction[] {
  const list = Array.isArray(node.interactions) ? node.interactions : Array.isArray(node.reactions) ? node.reactions : null;
  const out: Reaction[] = [];
  if (list) {
    for (const entry of list as (FigmaInteraction | null)[]) {
      if (!entry || typeof entry !== 'object') continue;
      const trigger = triggerOf(entry.trigger, note);
      if (!trigger) continue;
      const source = Array.isArray(entry.actions) ? entry.actions : entry.action ? [entry.action] : [];
      const actions = source.map(action => actionOf(action, nodeRef, note)).filter((action): action is Action => !!action).slice(0, L.actions);
      if (!actions.length) continue;
      out.push({trigger, actions});
      if (out.length >= L.reactions) break;
    }
    return out;
  }
  // Files from before interactions: one click-through per frame.
  if (typeof node.transitionNodeID === 'string') {
    const destinationId = nodeRef(node.transitionNodeID);
    if (destinationId) {
      const duration = Math.max(0, finite(node.transitionDuration)) / 1000;
      const transition: Transition = duration > 0 ? {type: 'DISSOLVE', duration, easing: 'EASE_OUT'} : {type: 'INSTANT'};
      out.push({trigger: {type: 'ON_CLICK'}, actions: [{type: 'NODE', navigation: 'NAVIGATE', destinationId, transition}]});
    }
  }
  return out;
}

const OVERFLOW: Record<string, SceneNode['overflowDirection']> = {
  NONE: 'NONE', HORIZONTAL_SCROLLING: 'HORIZONTAL', VERTICAL_SCROLLING: 'VERTICAL', HORIZONTAL_AND_VERTICAL_SCROLLING: 'BOTH',
  HORIZONTAL: 'HORIZONTAL', VERTICAL: 'VERTICAL', BOTH: 'BOTH',
};
const OVERLAY_POSITIONS = new Set<OverlayPosition>(['CENTER', 'TOP_LEFT', 'TOP_CENTER', 'TOP_RIGHT', 'BOTTOM_LEFT', 'BOTTOM_CENTER', 'BOTTOM_RIGHT', 'MANUAL']);

/** Frame-level prototype settings: scrolling, overlay placement and background. */
export function framePrototypeOf(node: FigmaNode): Partial<SceneNode> {
  const out: Partial<SceneNode> = {};
  const overflow = OVERFLOW[String(node.overflowDirection)];
  if (overflow) out.overflowDirection = overflow;
  if (OVERLAY_POSITIONS.has(node.overlayPositionType as OverlayPosition)) out.overlayPositionType = node.overlayPositionType as OverlayPosition;
  const background = node.overlayBackground;
  if (background?.type === 'SOLID_COLOR') out.overlayBackground = {type: 'SOLID_COLOR', color: rgba(background.color) as RGBA};
  else if (background?.type === 'NONE') out.overlayBackground = {type: 'NONE'};
  if (node.overlayBackgroundInteraction === 'CLOSE_ON_CLICK_OUTSIDE' || node.overlayBackgroundInteraction === 'NONE') out.overlayBackgroundInteraction = node.overlayBackgroundInteraction;
  return out;
}

export function scrollBehaviorOf(node: FigmaNode): SceneNode['scrollBehavior'] | undefined {
  return node.scrollBehavior === 'FIXED' || node.scrollBehavior === 'STICKY_SCROLLS' ? node.scrollBehavior : undefined;
}

