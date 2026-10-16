import type {NodeId} from '../../../shared/design/types';
import {newId} from '../../../shared/design/defaults';
import {fitSection} from '../../../shared/design/board/arrange';
import {buildBoardTemplate, insertBoardTemplate, type BoardTemplateId} from '../../../shared/design/board/templates';
import type {DesignStore} from '../engine/store';
import {boardChoices, setBoardChoices} from './state';
import type {Command, CommandContext} from '../engine/commands';

// A section's own keys (help.figma.com "Organize your FigJam board with sections"): ⌫ deletes a section with its contents (the
// editor's "Delete"); ⌘⌫ deletes the section alone and leaves its contents where they are on the board, selected.

/** The selected sections that can go: not locked, on an editable board. */
function sectionsOf(ctx: CommandContext): NodeId[] {
  if (ctx.store.readOnly) return [];
  const {doc, selection} = ctx.store.getState();
  return selection.filter(id => doc.nodes[id]?.type === 'SECTION' && !doc.nodes[id].locked);
}

export const SECTION_UNWRAP: Command = {
  id: 'board.section-unwrap', label: 'Delete section, keep contents', group: 'board',
  shortcut: {code: 'Backspace', mod: true},
  enabled: ctx => sectionsOf(ctx).length > 0,
  run: ctx => {
    const ids = sectionsOf(ctx);
    if (!ids.length) return;
    ctx.store.transact('Delete section', tx => {
      const released: NodeId[] = [];
      for (const id of ids) {
        const section = tx.get(id);
        if (!section?.parentId) continue;
        const parentId = section.parentId;
        let index = (tx.get(parentId)!.children ?? []).indexOf(id);
        for (const child of [...(section.children ?? [])]) {
          tx.move(child, parentId, index++);
          released.push(child);
        }
        tx.remove(id);
      }
      return {select: released};
    });
  },
};

/** Where a template goes in a section: under its name chip, inside its margin. */
const SECTION_INSET = {x: 48, y: 72};

/** FigJam's "Templates" beside a section's title ("Organize your FigJam board with sections"): the template's content placed in the
 *  section, which grows to hold it; one undo step. False when the section is gone or locked. */
export function fillSection(store: DesignStore, sectionId: NodeId, templateId: BoardTemplateId, label: string): boolean {
  const section = store.getState().doc.nodes[sectionId];
  if (store.readOnly || section?.type !== 'SECTION' || section.locked) return false;
  const built = buildBoardTemplate(templateId, newId);
  store.transact(label, tx => {
    insertBoardTemplate(tx, built, sectionId, SECTION_INSET);
    fitSection(tx, sectionId);
  }, {select: [sectionId]});
  return true;
}

/** FigJam's Preferences → "Show templates for new files", kept with the trays' choices in this browser. */
export const TEMPLATES_ON_NEW: Command = {
  id: 'board.templates-on-new', label: 'Show templates for new boards', group: 'board',
  checked: () => boardChoices().templatesOnNew !== false,
  run: () => setBoardChoices({templatesOnNew: boardChoices().templatesOnNew === false}),
};
