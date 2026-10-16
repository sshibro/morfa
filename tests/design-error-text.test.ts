// What the shell says when an action fails (src/design/ui/error-text.ts).
import {test} from 'node:test';
import assert from 'node:assert/strict';
import {errorText, OFFLINE_TEXT} from '../src/design/ui/error-text';

test('should say the network is gone when a request never reached the server', () => {
  for (const message of ['Failed to fetch', 'Load failed', 'NetworkError when attempting to fetch resource.']) {
    assert.equal(errorText(new TypeError(message)), OFFLINE_TEXT);
  }
});

test('should show the server\'s sentences as they are and give way to the fallback for anything else', () => {
  assert.equal(errorText(new Error('File not found.')), 'File not found.');
  assert.equal(errorText(new Error('Internal Server Error'), 'Could not create the file.'), 'Could not create the file.');
  assert.equal(errorText(new TypeError('x is undefined')), 'Could not complete the action.');
  assert.equal(errorText('boom'), 'Could not complete the action.');
});
