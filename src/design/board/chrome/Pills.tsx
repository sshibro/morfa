import {memo, useCallback, type ReactNode} from 'react';
import type {NodeId} from '../../../../shared/design/types';
import {createNode, newId} from '../../../../shared/design/defaults';
import type {DesignStore} from '../../engine/store';
import {currentViewport} from '../../engine/store';
import {useDesignStore} from '../../engine/useDesignStore';
import {FileTitle, type SaveState} from '../../editor/chrome/FileTitle';
import {MainMenu} from '../../editor/chrome/MainMenu';
import type {CommandLookup, MainMenuSection} from '../../editor/chrome/commands';
import {useExternalValue, type ExternalValue} from '../../editor/chrome/external';
import {useMenuTrigger} from '../../ui/Menu';
import type {MenuItem} from '../../ui/menu-model';
import {useTooltip} from '../../ui/Tooltip';
import {SUPPORT_ANCHOR, SupportDot, supportUnreadNote, withSupportNote} from '../../../support/badges';
import {useSupportState} from '../../../support/state';
import {BdChevronDown, BdComment, BdHelp, BdMinus, BdPages, BdPlus, BdShare} from './icons';

// The board's floating pills (docs/board.md §Look), FigJam's (its board picture, help article attachment 29051798853015): top left
// the main menu, the board's name in bold on one line (renamed in place; the save state shows only while not saved), a rule and
// the pages with the current page's name; top right the people here, the meeting module's controls (its slot), comments and "Share";
// bottom right zoom and help. Pills are panels: same surface, radius and shadow as the toolbar.

export type TopLeftProps = {
  name: string;
  onRename: (name: string) => void;
  saveState: SaveState;
  renameRequest: number;
  commands: CommandLookup;
  menu: readonly MainMenuSection[];
  onBackToFiles: () => void;
  store: DesignStore;
  readOnly: boolean;
};

export const TopLeftPill = memo(function TopLeftPill({name, onRename, saveState, renameRequest, commands, menu, onBackToFiles, store, readOnly}: TopLeftProps) {
  return (
    <div className="bd-pill bd-top-left">
      <MainMenu commands={commands} menu={menu} onBackToFiles={onBackToFiles} />
      <FileTitle name={name} onRename={onRename} saveState={saveState} renameRequest={renameRequest} />
      <span className="bd-pill-rule" aria-hidden="true" />
      <PagesButton store={store} readOnly={readOnly} />
    </div>
  );
});

function PagesButton({store, readOnly}: {store: DesignStore; readOnly: boolean}) {
  const pages = useDesignStore(state => state.doc.pages, Object.is, {store, slice: 'doc'});
  const names = useDesignStore(state => state.doc.pages.map(id => state.doc.nodes[id]?.name ?? '').join('\u0000'), Object.is, {store, slice: 'doc'});
  const current = useDesignStore(state => state.pageId, Object.is, {store, slice: 'page'});
  const items = useCallback((): MenuItem[] => {
    const labels = names.split('\u0000');
    const list: MenuItem[] = pages.map((id: NodeId, index) => ({id, label: labels[index] || `Page ${index + 1}`, checked: id === current, radio: true, onSelect: () => store.setPage(id)}));
    if (!readOnly) list.push({type: 'separator'}, {id: 'add', label: 'New page', onSelect: () => addPage(store)});
    return list;
  }, [pages, names, current, store, readOnly]);
  const menu = useMenuTrigger({items, label: 'Pages', placement: 'bottom-start', minWidth: 220});
  const tip = useTooltip(menu.open ? null : {label: 'Pages', placement: 'bottom'});
  // FigJam's pill: the pages icon and the current page's name (its number in the icon when there are several).
  const index = Math.max(0, pages.indexOf(current));
  const label = names.split('\u0000')[index] || `Page ${index + 1}`;
  return (
    <>
      <button type="button" className="bd-pill-btn bd-pages" aria-label={`Pages: ${label}`} {...tip} {...menu.triggerProps}>
        <span className="bd-pages-icon"><BdPages size={20} />{pages.length > 1 && <span className="bd-pages-number" aria-hidden="true">{index + 1}</span>}</span>
        <span className="bd-pages-name">{label}</span>
      </button>
      {menu.element}
    </>
  );
}

function addPage(store: DesignStore) {
  const id = newId();
  const count = store.getState().doc.pages.length;
  store.transact('New page', tx => tx.addPage(createNode('PAGE', {id, name: `Page ${count + 1}`})));
  store.setPage(id);
}

export type TopRightProps = {
  avatars: ReactNode;
  meeting: ReactNode;
  commentsOpen: boolean;
  unread: number;
  onComments: () => void;
  /** "Share": the editor's share dialog (src/design/teams/ShareDialog.tsx). */
  onShare: () => void;
};

