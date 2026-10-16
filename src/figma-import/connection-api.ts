import {FIGMA_RECONNECT, type FigmaConnectionState, type FigmaTokenAnswer} from '../../shared/figma/api';
import {ApiError} from '../api';

// Morfa's server keeps no Figma connection: no OAuth app and no stored token. The design tool's import therefore reads with a personal access token the person pastes for that one
// import and that lives only in the dialog (src/design/import/figma/FigmaImportDialog.tsx, mode "session").
// When Morfa gets a Figma connection of its own, this file talks to it.

/** The only state Morfa has: the server offers no connection of its own. */
export const FIGMA_SESSION_ONLY: FigmaConnectionState = {enabled: false, oauth: false, remember: false, pagesLimit: 0, connection: null};

export const loadFigmaConnection = (): Promise<FigmaConnectionState> => Promise.resolve(FIGMA_SESSION_ONLY);

/** A token the server keeps; there is none in Morfa, so the person pastes one again. */
export function figmaAccessToken(): Promise<FigmaTokenAnswer> {
  return Promise.reject(new ApiError('The Figma connection is not saved. Paste a Figma access token.', 409, {code: FIGMA_RECONNECT}));
}
