import type {Action, DesignDocument, Easing, NodeId, OverflowDirection, OverlayPosition, Reaction, SceneNode, TransitionDirection, Trigger} from '../../../shared/design/types';
import {actionKind, type ActionKind, type TransitionType, type TriggerType} from '../../../shared/design/prototype';
import type {SelectEntry} from '../ui/Select';
import {formatShortcut} from '../ui/shortcuts';

// The words of the "Prototype" tab (docs/design-tool.md §vocabulary) and the one-line
// summaries the interaction rows and the canvas show.

export const TRIGGER_LABELS: Record<TriggerType, string> = {
  ON_CLICK: 'On click',
  ON_HOVER: 'While hovering',
  ON_PRESS: 'While pressing',
  ON_DRAG: 'On drag',
  MOUSE_ENTER: 'Mouse enter',
  MOUSE_LEAVE: 'Mouse leave',
  MOUSE_DOWN: 'Mouse down',
  MOUSE_UP: 'Mouse up',
  AFTER_TIMEOUT: 'After delay',
  ON_KEY_DOWN: 'Key down',
};

export const TRIGGER_OPTIONS: readonly SelectEntry<TriggerType>[] = [
  {value: 'ON_CLICK', label: TRIGGER_LABELS.ON_CLICK},
  {value: 'ON_HOVER', label: TRIGGER_LABELS.ON_HOVER, description: 'While the pointer is over the layer'},
  {value: 'ON_PRESS', label: TRIGGER_LABELS.ON_PRESS, description: 'While the mouse button is held down'},
  {value: 'ON_DRAG', label: TRIGGER_LABELS.ON_DRAG},
  {separator: true},
  {value: 'MOUSE_ENTER', label: TRIGGER_LABELS.MOUSE_ENTER},
  {value: 'MOUSE_LEAVE', label: TRIGGER_LABELS.MOUSE_LEAVE},
  {value: 'MOUSE_DOWN', label: TRIGGER_LABELS.MOUSE_DOWN, description: 'As soon as the button is pressed'},
  {value: 'MOUSE_UP', label: TRIGGER_LABELS.MOUSE_UP, description: 'When the button is released'},
  {separator: true},
  {value: 'AFTER_TIMEOUT', label: TRIGGER_LABELS.AFTER_TIMEOUT},
  {value: 'ON_KEY_DOWN', label: TRIGGER_LABELS.ON_KEY_DOWN},
];

export const ACTION_LABELS: Record<ActionKind, string> = {
  NAVIGATE: 'Navigate to',
  OVERLAY: 'Open overlay',
  SWAP: 'Swap overlay',
  SCROLL_TO: 'Scroll to',
  CHANGE_TO: 'Change to',
  BACK: 'Back',
  CLOSE: 'Close overlay',
  URL: 'Open link',
};

export const ACTION_OPTIONS: readonly SelectEntry<ActionKind>[] = [
  {value: 'NAVIGATE', label: ACTION_LABELS.NAVIGATE},
  {value: 'OVERLAY', label: ACTION_LABELS.OVERLAY},
  {value: 'SWAP', label: ACTION_LABELS.SWAP},
  {value: 'SCROLL_TO', label: ACTION_LABELS.SCROLL_TO},
  {value: 'CHANGE_TO', label: ACTION_LABELS.CHANGE_TO},
  {separator: true},
  {value: 'BACK', label: ACTION_LABELS.BACK},
  {value: 'CLOSE', label: ACTION_LABELS.CLOSE},
  {separator: true},
  {value: 'URL', label: ACTION_LABELS.URL},
];

export const TRANSITION_LABELS: Record<TransitionType, string> = {
  INSTANT: 'Instant',
  DISSOLVE: 'Dissolve',
  SMART_ANIMATE: 'Smart animate',
  MOVE_IN: 'Move in',
  MOVE_OUT: 'Move out',
  PUSH: 'Push',
  SLIDE_IN: 'Slide in',
  SLIDE_OUT: 'Slide out',
};

/** "Scroll to" names its animated form for what it does. */
export const transitionLabel = (type: TransitionType, kind: ActionKind) => (kind === 'SCROLL_TO' && type === 'SMART_ANIMATE' ? 'Smooth scroll' : TRANSITION_LABELS[type]);

export const EASING_LABELS: Record<Easing, string> = {
  LINEAR: 'Linear',
  EASE_IN_AND_OUT: 'Ease in and out',
  EASE_IN: 'Ease in',
  EASE_OUT: 'Ease out',
  EASE_IN_BACK: 'Ease in back',
  EASE_OUT_BACK: 'Ease out back',
  GENTLE: 'Gentle',
  QUICK: 'Quick',
  BOUNCY: 'Bouncy',
  SLOW: 'Slow',
};

