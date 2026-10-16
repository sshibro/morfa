import type {DesignStore} from '../store';
import {registerTextCommands} from '../commands/text';
import {registerTextTool} from '../tools/text';
import {setTextEditorDeps, type TextEditorDeps} from './registry';

// The text feature's one entry point for an open file: registers "Text" (T) and the text
// commands, gives the editor the fonts and pictures it draws with, and makes "editing a text" mean
// "the text tool is active" — a double click with "Move" or Enter only set `state.editing`;
// the tool switch that follows puts the text editor in charge of the canvas.

export {activeTextEdit, lastTextStyle, rememberTextStyle, subscribeTextEditing, textEditingSnapshot, textEditorDeps, type ActiveTextEdit, type TextEditingSnapshot, type TextEditorDeps} from './registry';
export {TextEditSession, displayNodeOf, type EndReason} from './session';

export type InstallTextEditing = TextEditorDeps & {store: DesignStore};

/** Call once per open file (DesignEditor, after the store and the services exist). Returns the undo. */
export function installTextEditing({store, ...deps}: InstallTextEditing): () => void {
  registerTextTool();
  registerTextCommands();
  setTextEditorDeps(store, deps);
  const follow = () => {
    const state = store.getState();
    // "Text on path" edits the text it starts itself (engine/tools/text-path.ts).
    if (state.editing?.kind === 'text' && state.tool !== 'text' && state.tool !== 'text-path') store.setTool('text');
  };
  const off = store.subscribe(follow, {slice: 'editing'});
  follow();
  return () => {
    off();
    setTextEditorDeps(store, null);
  };
}