export const TopRightPill = memo(function TopRightPill({avatars, meeting, commentsOpen, unread, onComments, onShare}: TopRightProps) {
  const commentsTip = useTooltip({label: 'Comments', shortcut: 'KeyC', placement: 'bottom'});
  return (
    <div className="bd-pill bd-top-right">
      {avatars && <div className="bd-avatars">{avatars}</div>}
      {/* The meeting module's place (src/design/board/meeting.ts): timer, voting, spotlight. */}
      <div className="bd-meeting-slot" data-slot="meeting">{meeting}</div>
      <button type="button" className="bd-pill-btn" aria-label={unread ? `Comments, unread: ${unread}` : 'Comments'} aria-pressed={commentsOpen} {...commentsTip} onClick={onComments}>
        <BdComment size={20} />
        {unread > 0 && <span className="bd-pill-badge" aria-hidden="true">{unread > 99 ? '99+' : unread}</span>}
      </button>
      <button type="button" className="bd-share" aria-haspopup="dialog" onClick={onShare}>
        <BdShare size={18} />
        <span>Share</span>
      </button>
    </div>
  );
});

// ── Zoom and help ───────────────────────────────────────────────────────────────────────────────

export type ZoomAction = {type: 'in'} | {type: 'out'} | {type: 'fit'} | {type: 'selection'} | {type: 'set'; zoom: number};

export const ZoomPill = memo(function ZoomPill({zoom, onZoom, commands}: {zoom: ExternalValue<number>; onZoom: (action: ZoomAction) => void; commands: CommandLookup}) {
  const value = useExternalValue(zoom);
  const percent = Math.round(value * 100);
  const outTip = useTooltip({label: 'Zoom out', shortcut: 'Mod+Minus', placement: 'top'});
  const inTip = useTooltip({label: 'Zoom in', shortcut: 'Mod+Equal', placement: 'top'});
  const zoomItems = useCallback((): MenuItem[] => [
    {id: 'fit', label: 'Zoom to fit', shortcut: 'Shift+Digit1', onSelect: () => onZoom({type: 'fit'})},
    {id: 'selection', label: 'Zoom to selection', shortcut: 'Shift+Digit2', onSelect: () => onZoom({type: 'selection'})},
    {type: 'separator'},
    ...([0.5, 1, 2] as const).map((preset): MenuItem => ({
      id: 'zoom-' + preset * 100, label: `${preset * 100}%`, shortcut: preset === 1 ? 'Shift+Digit0' : undefined, checked: Math.abs(zoom.get() - preset) < 0.0005, radio: true,
      onSelect: () => onZoom({type: 'set', zoom: preset}),
    })),
  ], [zoom, onZoom]);
  const zoomMenu = useMenuTrigger({items: zoomItems, label: 'Zoom', placement: 'top-end', minWidth: 200});
  // The support chat's unread answers: a dot on the pill, a line under "Contact support" (src/support/badges.tsx).
  const {unread} = useSupportState();
  const helpItems = useCallback((): MenuItem[] => {
    const out: MenuItem[] = [];
    for (const id of ['help.shortcuts', 'help.guide', 'help.support']) {
      const command = commands(id);
      if (command) out.push({id, label: command.label, shortcut: command.shortcut, onSelect: command.run});
    }
    return withSupportNote(out, unread);
  }, [commands, unread]);
  const helpMenu = useMenuTrigger({items: helpItems, label: 'Help', placement: 'top-end', minWidth: 220});
  const helpTip = useTooltip(helpMenu.open ? null : {label: 'Help', placement: 'top'});
  return (
    <div className="bd-bottom-right">
      <div className="bd-pill bd-zoom">
        <button type="button" className="bd-pill-btn" aria-label="Zoom out" {...outTip} onClick={() => onZoom({type: 'out'})}><BdMinus size={20} /></button>
        <button type="button" className="bd-zoom-value" aria-label={`Zoom ${percent}%`} {...zoomMenu.triggerProps}>{percent}%</button>
        <button type="button" className="bd-pill-btn" aria-label="Zoom in" {...inTip} onClick={() => onZoom({type: 'in'})}><BdPlus size={20} /></button>
        {zoomMenu.element}
      </div>
      <button type="button" className={`bd-pill bd-help ${SUPPORT_ANCHOR}`} aria-label={unread ? `Help. ${supportUnreadNote(unread)}` : 'Help'} {...helpTip} {...helpMenu.triggerProps}>
        <BdHelp size={20} />
        <SupportDot />
      </button>
      {helpMenu.element}
    </div>
  );
});

/** "Zoom to fit" starts from the page's content at most at 100 %. */
export const zoomPercent = (store: DesignStore) => Math.round(currentViewport(store.getState()).zoom * 100);
export {BdChevronDown};