export const EASING_OPTIONS: readonly SelectEntry<Easing>[] = [
  {value: 'LINEAR', label: EASING_LABELS.LINEAR},
  {value: 'EASE_IN_AND_OUT', label: EASING_LABELS.EASE_IN_AND_OUT},
  {value: 'EASE_IN', label: EASING_LABELS.EASE_IN},
  {value: 'EASE_OUT', label: EASING_LABELS.EASE_OUT},
  {value: 'EASE_IN_BACK', label: EASING_LABELS.EASE_IN_BACK},
  {value: 'EASE_OUT_BACK', label: EASING_LABELS.EASE_OUT_BACK},
  {heading: 'Spring'},
  {value: 'GENTLE', label: EASING_LABELS.GENTLE},
  {value: 'QUICK', label: EASING_LABELS.QUICK},
  {value: 'BOUNCY', label: EASING_LABELS.BOUNCY},
  {value: 'SLOW', label: EASING_LABELS.SLOW},
];

export const DIRECTION_LABELS: Record<TransitionDirection, string> = {LEFT: 'Left', RIGHT: 'Right', TOP: 'Top', BOTTOM: 'Bottom'};

export const OVERFLOW_OPTIONS: readonly SelectEntry<OverflowDirection>[] = [
  {value: 'NONE', label: 'No scrolling'},
  {value: 'VERTICAL', label: 'Vertical scrolling'},
  {value: 'HORIZONTAL', label: 'Horizontal scrolling'},
  {value: 'BOTH', label: 'Horizontal and vertical scrolling'},
];

export type ScrollBehavior = NonNullable<SceneNode['scrollBehavior']>;
export const SCROLL_BEHAVIOR_OPTIONS: readonly SelectEntry<ScrollBehavior>[] = [
  {value: 'SCROLLS', label: 'Scroll with parent', description: 'Moves with the frame’s content'},
  {value: 'FIXED', label: 'Fixed', description: 'Stays in place'},
  {value: 'STICKY_SCROLLS', label: 'Sticky', description: 'Scrolls until it reaches the edge'},
];

export const OVERLAY_POSITION_OPTIONS: readonly SelectEntry<OverlayPosition>[] = [
  {value: 'CENTER', label: 'Center'},
  {value: 'TOP_LEFT', label: 'Top left'},
  {value: 'TOP_CENTER', label: 'Top center'},
  {value: 'TOP_RIGHT', label: 'Top right'},
  {value: 'BOTTOM_LEFT', label: 'Bottom left'},
  {value: 'BOTTOM_CENTER', label: 'Bottom center'},
  {value: 'BOTTOM_RIGHT', label: 'Bottom right'},
  {value: 'MANUAL', label: 'Manual', description: 'Next to the layer that opened it'},
];

export function triggerLabel(trigger: Trigger): string {
  if (trigger.type === 'AFTER_TIMEOUT') return `After ${formatMs(trigger.timeout)}`;
  if (trigger.type === 'ON_KEY_DOWN') return trigger.keyCode ? `Key ${formatShortcut(trigger.keyCode)}` : TRIGGER_LABELS.ON_KEY_DOWN;
  return TRIGGER_LABELS[trigger.type];
}

/** Seconds as the panel shows them: "800 ms", "1.5 s". */
export function formatMs(seconds: number): string {
  const ms = Math.round(seconds * 1000);
  return ms < 10_000 ? `${ms} ms` : `${(ms / 1000).toLocaleString('en-US', {maximumFractionDigits: 1})} s`;
}

export const nodeName = (doc: DesignDocument, id: NodeId) => doc.nodes[id]?.name ?? 'deleted layer';

/** "Navigate to: Code", "Back", "Open link: foo.test". */
export function actionLabel(doc: DesignDocument, action: Action): string {
  const kind = actionKind(action);
  if (action.type === 'NODE') return `${ACTION_LABELS[kind]}: ${nodeName(doc, action.destinationId)}`;
  if (action.type === 'URL') return `${ACTION_LABELS.URL}: ${shortUrl(action.url)}`;
  return ACTION_LABELS[kind];
}

export function reactionSummary(doc: DesignDocument, reaction: Reaction): string {
  if (!reaction.actions.length) return 'No action chosen';
  const first = actionLabel(doc, reaction.actions[0]);
  return reaction.actions.length > 1 ? `${first} and ${reaction.actions.length - 1} more` : first;
}

function shortUrl(url: string): string {
  try {
    const parsed = new URL(url);
    if (parsed.protocol === 'mailto:') return parsed.pathname;
    return parsed.host + (parsed.pathname === '/' ? '' : parsed.pathname);
  } catch {
    return url;
  }
}
