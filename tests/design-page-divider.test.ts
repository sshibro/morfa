import {test} from 'node:test';
import assert from 'node:assert/strict';
import {isPageDivider} from '../src/design/panels/left/page-actions';

// Page dividers (help.figma.com "Create and manage pages"): an empty page whose name starts with "-".

test('should make an empty page named with a leading dash a divider, and nothing else', () => {
  assert.equal(isPageDivider('---', true), true);
  assert.equal(isPageDivider(' - Archive', true), true);
  assert.equal(isPageDivider('---', false), false, 'a page with layers stays a page');
  assert.equal(isPageDivider('Screen - 2', true), false, 'only a leading dash');
});
