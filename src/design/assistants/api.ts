import {api, ApiError} from '../../api';

// "Connections" (server/mcp/connections-router.ts): the assistants the account let into its files, and the address they connect
// to. 404 means the MCP server is off or not open to this account: the screen is not offered.

export type AssistantConnection = {id: string; clientName: string; clientHost: string; createdAt: string; lastUsedAt: string | null};
export type AssistantsState = {url: string; connections: AssistantConnection[]};

export async function readAssistants(signal?: AbortSignal): Promise<AssistantsState | null> {
  try {
    return await api<AssistantsState>('/mcp/connections', {signal});
  } catch (error) {
    if (error instanceof ApiError && error.status === 404) return null;
    throw error;
  }
}

export const disconnectAssistant = (id: string) => api<{ok: true}>(`/mcp/connections/${encodeURIComponent(id)}`, {method: 'DELETE'});
