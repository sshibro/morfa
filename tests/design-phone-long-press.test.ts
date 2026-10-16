import {afterEach, beforeEach, mock, test} from 'node:test';
import assert from 'node:assert/strict';
import {installLongPress} from '../src/design/editor/phone/long-press';

// A finger held still on the phone's chrome opens a context menu (src/design/editor/phone/long-press.ts). On a phone that
// menu is a sheet from the bottom, so it can slide in under the finger: the lift's click must press nothing, and the next
// deliberate tap must still work.

const HOLD_MS = 500;

/** A page that is one node: every event's target is the page itself, which is not a field. `contains` answers «is this
 *  click inside what the finger went down on?» with no: the lift landed on something else, as on a menu's row. */
class Page extends EventTarget {
  closest() { return null; }
  contains() { return false; }
}
/** The chrome the long press watches: everything on the page is inside it. */
const CHROME = {contains: () => true} as unknown as HTMLElement;

const touch = (type: string) => Object.assign(new Event(type, {cancelable: true}), {pointerType: 'touch', pointerId: 1, clientX: 40, clientY: 60});
const click = () => new Event('click', {cancelable: true});

let page: Page;
let uninstall: () => void;
const globals = globalThis as unknown as {document?: unknown; MouseEvent?: unknown};
const saved = {document: globals.document, MouseEvent: globals.MouseEvent};

beforeEach(() => {
  mock.timers.enable({apis: ['setTimeout']});
  page = new Page();
  globals.document = page;
  globals.MouseEvent = class extends Event {};
  uninstall = installLongPress(CHROME);
});

afterEach(() => {
  uninstall();
  mock.timers.reset();
  globals.document = saved.document;
  globals.MouseEvent = saved.MouseEvent;
});

function holdUntilTheMenuOpens() {
  let opened = 0;
  page.addEventListener('contextmenu', () => { opened += 1; });
  page.dispatchEvent(touch('pointerdown'));
  mock.timers.tick(HOLD_MS);
  // The menu opens as the held finger lifts (a menu under a finger would take its release).
  page.dispatchEvent(touch('pointerup'));
  return () => opened;
}

test('should ask for the context menu once when a finger held still lifts', () => {
  const opened = holdUntilTheMenuOpens();

  assert.equal(opened(), 1);
});

test('should swallow the click of the lift wherever it lands when the menu has opened under the finger', () => {
  holdUntilTheMenuOpens();
  page.dispatchEvent(touch('pointerup'));
  const lift = click();

  page.dispatchEvent(lift);

  assert.equal(lift.defaultPrevented, true);
});

test('should let a deliberate tap through when it follows the lift', () => {
  holdUntilTheMenuOpens();
  page.dispatchEvent(touch('pointerup'));
  page.dispatchEvent(touch('pointerdown'));
  page.dispatchEvent(touch('pointerup'));
  const tap = click();

  page.dispatchEvent(tap);

  assert.equal(tap.defaultPrevented, false);
});

test('should swallow only one click when the lift clicks', () => {
  holdUntilTheMenuOpens();
  page.dispatchEvent(click());
  const second = click();

  page.dispatchEvent(second);

  assert.equal(second.defaultPrevented, false);
});

test('should leave a click alone when no finger was held', () => {
  const plain = click();

  page.dispatchEvent(plain);

  assert.equal(plain.defaultPrevented, false);
});

test('should ask for no context menu when the finger lifts before the hold', () => {
  let opened = 0;
  page.addEventListener('contextmenu', () => { opened += 1; });
  page.dispatchEvent(touch('pointerdown'));
  mock.timers.tick(HOLD_MS - 100);
  page.dispatchEvent(touch('pointerup'));

  assert.equal(opened, 0);
});
