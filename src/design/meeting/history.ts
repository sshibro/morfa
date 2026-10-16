import type {DesignMeetingVotes} from '../../../shared/design/meeting';
import {api} from '../../api';

// Past voting sessions (help.figma.com "Run voting sessions in FigJam": "View results … Select the Results tab … delete results"), on
// lane S's routes: the last twenty ended sessions of a file, newest first; an editor deletes one.

const base = (fileId: string) => `/design-files/${encodeURIComponent(fileId)}/meeting/votes`;
export const pastVotes = (fileId: string) => api<DesignMeetingVotes>(base(fileId), {cache: 'no-store'});
export const deletePastVote = (fileId: string, voteId: string) => api<{ok: true}>(`${base(fileId)}/${encodeURIComponent(voteId)}`, {method: 'DELETE'});
