import {afterEach, test} from 'node:test';
import assert from 'node:assert/strict';
import {isPhone, isTablet, PHONE_MAX_WIDTH, PHONE_QUERY, TABLET_MAX_WIDTH, TABLET_QUERY} from '../src/design/ui/viewport';

// The one phone breakpoint of the tool (src/design/ui/viewport.ts): what it asks the browser, and what it answers.

const original = globalThis.matchMedia;
const browserAt = (width: number) => {
  const asked: string[] = [];
  globalThis.matchMedia = ((query: string) => {
    asked.push(query);
    return {matches: width <= PHONE_MAX_WIDTH, addEventListener: () => undefined, removeEventListener: () => undefined};
  }) as unknown as typeof matchMedia;
  return asked;
};

afterEach(() => {
  globalThis.matchMedia = original;
});

test('should say phone when the screen is as wide as the breakpoint or narrower', () => {
  browserAt(PHONE_MAX_WIDTH);

  assert.equal(isPhone(), true);
});

test('should say not a phone when the screen is wider than the breakpoint', () => {
  browserAt(PHONE_MAX_WIDTH + 1);

  assert.equal(isPhone(), false);
});

test('should ask the browser with the query the stylesheets use', () => {
  const asked = browserAt(390);

  isPhone();

  assert.deepEqual(asked, [PHONE_QUERY]);
  assert.equal(PHONE_QUERY, '(max-width: 767px)');
});

test('should say not a phone when there is no browser to ask', () => {
  globalThis.matchMedia = undefined as unknown as typeof matchMedia;

  assert.equal(isPhone(), false);
});

// The tablet range: 768–1023 px on a touch screen.

const tabletAt = (width: number, coarse: boolean) => {
  const asked: string[] = [];
  globalThis.matchMedia = ((query: string) => {
    asked.push(query);
    const matches = query === TABLET_QUERY ? width > PHONE_MAX_WIDTH && width <= TABLET_MAX_WIDTH && coarse : width <= PHONE_MAX_WIDTH;
    return {matches, addEventListener: () => undefined, removeEventListener: () => undefined};
  }) as unknown as typeof matchMedia;
  return asked;
};

test('should say tablet when a touch screen is between the phone and the desktop widths', () => {
  tabletAt(820, true);

  assert.equal(isTablet(), true);
  assert.equal(isPhone(), false);
});

test('should not say tablet when the pointer is a mouse at a tablet width', () => {
  tabletAt(820, false);

  assert.equal(isTablet(), false);
});

test('should not say tablet when a touch screen is wider than the tablet range', () => {
  tabletAt(TABLET_MAX_WIDTH + 1, true);

  assert.equal(isTablet(), false);
});

test('should ask the browser with the tablet query the stylesheets use', () => {
  const asked = tabletAt(820, true);

  isTablet();

  assert.deepEqual(asked, [TABLET_QUERY]);
  assert.equal(TABLET_QUERY, '(min-width: 768px) and (max-width: 1023px) and (pointer: coarse)');
});
