import {designIdFromHash} from '../../navigation';
import {playTarget} from '../../../shared/design/prototype';
import {registerEditorPanel} from '../editor/services';
import {registerPasteHandler} from '../engine/commands/clipboard';
import {registerCommand} from '../engine/commands/registry';
import {pasteReactions} from './reaction-clipboard';
import {ensurePlayerFeed} from './feed';
import {openPlayer} from './open-player';
import {PrototypePanel} from './PrototypePanel';

// Prototyping in the editor (one import line in DesignEditor.tsx): the "Prototype" tab (which also
// draws the connections on the canvas while it is open) and ▶ "Run prototype" (⌥⌘↩), which
// opens the player in a new tab and streams the open document to it.

registerEditorPanel('prototype', PrototypePanel);
// ⌘V of an interaction copied in its details adds it to the selected layers (reaction-clipboard.ts).
registerPasteHandler(pasteReactions);

registerCommand({
  id: 'prototype.play',
  label: 'Run prototype',
  group: 'view',
  shortcut: {code: 'Enter', alt: true, mod: true},
  run(ctx) {
    const state = ctx.store.getState();
    const fileId = designIdFromHash(location.hash);
    if (!fileId) throw new Error('Open a file to run the prototype.');
    const frame = playTarget(state.doc, state.pageId, state.selection);
    if (!frame) throw new Error('The page has no frames: add a frame to run the prototype.');
    ensurePlayerFeed(fileId, ctx.store, document.querySelector('.dz-editor'));
    openPlayer(fileId, frame);
  },
});
