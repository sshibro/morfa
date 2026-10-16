import {DESIGN_LIVE_COLORS} from '../../../shared/design/live';
import type {NodeId, Vec} from '../../../shared/design/types';
import {currentViewport, type DesignStore} from '../engine/store';
import {pageToScreen} from '../engine/viewport';
import type {MeetingTargets} from './targets';
import {pageOfNode} from './targets';

// What "Meeting" draws over the canvas without React (docs/board-meeting.md): emote bursts and high fives, the others' cursor chat
// bubbles and waving hands (hung on their cursors, which src/design/realtime/PresenceUI.tsx draws, so they move with them for free),
// and the vote badges on objects. Like the cursors, nothing here re-renders a component: elements are made once and moved with
// `transform` on animation frames, only while there is something to move. Bursts are the one place that delights (rare, at most a
// few a second): they pop and drift up; with reduced motion they only fade.

export const colorOf = (index: number) => DESIGN_LIVE_COLORS[((index % DESIGN_LIVE_COLORS.length) + DESIGN_LIVE_COLORS.length) % DESIGN_LIVE_COLORS.length];
const reducedMotion = () => typeof matchMedia === 'function' && matchMedia('(prefers-reduced-motion: reduce)').matches;
/** Live burst elements at most: holding an emote on a slow machine never piles up DOM. */
const MAX_PARTICLES = 80;
const EASE_OUT = 'cubic-bezier(0.22, 1, 0.36, 1)';

export type Badge = {nodeId: NodeId; kind: 'mine'; count: number; color: string; label: string} | {nodeId: NodeId; kind: 'result'; count: number; top: boolean; label: string};

type Placed = {element: HTMLElement; page: Vec; pageId: NodeId};

export class MeetingOverlay {
  private readonly bursts = new Set<Placed>();
  private particles = 0;
  private readonly bubbles = new Map<string, {text: string | null; name: string; wave: boolean; bubble: HTMLElement | null; hand: HTMLElement | null}>();
  private readonly badgeElements = new Map<NodeId, {element: HTMLElement; key: string}>();
  private badges: readonly Badge[] = [];
  private frame = 0;
  /** Frames spent looking for cursors not drawn yet. */
  private tries = 0;
  private readonly off: (() => void)[] = [];

  constructor(
    private readonly root: HTMLElement,
    private readonly store: DesignStore,
    private readonly host: () => HTMLElement | null,
    private readonly targets: MeetingTargets,
    private readonly onRemoveVote: (nodeId: NodeId) => void,
  ) {
    this.off.push(store.subscribe(() => this.schedule(), {slice: ['viewport', 'page', 'doc']}));
  }

  dispose() {
    for (const off of this.off) off();
    cancelAnimationFrame(this.frame);
    for (const id of [...this.bubbles.keys()]) this.gone(id);
    this.root.replaceChildren();
  }

  private schedule() {
    if (!this.frame && (this.bursts.size || this.badges.length || this.pendingCursors())) this.frame = requestAnimationFrame(() => this.draw());
  }
  private toScreen(point: Vec): Vec {
    return pageToScreen(currentViewport(this.store.getState()), point);
  }
  private draw() {
    this.frame = 0;
    const pageId = this.store.getState().pageId;
    for (const burst of this.bursts) {
      const at = this.toScreen(burst.page);
      burst.element.style.transform = `translate3d(${at.x.toFixed(1)}px, ${at.y.toFixed(1)}px, 0)`;
      burst.element.style.visibility = burst.pageId === pageId ? '' : 'hidden';
    }
    this.placeBadges();
    this.attachToCursors();
  }

  // ── Bursts ──

