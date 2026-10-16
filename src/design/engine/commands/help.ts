import {openSupport} from '../../../support/open';
import {supportConfigNow, supportConfigSource} from '../../../support/support-config';
import type {DesignStore} from '../store';
import {registerCommand, type Command} from './registry';

// "Help ▸ Guide" (the guide dialog, GUIDE_DIALOG) and "Help ▸ Contact support": the
// same way into support as the rest of the app (src/support/open.ts): the support chat when it is on,
// otherwise the support address or page the server names in /api/config. With none of them the
// command is shown disabled, never pointing at an invented contact.

export const GUIDE_DIALOG = 'guide';

export type SupportChannel = {kind: 'chat'} | {kind: 'email'; address: string} | {kind: 'page'; url: string};

/** How support can be reached now, from the app's /api/config answer (null: no contact is set). */
export function supportChannel(config = supportConfigNow(), raw: unknown = supportConfigSource()): SupportChannel | null {
  if (config?.supportChat) return {kind: 'chat'};
  if (config?.supportEmail) return {kind: 'email', address: config.supportEmail};
  const url = raw && typeof raw === 'object' ? (raw as {publicSupportUrl?: unknown}).publicSupportUrl : undefined;
  if (typeof url === 'string') {
    try {
      const parsed = new URL(url);
      if (parsed.protocol === 'https:' || parsed.protocol === 'http:') return {kind: 'page', url: parsed.href};
    } catch {
      // Not a link: no page.
    }
  }
  return null;
}

export function contactSupport(channel = supportChannel()): boolean {
  if (!channel) return false;
  if (channel.kind === 'chat') openSupport({source: 'help', projectId: null});
  else if (channel.kind === 'email') globalThis.location.href = `mailto:${channel.address}`;
  else globalThis.open(channel.url, '_blank', 'noopener');
  return true;
}

export type HelpHost = {openDialog(id: string, params?: Record<string, unknown>): void};
const hosts = new WeakMap<DesignStore, HelpHost>();

export function connectHelp(store: DesignStore, host: HelpHost): () => void {
  hosts.set(store, host);
  return () => {
    if (hosts.get(store) === host) hosts.delete(store);
  };
}

export const HELP_COMMANDS: Command[] = [
  {
    id: 'help.guide',
    label: 'Guide',
    group: 'help',
    enabled: ctx => hosts.has(ctx.store),
    run: ctx => hosts.get(ctx.store)?.openDialog(GUIDE_DIALOG),
  },
  {
    id: 'help.support',
    label: 'Contact support',
    group: 'help',
    enabled: () => supportChannel() !== null,
    run: () => void contactSupport(),
  },
];

let registered = false;
/** Idempotent. */
export function registerHelpCommands() {
  if (registered) return;
  registered = true;
  for (const command of HELP_COMMANDS) registerCommand(command);
}
