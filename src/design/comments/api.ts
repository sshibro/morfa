import {api, post} from '../../api';
import {readApi} from '../../api-read';
import type {DesignCommentChange, DesignCommentDraft, DesignCommentList, DesignCommentThread, DesignThreadCreate} from '../../../shared/design/comments';
import type {DesignTeamMembers} from '../../../shared/design/teams';

// Client of `/api/design-files/:id/comments` (routes in shared/design/comments.ts). Reads retry through readApi; writes go through api(),
// which carries the account header and its generation check.

const base = (fileId: string) => `/design-files/${encodeURIComponent(fileId)}/comments`;
const thread = (fileId: string, threadId: string) => `${base(fileId)}/${encodeURIComponent(threadId)}`;
const json = (method: string, data: unknown): RequestInit => ({method, body: JSON.stringify(data)});

export const listComments = (fileId: string, since: number, signal?: AbortSignal) =>
  readApi<DesignCommentList>(base(fileId) + (since > 0 ? `?since=${since}` : ''), {signal});
export const createCommentThread = (fileId: string, input: DesignThreadCreate) => post<{thread: DesignCommentThread}>(base(fileId), input);
export const replyToComment = (fileId: string, threadId: string, draft: DesignCommentDraft) =>
  post<{thread: DesignCommentThread}>(thread(fileId, threadId) + '/replies', draft);
export const editComment = (fileId: string, threadId: string, commentId: string, draft: DesignCommentDraft) =>
  api<{thread: DesignCommentThread}>(`${thread(fileId, threadId)}/messages/${encodeURIComponent(commentId)}`, json('PATCH', draft));
export const deleteComment = (fileId: string, threadId: string, commentId: string) =>
  api<{thread: DesignCommentChange}>(`${thread(fileId, threadId)}/messages/${encodeURIComponent(commentId)}`, {method: 'DELETE'});
export const deleteCommentThread = (fileId: string, threadId: string) => api<{thread: DesignCommentChange}>(thread(fileId, threadId), {method: 'DELETE'});
export const resolveCommentThread = (fileId: string, threadId: string, resolved: boolean) =>
  api<{thread: DesignCommentThread}>(thread(fileId, threadId), json('PATCH', {resolved}));
export const markCommentsRead = (fileId: string, threads: readonly string[]) => post<{ok: true}>(base(fileId) + '/read', {threads});
/** The members a team file's comments can mention (names only for non-managers). */
export const listTeamMembers = (teamId: string) => readApi<DesignTeamMembers>(`/design-teams/${encodeURIComponent(teamId)}/members`);
