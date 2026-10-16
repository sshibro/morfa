import {useCallback, useState} from 'react';
import type {FigmaConnectionState} from '../../shared/figma/api';
import {FIGMA_SESSION_ONLY} from './connection-api';

export type FigmaConnectBusy = 'token' | 'oauth' | 'oauth-wait' | 'disconnect' | null;

const NO_SAVED_CONNECTION = 'There is no saved Figma connection: paste an access token for this import.';

/**
 * The Figma connection of the signed-in account, as the import dialog reads it. Morfa's server keeps none
 * (connection-api.ts), so the state is always "session only" and the dialog asks for a token for this import;
 * the connect, OAuth and disconnect actions are never offered there.
 */
export function useFigmaConnection() {
  const [state] = useState<FigmaConnectionState | null>(FIGMA_SESSION_ONLY);
  const [error, setError] = useState('');
  const refuse = useCallback(() => setError(NO_SAVED_CONNECTION), []);
  const connectToken = useCallback(async (_raw: string) => {
    refuse();
    return false;
  }, [refuse]);
  const lost = useCallback(() => undefined, []);
  return {state, loadError: '', busy: null as FigmaConnectBusy, error, connectToken, connectOAuth: refuse, disconnect: refuse, lost};
}

export type FigmaConnectionHandle = ReturnType<typeof useFigmaConnection>;
