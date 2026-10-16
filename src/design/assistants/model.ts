import type {AssistantConnection} from './api';

// Which assistant a connection is, for its icon: by the address it signs in back to (oauth_clients.redirect_uris), then by its name.

export type AssistantKind = 'claude' | 'chatgpt' | 'other';

export function assistantKind(connection: Pick<AssistantConnection, 'clientHost' | 'clientName'>): AssistantKind {
  const host = connection.clientHost.toLowerCase(),
    name = connection.clientName.toLowerCase();
  if (host.endsWith('claude.ai') || host.endsWith('anthropic.com') || /\bclaude\b/.test(name)) return 'claude';
  if (host.endsWith('chatgpt.com') || host.endsWith('openai.com') || /chatgpt|openai|codex/.test(name)) return 'chatgpt';
  return 'other';
}

/** Where each assistant adds a connector (their own settings pages). */
export const ASSISTANT_SETTINGS = {
  claude: 'https://claude.ai/customize/connectors',
  chatgpt: 'https://chatgpt.com/plugins',
} as const;

const DAY = 24 * 60 * 60 * 1000;
const dateFormat = new Intl.DateTimeFormat('en-US', {day: 'numeric', month: 'long'});

/** "today", "yesterday" or "October 12". */
export function dayLabel(iso: string, now: Date = new Date()): string {
  const at = new Date(iso);
  if (Number.isNaN(at.getTime())) return '';
  const start = new Date(now.getFullYear(), now.getMonth(), now.getDate()).getTime();
  if (at.getTime() >= start) return 'today';
  if (at.getTime() >= start - DAY) return 'yesterday';
  return dateFormat.format(at);
}

/** The line under a connection: when it was allowed and when it last worked. */
export function connectionLine(connection: Pick<AssistantConnection, 'createdAt' | 'lastUsedAt'>, now: Date = new Date()): string {
  const since = `Connected ${dayLabel(connection.createdAt, now)}`;
  return connection.lastUsedAt ? `${since} · last used ${dayLabel(connection.lastUsedAt, now)}` : `${since} · not used yet`;
}
