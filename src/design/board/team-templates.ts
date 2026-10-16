import type {NodeId, SceneNode, Vec} from '../../../shared/design/types';
import type {DesignTemplateAnswer, DesignTemplateContent, DesignTemplateList, DesignTemplatePublish, DesignTemplateSummary, DesignTemplateUpdate} from '../../../shared/design/api';
import {api, post} from '../../api';
import type {DesignStore} from '../engine/store';
import type {Command} from '../engine/commands';

// Custom team templates (help.figma.com "Create custom templates in FigJam"): a team's
// board published as a template ("File → Publish as template…"), listed in the "+" sheet's templates for the team's people and
// put on the board from there. The board tells this module its file and team (BoardLayout).

let place: {fileId: string; teamId: string | null; canEdit: boolean} | null = null;
const listeners = new Set<() => void>();

export function setTemplatePlace(next: {fileId: string; teamId: string | null; canEdit: boolean} | null): () => void {
  place = next;
  for (const listener of [...listeners]) listener();
  return () => {
    if (place === next) {
      place = null;
      for (const listener of [...listeners]) listener();
    }
  };
}
export const templatePlace = () => place;
export function subscribeTemplatePlace(listener: () => void) {
  listeners.add(listener);
  return () => void listeners.delete(listener);
}

let publisher: (() => void) | null = null;
/** Who opens "Publish as template…" (the board's dialogs, while mounted). */
export function setTemplatePublisher(open: (() => void) | null): () => void {
  publisher = open;
  return () => {
    if (publisher === open) publisher = null;
  };
}

/** "File → Publish as template…": registered with the board's other commands, enabled on a team board an editor opened. */
export const PUBLISH_TEMPLATE_COMMAND: Command = {
  id: 'board.template-publish', label: 'Publish as template…', group: 'board',
  enabled: () => canPublishTemplate() && !!publisher,
  run: () => publisher?.(),
};

/** Templates belong to teams: a board in a team, opened by one of its editors, can publish and insert them. */
export const canPublishTemplate = () => !!place?.teamId && place.canEdit;

const file = (fileId: string) => `/design-files/${encodeURIComponent(fileId)}`;

export const listTeamTemplates = (teamId: string) => api<DesignTemplateList>(`/design-templates?teamId=${encodeURIComponent(teamId)}`);
export const publishTemplate = (fileId: string, body: DesignTemplatePublish) => post<DesignTemplateAnswer>(file(fileId) + '/template', body);
export const updateTemplate = (fileId: string, body: DesignTemplateUpdate) =>
  api<DesignTemplateAnswer>(file(fileId) + '/template', {method: 'PATCH', body: JSON.stringify(body)});
export const templateContent = (templateId: string, fileId: string) =>
  api<DesignTemplateContent>(`/design-templates/${encodeURIComponent(templateId)}/content?fileId=${encodeURIComponent(fileId)}`);

/** Puts a template's content on the board with its top-left corner at `corner`, its pictures added to the file's table, as one
 *  undo step; answers its top-level objects and box. */
export function insertTemplateContent(store: DesignStore, template: DesignTemplateSummary, content: DesignTemplateContent, corner: Vec): {roots: NodeId[]; bounds: DesignTemplateContent['bounds']} {
  const roots = new Set(content.roots);
  const dx = Math.round(corner.x - content.bounds.x), dy = Math.round(corner.y - content.bounds.y);
  const {pageId} = store.getState();
  store.transact(`Template "${template.name}"`, tx => {
    for (const [ref, asset] of Object.entries(content.images)) tx.setImage(ref, asset);
    for (const node of content.pieces) {
      const isRoot = roots.has(node.id);
      // Roots keep the page's coordinates (a connector's place comes from its ends); everything moves by the same step.
      const placed: SceneNode = isRoot && node.board?.kind !== 'connector' ? {...node, x: node.x + dx, y: node.y + dy} : node;
      tx.create({...placed, parentId: isRoot ? pageId : placed.parentId}, isRoot ? pageId : placed.parentId!);
    }
  }, {select: content.roots});
  return {roots: content.roots, bounds: {...content.bounds, x: content.bounds.x + dx, y: content.bounds.y + dy}};
}
