import type {Vec} from '../../../../shared/design/types';
import type {Viewport} from '../contracts';
import {panBy} from '../viewport';
import {pinchViewport, type FingerPair} from './pinch';

// Fingers on the canvas. The canvas hands every touch pointer here; this decides what the
// fingers mean and tells the canvas (`TouchHost`). Mouse and pen never come here: their path does not change.
//
// - One finger on what the tool takes (a drawing tool anywhere; the move tool on the selection or a handle): the tool
//   gets the press. The move tool gets the drag only past TOUCH_SLOP, so a tap is not a nudge.
// - One finger elsewhere: a drag pans; a tap reaches the tool as a click (it selects, or clears the selection).
// - Two fingers: pan and pinch-zoom together about their centre, always, whatever the tool. A second finger landing
//   cancels the first finger's tool drag (put back, never committed) and changes no selection.
// - Two taps in a row: a double click. A press held still: the context menu, opened as that finger lifts.

/** CSS px a finger may wander before a press becomes a drag. */
export const TOUCH_SLOP = 8;
/** ms a still finger is held before the context menu opens. */
export const LONG_PRESS_MS = 500;
/** ms and CSS px within which a second tap makes a double tap. */
export const DOUBLE_TAP_MS = 300;
export const DOUBLE_TAP_PX = 24;

/** What a one-finger press means to the tool in hand: `draw` takes everything, `grab` takes a drag past the slop, `pan`
 *  pans on a drag and clicks on a tap. */
export type TouchClaim = 'draw' | 'grab' | 'pan';

export type TouchPoint = {id: number; at: Vec; time: number};

export interface TouchHost<E> {
  claim(e: E): TouchClaim;
  toolDown(e: E): void;
  toolMove(e: E): void;
  toolUp(e: E): void;
  /** Put back what the tool's press started; nothing is committed. */
  toolCancel(): void;
  viewport(): Viewport;
  setViewport(viewport: Viewport): void;
  contextMenu(e: E): void;
  doubleTap(e: E): void;
  /** Runs `run` after `ms`; returns what cancels it. */
  later(run: () => void, ms: number): () => void;
  /** Two fingers began or stopped pinching (the canvas draws coarser meanwhile: touch/backing.ts). */
  pinching?(on: boolean): void;
}

type Press<E> = {kind: 'press'; claim: TouchClaim; id: number; start: TouchPoint; startEvent: E; moved: boolean; cancelHold: () => void};
type Pan = {kind: 'pan'; id: number; start: Vec; from: Viewport};
type Pinch = {kind: 'pinch'; ids: readonly [number, number]; start: FingerPair; from: Viewport};
/** Waits for every finger to lift (after a pinch). */
type Settle = {kind: 'settle'};
/** A press held still: the context menu opens when this finger lifts (a menu under a finger would take its release). */
type Held<E> = {kind: 'held'; id: number; startEvent: E};
type State<E> = {kind: 'idle'} | Press<E> | Pan | Pinch | Settle | Held<E>;

const IDLE = {kind: 'idle'} as const;
const SETTLE = {kind: 'settle'} as const;
const distance = (a: Vec, b: Vec) => Math.hypot(a.x - b.x, a.y - b.y);

export class TouchGestures<E> {
  private state: State<E> = IDLE;
  private readonly fingers = new Map<number, Vec>();
  private lastTap: TouchPoint | null = null;

  constructor(private readonly host: TouchHost<E>) {}

  /** True while fingers are on the canvas (hover and tool switches wait). */
  get active() {
    return this.state.kind !== 'idle';
  }

  down(point: TouchPoint, e: E) {
    this.fingers.set(point.id, point.at);
    const state = this.state;
    if (state.kind === 'idle') {
      this.press(point, e);
      return;
    }
    if ((state.kind === 'press' || state.kind === 'pan' || state.kind === 'held') && this.fingers.size === 2) this.beginPinch();
  }

