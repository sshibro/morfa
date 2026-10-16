import {post} from '../../api';
import type {DesignFileSummary} from '../../../shared/design/api';

// "Duplicate to personal files" from the trash, Figma's "Duplicate to drafts" (lane S's route, kept apart from src/design/api.ts):
// a copy of a trashed file, made in the caller's personal files; the trashed file stays where it is.

/** POST /api/design-files/:id/duplicate-to-drafts: 201 with the new file's summary (as `{file}` or bare). */
export async function duplicateToDrafts(id: string): Promise<DesignFileSummary> {
  const answer = await post<{file: DesignFileSummary} | DesignFileSummary>(`/design-files/${encodeURIComponent(id)}/duplicate-to-drafts`);
  return 'file' in answer ? answer.file : answer;
}
