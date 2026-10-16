// A finger held still on the phone's chrome (a layer, a page, an asset, a style) opens that thing's context menu, as a
// right click does on a desktop. iOS Safari sends
// no `contextmenu` for a long press, so this sends one; Chrome's own, if it comes, is swallowed so the menu opens once.
// The canvas has its own long press (engine/touch/gestures.ts) and is left alone.

/** ms a still finger is held; the canvas uses the same (engine/touch/gestures.ts LONG_PRESS_MS). */
const HOLD_MS = 500;
/** CSS px a finger may wander and still be held. */
const SLOP = 8;
/** ms after the menu opened in which the browser's own contextmenu and the lift's click are echoes. */
const ECHO_MS = 1000;

const SKIP = 'input, textarea, select, [contenteditable="true"], [role="application"], canvas';

export function installLongPress(root: HTMLElement): () => void {
  let hold: {id: number; x: number; y: number; target: Element; timer: ReturnType<typeof setTimeout>; ready: boolean} | null = null;
  let firedAt = -Infinity;
  /** The lift after a long press may still click, and not where the finger went down: a menu that opens as a sheet from
   *  the bottom slides in under the finger, and the click would press whatever row is there. That click is an echo, once,
   *  wherever it lands; a new press ends the wait, so a deliberate tap on the menu is never swallowed. */
  let liftEcho = false;
  /** The browser's own long-press contextmenu is an echo, once. */
  let menuEcho = false;

  const stop = () => {
    if (hold) clearTimeout(hold.timer);
    hold = null;
  };
  const down = (event: PointerEvent) => {
    stop();
    liftEcho = false;
    const target = event.target as Element | null;
    if (event.pointerType !== 'touch' || !target || !root.contains(target) || target.closest(SKIP)) return;
    const {clientX: x, clientY: y, pointerId: id} = event;
    const pressed = {id, x, y, target, ready: false, timer: setTimeout(() => {
      pressed.ready = true;
    }, HOLD_MS)};
    hold = pressed;
  };
  const move = (event: PointerEvent) => {
    if (hold && event.pointerId === hold.id && Math.hypot(event.clientX - hold.x, event.clientY - hold.y) > SLOP) stop();
  };
  /** The menu opens as the held finger lifts: opened under it, the menu would take the release as a choice. */
  const end = (event: PointerEvent) => {
    if (!hold || event.pointerId !== hold.id) return;
    const {ready, target, x, y} = hold;
    stop();
    if (ready && event.type === 'pointerup') fire(target, x, y);
  };
  const fire = (target: Element, x: number, y: number) => {
    firedAt = performance.now();
    liftEcho = true;
    menuEcho = true;
    target.dispatchEvent(new MouseEvent('contextmenu', {bubbles: true, cancelable: true, composed: true, clientX: x, clientY: y, button: 2, buttons: 0}));
  };
  /** The browser's own long-press menu event (Chrome sends one while the finger is still down): ours goes out as the finger
   *  lifts instead, so this one is swallowed, as is one that comes after ours. */
  const nativeMenu = (event: MouseEvent) => {
    if (!event.isTrusted) return;
    const echo = menuEcho && performance.now() - firedAt < ECHO_MS;
    if (!hold && !echo) return;
    menuEcho = false;
    event.preventDefault();
    event.stopPropagation();
  };
  /** The lift's compatibility mousedown would take the focus off the menu that just opened (a keyboard's Escape would
   *  then not reach it); it is an echo too. */
  const mouseDown = (event: MouseEvent) => {
    if (!liftEcho || performance.now() - firedAt >= ECHO_MS) return;
    event.preventDefault();
    event.stopPropagation();
  };
  const click = (event: MouseEvent) => {
    const echo = liftEcho;
    liftEcho = false;
    if (!echo || performance.now() - firedAt >= ECHO_MS) return;
    event.preventDefault();
    event.stopPropagation();
  };

  const options = {capture: true, passive: true} as const;
  document.addEventListener('pointerdown', down, options);
  document.addEventListener('pointermove', move, options);
  document.addEventListener('pointerup', end, options);
  document.addEventListener('pointercancel', end, options);
  document.addEventListener('contextmenu', nativeMenu, true);
  document.addEventListener('mousedown', mouseDown, true);
  document.addEventListener('click', click, true);
  return () => {
    stop();
    document.removeEventListener('pointerdown', down, options);
    document.removeEventListener('pointermove', move, options);
    document.removeEventListener('pointerup', end, options);
    document.removeEventListener('pointercancel', end, options);
    document.removeEventListener('contextmenu', nativeMenu, true);
    document.removeEventListener('mousedown', mouseDown, true);
    document.removeEventListener('click', click, true);
  };
}

/** Safari's own pinch zoom of the page (its `gesturestart`): never while the editor is on a phone; the canvas zooms itself. */
export function blockPageZoom(): () => void {
  const block = (event: Event) => event.preventDefault();
  document.addEventListener('gesturestart', block, {passive: false});
  return () => document.removeEventListener('gesturestart', block);
}
