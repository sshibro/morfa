// How the Figma import reaches Figma (src/figma-import). The types only.
// Morfa's server keeps no Figma connection (no OAuth app, no stored token, no /api/figma routes), so the import
// always reads with a personal access token kept for that one import (src/figma-import/connection-api.ts).

export type FigmaConnectionKind = 'token' | 'oauth';

export type FigmaConnection = {kind: FigmaConnectionKind; handle?: string; connectedAt: string; expiresAt?: string};

export type FigmaConnectionState = {
  // The server offers a connection of its own; off in Morfa.
  enabled: boolean;
  // "Sign in with Figma" works.
  oauth: boolean;
  // The server can keep a token (encryption configured).
  remember: boolean;
  // Pages a site may have on the account's plan; unused here.
  pagesLimit: number;
  connection: FigmaConnection | null;
};

export type FigmaTokenAnswer = {token: string; kind: FigmaConnectionKind; expiresAt?: string};

export const FIGMA_RECONNECT = 'figma_reconnect';
