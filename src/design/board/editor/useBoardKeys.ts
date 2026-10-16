import {useEffect, useRef} from 'react';
import {boardObjectOf, isShapeWithText, isSticky} from '../../../../shared/design/board/model';
import {getCommand, runCommand, type CommandContext} from '../../engine/commands';
import {isMacPlatform, isTypingTarget, modPressed} from '../../engine/keyboard';
import type {DesignStore} from '../../engine/store';
import {toolForKey} from '../../editor/chrome/tools';
import {boardKeyAction, type BoardKeyAction} from '../keys';
import type {BoardChoices} from '../state';
import {stepCell} from '../table-commands';
import type {BoardToolId} from '../tools';

// ── Keys ─────────────────────────────────────────────────────────────────────────────────────────

/** The board's single keys (keys.ts) before the design editor's commands, in the capture phase: S is a sticky here, never
 *  "Slice"; a design tool the board does not offer is swallowed. ⌘↵ while typing on a sticky makes the next one beside it.
 *  Tools switch without any animation (they are pressed all day). */
export function useBoardKeys({store, context, readOnly, active, onTool, onActions, onWheel, wheelOpen, onWheelMore, onEscapePlus}: {
  store: DesignStore;
  context: () => CommandContext;
  readOnly: boolean;
  active: {current: boolean};
  onTool: (tool: BoardToolId, choices?: Partial<BoardChoices>) => void;
  onActions: () => void;
  onWheel: () => void;
  wheelOpen: {current: boolean};
  onWheelMore: () => void;
  onEscapePlus: (() => void) | null;
}) {
  const latest = useRef({onTool, onActions, onWheel, onWheelMore, onEscapePlus, readOnly});
  latest.current = {onTool, onActions, onWheel, onWheelMore, onEscapePlus, readOnly};
  useEffect(() => {
    const mac = isMacPlatform();
    const key = (event: KeyboardEvent) => {
      if (event.defaultPrevented || event.isComposing) return;
      const {onTool: tool, onActions: actions, onWheel: wheel, onWheelMore: wheelMore, onEscapePlus: escapePlus, readOnly: viewOnly} = latest.current;
      if (event.key === 'Escape' && escapePlus && !isTypingTarget(event.target)) {
        event.preventDefault();
        escapePlus();
        return;
      }
      if (!active.current) return;
      const state = store.getState();
      // ⌘↵ and ⇧⌘↵ on a mind map's text: a child and a sibling, open for typing (FigJam).
      if ((event.code === 'Enter' || event.code === 'NumpadEnter') && modPressed(event, mac) && !event.altKey && !viewOnly) {
        const command = event.shiftKey ? 'board.mind-sibling' : 'board.mind-child';
        if (getCommand(command)?.enabled?.(context()) ?? false) {
          event.preventDefault();
          event.stopPropagation();
          runCommand(command, context());
          return;
        }
      }
      // ⌘↵ on a sticky or a shape being typed into or selected: the next one beside it, open for typing (FigJam).
      if ((event.code === 'Enter' || event.code === 'NumpadEnter') && modPressed(event, mac) && !event.shiftKey && !event.altKey && !viewOnly) {
        const editing = state.editing?.kind === 'text' ? state.editing.id : state.selection.length === 1 ? state.selection[0] : null;
        const owner = editing ? boardObjectOf(id => (id ? state.doc.nodes[id] : undefined), editing) : null;
        if (owner && (isSticky(owner) || isShapeWithText(owner))) {
          event.preventDefault();
          event.stopPropagation();
          runCommand(isSticky(owner) ? 'board.sticky-next' : 'board.shape-next', context());
          return;
        }
      }
      // Tab and ⇧Tab in a table cell move to the next and the previous cell (FigJam).
      if (event.code === 'Tab' && state.editing && !event.altKey && !modPressed(event, mac) && stepCell(context(), event.shiftKey ? -1 : 1)) {
        event.preventDefault();
        event.stopPropagation();
        return;
      }
      if (state.editing || (isTypingTarget(event.target))) return;
      const action: BoardKeyAction | null = boardKeyAction(event, mac);
      if (!action) {
        // A design tool's key the board has no use for (frame, pen, slice...) does nothing here.
        const designTool = toolForKey(event, mac);
        if (designTool && designTool !== 'image') event.preventDefault();
        return;
      }
      if (event.repeat) {
        event.preventDefault();
        return;
      }
      switch (action.kind) {
        case 'swallow':
          event.preventDefault();
          return;
        case 'actions':
          event.preventDefault();
          actions();
          return;
        case 'stamp-wheel':
          event.preventDefault();
          // E (FigJam, help.figma.com "Stamps, emotes, and high-fives"): takes the stamp tool and opens the wheel at the pointer; with
          // the wheel open it opens more stamps and emoji; with the stamp in hand and the wheel away, the wheel again. Escape leaves.
          if (viewOnly) return;
          if (wheelOpen.current) wheelMore();
          else {
            if (state.tool !== 'board-stamp') tool('board-stamp');
            wheel();
          }
          return;
        case 'tool':
          event.preventDefault();
          tool(action.tool, action.choices);
      }
    };
    window.addEventListener('keydown', key, true);
    return () => window.removeEventListener('keydown', key, true);
  }, [store, context, active, wheelOpen]);
}