  move(point: TouchPoint, e: E) {
    if (!this.fingers.has(point.id)) return;
    this.fingers.set(point.id, point.at);
    const state = this.state;
    if (state.kind === 'press' && state.id === point.id) this.movePress(state, point, e);
    else if (state.kind === 'pan' && state.id === point.id) this.host.setViewport(panBy(state.from, point.at.x - state.start.x, point.at.y - state.start.y));
    else if (state.kind === 'pinch' && state.ids.includes(point.id)) this.host.setViewport(pinchViewport(state.from, state.start, this.pair(state.ids)));
  }

  up(point: TouchPoint, e: E) {
    this.fingers.delete(point.id);
    const state = this.state;
    if (state.kind === 'press' && state.id === point.id) {
      state.cancelHold();
      this.state = IDLE;
      // A tap where the tool took nothing reaches it now, as a click where the finger landed.
      if (state.claim === 'pan') this.host.toolDown(state.startEvent);
      this.host.toolUp(e);
      if (!state.moved) this.tapped(point, e);
      return;
    }
    if (state.kind === 'pan' && state.id === point.id) {
      this.state = IDLE;
      return;
    }
    if (state.kind === 'held' && state.id === point.id) {
      this.state = this.fingers.size ? SETTLE : IDLE;
      this.host.contextMenu(state.startEvent);
      return;
    }
    if (state.kind === 'pinch' || state.kind === 'settle') this.state = this.fingers.size ? SETTLE : IDLE;
    if (state.kind === 'pinch') this.host.pinching?.(false);
  }

  cancel(point: TouchPoint) {
    if (!this.fingers.delete(point.id)) return;
    const state = this.state;
    if (state.kind === 'press') {
      state.cancelHold();
      if (state.claim !== 'pan') this.host.toolCancel();
    }
    this.state = this.fingers.size ? SETTLE : IDLE;
    if (state.kind === 'pinch') this.host.pinching?.(false);
  }

  private press(point: TouchPoint, e: E) {
    const claim = this.host.claim(e);
    if (claim !== 'pan') this.host.toolDown(e);
    const hold = claim === 'draw' ? () => undefined : this.host.later(() => this.held(), LONG_PRESS_MS);
    this.state = {kind: 'press', claim, id: point.id, start: point, startEvent: e, moved: false, cancelHold: hold};
  }

  private movePress(state: Press<E>, point: TouchPoint, e: E) {
    if (!state.moved && distance(point.at, state.start.at) >= TOUCH_SLOP) {
      state.moved = true;
      state.cancelHold();
      if (state.claim === 'pan') {
        // From where the finger landed, so the slop it travelled is not lost.
        this.state = {kind: 'pan', id: point.id, start: state.start.at, from: this.host.viewport()};
        this.host.setViewport(panBy(this.host.viewport(), point.at.x - state.start.at.x, point.at.y - state.start.at.y));
        return;
      }
    }
    if (state.claim === 'draw' || state.moved) this.host.toolMove(e);
  }

  private beginPinch() {
    const state = this.state;
    if (state.kind === 'press') {
      state.cancelHold();
      if (state.claim !== 'pan') this.host.toolCancel();
    }
    const ids = [...this.fingers.keys()] as [number, number];
    this.state = {kind: 'pinch', ids, start: this.pair(ids), from: this.host.viewport()};
    this.lastTap = null;
    this.host.pinching?.(true);
  }

  private held() {
    const state = this.state;
    if (state.kind !== 'press' || state.moved) return;
    if (state.claim !== 'pan') this.host.toolCancel();
    this.state = {kind: 'held', id: state.id, startEvent: state.startEvent};
    this.lastTap = null;
  }

  private tapped(point: TouchPoint, e: E) {
    const last = this.lastTap;
    if (last && point.time - last.time <= DOUBLE_TAP_MS && distance(point.at, last.at) <= DOUBLE_TAP_PX) {
      this.lastTap = null;
      this.host.doubleTap(e);
      return;
    }
    this.lastTap = point;
  }

  private pair(ids: readonly [number, number]): FingerPair {
    return [this.fingers.get(ids[0])!, this.fingers.get(ids[1])!];
  }
}
