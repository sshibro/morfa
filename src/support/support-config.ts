// How support can be reached, from the /api/config answer App loads at start: Morfa's own support chat when the server says
// it is on (`supportChat`: an operator is named and SUPPORT_CHAT is not 0, server/support/config.ts), otherwise the address
// or page the server names, so "Help ▸ Contact support" offers only what the server configures.

export type SupportSwitch = {supportChat: boolean; supportEmail: string | null};

let current: SupportSwitch | null = null;
// The whole answer, for fields read where they are used (the help command's `publicSupportUrl`).
let raw: unknown;

/** Anything malformed reads as "no chat, no address" (the server validates the address). */
export function readSupportConfig(source: unknown): SupportSwitch {
  const value = (source && typeof source === 'object' ? source : {}) as Record<string, unknown>;
  const email = typeof value.supportEmail === 'string' ? value.supportEmail.trim() : '';
  return {supportChat: value.supportChat === true, supportEmail: email.includes('@') ? email : null};
}

/** App passes the /api/config answer here once it has it. */
export function primeSupportConfig(source: unknown) {
  raw = source;
  current = readSupportConfig(source);
}

/** Tests start from a clean state. */
export function resetSupportConfig() {
  raw = undefined;
  current = null;
}

/** null until App has passed its config. */
export const supportConfigNow = (): SupportSwitch | null => current;
export const supportConfigSource = (): unknown => raw;
/** The support chat is on for this app (src/support/SupportHost.tsx listens for it). */
export const supportChatOn = (): boolean => current?.supportChat === true;