  /** An emote burst (or a high five, bigger) at `page` on `pageId`. */
  burst(page: Vec, pageId: NodeId, emoji: string, kind: 'emote' | 'high-five' = 'emote') {
    if (pageId !== this.store.getState().pageId || this.particles >= MAX_PARTICLES) return;
    const wrap = document.createElement('div');
    wrap.className = `dz-meet-burst${kind === 'high-five' ? ' is-high-five' : ''}`;
    wrap.setAttribute('aria-hidden', 'true');
    const at = this.toScreen(page);
    wrap.style.transform = `translate3d(${at.x.toFixed(1)}px, ${at.y.toFixed(1)}px, 0)`;
    const placed: Placed = {element: wrap, page, pageId};
    const reduce = reducedMotion();
    const main = document.createElement('span');
    main.className = 'dz-meet-burst-main';
    main.textContent = emoji;
    wrap.append(main);
    const animations: Animation[] = [];
    const big = kind === 'high-five';
    if (reduce) {
      animations.push(main.animate([{opacity: 0}, {opacity: 1, offset: 0.15}, {opacity: 1, offset: 0.7}, {opacity: 0}], {duration: big ? 1400 : 1000, easing: 'linear'}));
    } else {
      animations.push(
        main.animate(
          [
            {opacity: 0, transform: 'translate(-50%, -50%) scale(0.8)'},
            {opacity: 1, transform: 'translate(-50%, -50%) scale(1.12)', offset: 0.16},
            {opacity: 1, transform: 'translate(-50%, -62%) scale(1)', offset: 0.45},
            {opacity: 0, transform: `translate(-50%, ${big ? -160 : -210}%) scale(0.92)`},
          ],
          {duration: big ? 1500 : 1100, easing: EASE_OUT},
        ),
      );
      // A few small copies thrown out around it.
      const count = big ? 8 : 5;
      for (let i = 0; i < count; i++) {
        const piece = document.createElement('span');
        piece.className = 'dz-meet-burst-piece';
        piece.textContent = big ? (i % 2 ? '✨' : emoji) : emoji;
        wrap.append(piece);
        const angle = (Math.PI * 2 * i) / count + (Math.random() - 0.5) * 0.9;
        const distance = (big ? 56 : 38) + Math.random() * (big ? 36 : 28);
        const dx = Math.cos(angle) * distance,
          dy = Math.sin(angle) * distance - 18;
        const turn = (Math.random() - 0.5) * 70;
        animations.push(
          piece.animate(
            [
              {opacity: 0, transform: 'translate(-50%, -50%) scale(0.85) rotate(0deg)'},
              {opacity: 1, transform: `translate(calc(-50% + ${(dx * 0.55).toFixed(1)}px), calc(-50% + ${(dy * 0.55).toFixed(1)}px)) scale(1) rotate(${(turn / 2).toFixed(0)}deg)`, offset: 0.35},
              {opacity: 0, transform: `translate(calc(-50% + ${dx.toFixed(1)}px), calc(-50% + ${(dy + 22).toFixed(1)}px)) scale(0.9) rotate(${turn.toFixed(0)}deg)`},
            ],
            {duration: 760 + Math.random() * 260, easing: EASE_OUT, delay: Math.random() * 60},
          ),
        );
      }
    }
    const pieces = wrap.childElementCount;
    this.particles += pieces;
    this.root.append(wrap);
    this.bursts.add(placed);
    void Promise.allSettled(animations.map(animation => animation.finished)).then(() => {
      wrap.remove();
      this.bursts.delete(placed);
      this.particles -= pieces;
    });
  }

  // ── Cursor chat and waves on the others' cursors ──

  /** Someone's cursor as src/design/realtime/PresenceUI.tsx draws it: a sibling layer over the canvas, not inside the canvas's own
   *  element, so it is looked up in the editor (`.dz`), where a connection id names one cursor. */
  private cursorOf(connection: string): HTMLElement | null {
    const scope: ParentNode = this.root.closest('.dz') ?? this.host() ?? this.root.ownerDocument;
    return scope.querySelector<HTMLElement>(`.dz-live-cursor[data-connection="${CSS.escape(connection)}"]`);
  }
  private pendingCursors() {
    for (const entry of this.bubbles.values()) if ((entry.text !== null && !entry.bubble?.isConnected) || (entry.wave && !entry.hand?.isConnected)) return true;
    return false;
  }
  private attachToCursors() {
    for (const [connection, entry] of this.bubbles) {
      const cursor = (entry.text !== null && !entry.bubble?.isConnected) || (entry.wave && !entry.hand?.isConnected) ? this.cursorOf(connection) : null;
      if (!cursor) continue;
      if (entry.text !== null && entry.bubble && !entry.bubble.isConnected) cursor.append(entry.bubble);
      if (entry.wave && entry.hand && !entry.hand.isConnected) cursor.append(entry.hand);
      cursor.classList.toggle('is-chatting', entry.text !== null);
    }
    // A cursor PresenceUI has not drawn yet: try again on the next frames (it makes one on the frame after their presence arrives), for
    // half a second at most; the next change of the people here tries again (`retry`), so nothing loops while a cursor stays away.
    if (!this.pendingCursors()) this.tries = 0;
    else if (!this.frame && this.tries++ < 30) this.frame = requestAnimationFrame(() => this.draw());
  }
  /** The people here changed: hang any chat or hand still waiting for its cursor. */
  retry() {
    this.tries = 0;
    if (this.pendingCursors()) this.schedule();
  }
  private entry(connection: string, name: string) {
    let entry = this.bubbles.get(connection);
    if (!entry) {
      entry = {text: null, name, wave: false, bubble: null, hand: null};
      this.bubbles.set(connection, entry);
    }
    entry.name = name;
    return entry;
  }

  /** Someone's cursor chat: their words under their cursor, in their colour (null closes it). Text only, never markup. */
  chat(connection: string, name: string, text: string | null) {
    const entry = this.entry(connection, name);
    entry.text = text;
    const cursor = this.cursorOf(connection);
    if (text === null) {
      // The words fade (160 ms) and the name label comes back once they are gone.
      const leaving = entry.bubble;
      entry.bubble = null;
      if (leaving?.isConnected) {
        leaving.classList.add('is-leaving');
        setTimeout(() => {
          leaving.remove();
          if (this.bubbles.get(connection)?.text == null) this.cursorOf(connection)?.classList.remove('is-chatting');
        }, 160);
      } else cursor?.classList.remove('is-chatting');
      return;
    }
    if (!entry.bubble) {
      const bubble = document.createElement('div');
      bubble.className = 'dz-meet-chat-remote';
      const who = document.createElement('span');
      who.className = 'dz-meet-chat-name';
      const words = document.createElement('span');
      words.className = 'dz-meet-chat-text';
      bubble.append(who, words);
      entry.bubble = bubble;
    }
    const [who, words] = entry.bubble.children as unknown as [HTMLElement, HTMLElement];
    who.textContent = name;
    words.textContent = text;
    entry.bubble.classList.toggle('is-typing', text === '');
    if (cursor) {
      if (!entry.bubble.isConnected) cursor.append(entry.bubble);
      cursor.classList.add('is-chatting');
    } else this.retry();
  }

  /** Someone waving for a high five: a hand on their cursor. */
  wave(connection: string, name: string, waving: boolean) {
    const entry = this.entry(connection, name);
    entry.wave = waving;
    if (!waving) {
      entry.hand?.remove();
      entry.hand = null;
      return;
    }
    if (!entry.hand) {
      const hand = document.createElement('span');
      hand.className = 'dz-meet-wave';
      hand.textContent = '✋';
      hand.setAttribute('aria-hidden', 'true');
      entry.hand = hand;
    }
    const cursor = this.cursorOf(connection);
    if (cursor) cursor.append(entry.hand);
    else this.retry();
  }

  gone(connection: string) {
    const entry = this.bubbles.get(connection);
    if (!entry) return;
    entry.bubble?.remove();
    entry.hand?.remove();
    this.cursorOf(connection)?.classList.remove('is-chatting');
    this.bubbles.delete(connection);
  }

  // ── Vote badges ──

  setBadges(badges: readonly Badge[]) {
    this.badges = badges;
    const keep = new Set(badges.map(badge => badge.nodeId));
    for (const [id, item] of this.badgeElements)
      if (!keep.has(id)) {
        item.element.remove();
        this.badgeElements.delete(id);
      }
    for (const badge of badges) {
      const key = badge.kind === 'mine' ? `m:${badge.count}:${badge.color}` : `r:${badge.count}:${badge.top}`;
      let item = this.badgeElements.get(badge.nodeId);
      if (item && item.key === key) continue;
      if (!item) {
        const element = document.createElement('div');
        this.root.append(element);
        item = {element, key: ''};
        this.badgeElements.set(badge.nodeId, item);
      }
      item.key = key;
      this.fillBadge(item.element, badge);
    }
    this.placeBadges();
  }

  private fillBadge(element: HTMLElement, badge: Badge) {
    element.replaceChildren();
    if (badge.kind === 'result') {
      element.className = `dz-meet-badge is-result${badge.top ? ' is-top' : ''}`;
      element.setAttribute('role', 'img');
      element.setAttribute('aria-label', `${badge.label}: ${badge.count} ${votesWord(badge.count)}`);
      element.textContent = String(badge.count);
      return;
    }
    element.className = 'dz-meet-badge is-mine';
    element.removeAttribute('role');
    element.removeAttribute('aria-label');
    element.style.setProperty('--dz-meet-dot', badge.color);
    const shown = Math.min(badge.count, 3);
    for (let i = 0; i < shown; i++) {
      const dot = document.createElement('button');
      dot.type = 'button';
      dot.className = 'dz-meet-dot';
      dot.setAttribute('aria-label', `Remove vote: ${badge.label}`);
      dot.addEventListener('pointerdown', event => event.stopPropagation());
      dot.addEventListener('click', event => {
        event.stopPropagation();
        this.onRemoveVote(badge.nodeId);
      });
      element.append(dot);
    }
    if (badge.count > 3) {
      const more = document.createElement('span');
      more.className = 'dz-meet-dot-more';
      more.textContent = `×${badge.count}`;
      element.append(more);
    }
  }

  private placeBadges() {
    if (!this.badges.length) return;
    const state = this.store.getState();
    for (const badge of this.badges) {
      const item = this.badgeElements.get(badge.nodeId);
      if (!item) continue;
      const box = pageOfNode(state.doc, badge.nodeId) === state.pageId ? this.targets.box(state.doc, badge.nodeId) : null;
      if (!box) {
        item.element.style.visibility = 'hidden';
        continue;
      }
      const corner = this.toScreen({x: box.x + box.width, y: box.y});
      item.element.style.visibility = '';
      // The badge's right edge sits 6 px inside the object's corner, half above its top edge.
      item.element.style.transform = `translate3d(${(corner.x - 6).toFixed(1)}px, ${corner.y.toFixed(1)}px, 0) translate(-100%, -50%)`;
    }
  }
}

export const votesWord = (count: number) => {
  return count === 1 ? 'vote' : 'votes';
};
