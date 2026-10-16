import {memo, useMemo, type ReactNode} from 'react';
import {Button, IconButton} from '../../ui/Button';
import {IconExport, IconPanel, IconPlay} from '../../ui/icons';
import {ResizablePanel} from '../../ui/ResizablePanel';
import {TabPanel, Tabs} from '../../ui/Tabs';
import type {CommandLookup, MainMenuSection} from './commands';
import type {ExternalValue} from './external';
import {FileTitle, type SaveState} from './FileTitle';
import {NavRail} from './NavRail';
import {ZoomMenu, type ZoomAction} from './ZoomMenu';

export type LeftTab = 'file' | 'assets' | 'comments';
export type RightTab = 'design' | 'prototype' | 'code';

const LEFT_TABS = [{id: 'file', label: 'File'}, {id: 'assets', label: 'Assets'}] as const;
const COMMENTS_TAB = {id: 'comments', label: 'Comments'} as const;
const RIGHT_TABS = [{id: 'design', label: 'Design'}, {id: 'prototype', label: 'Prototype'}, {id: 'code', label: 'Code'}] as const;

export const LEFT_WIDTH_KEY = 'morfa-design-left-width';
export const RIGHT_WIDTH_KEY = 'morfa-design-right-width';
/** "Code" keeps its own, wider panel (as Figma's Dev Mode): code and values need the room, "Design" doesn't. */
export const CODE_WIDTH_KEY = 'morfa-design-code-width';
const CODE_WIDTH = 320;

export type LeftPanelProps = {
  fileName: string;
  onRename: (name: string) => void;
  saveState: SaveState;
  renameRequest?: number;
  commands: CommandLookup;
  menu?: readonly MainMenuSection[];
  onBackToFiles: () => void;
  /** The panel button: folds the side panels into floating bars (Figma's Minimize UI). */
  onMinimizeUI: () => void;
  tab: LeftTab;
  onTabChange: (tab: LeftTab) => void;
  pages?: ReactNode;
  layers?: ReactNode;
  assets?: ReactNode;
  /** "Comments" (src/design/comments): the tab is there only with it. */
  comments?: ReactNode;
  /** Unread comments, after the tab's name. */
  commentsBadge?: number;
};

/** Left panel, as Figma Design's current interface: the navigation bar (NavRail.tsx: the main menu, "File", "Assets",
 *  "Comments", "Variables") along the edge, and beside it the file's name and save state over the chosen view —
 *  pages over layers, the assets or the comments. A phone has its own frame (src/design/editor/phone). */
export const LeftPanel = memo(function LeftPanel({fileName, onRename, saveState, renameRequest, commands, menu, onBackToFiles, onMinimizeUI, tab, onTabChange, pages, layers, assets, comments, commentsBadge}: LeftPanelProps) {
  const tabs = useMemo(() => (comments === undefined ? LEFT_TABS : [...LEFT_TABS, {...COMMENTS_TAB, badge: commentsBadge}]), [comments, commentsBadge]);
  const shown = tab === 'comments' && comments === undefined ? 'file' : tab;
  const panel = (
    <ResizablePanel side="left" storageKey={LEFT_WIDTH_KEY} aria-label="Layers and assets" className="dz-left">
      <header className="dz-panel-header dz-left-header">
        <FileTitle name={fileName} onRename={onRename} saveState={saveState} renameRequest={renameRequest} />
        <IconButton label="Minimize UI" shortcut="Shift+Backslash" onClick={onMinimizeUI}><IconPanel /></IconButton>
      </header>
      {shown === 'comments' ? (
        <TabPanel idBase="dz-left" id="comments" className="dz-panel-body dz-left-comments">{comments}</TabPanel>
      ) : shown === 'file' ? (
        <TabPanel idBase="dz-left" id="file" className="dz-panel-body dz-left-file">
          {pages !== undefined && <div className="dz-left-pages">{pages}</div>}
          <div className="dz-left-layers">{layers}</div>
        </TabPanel>
      ) : (
        <TabPanel idBase="dz-left" id="assets" className="dz-panel-body dz-scroll">{assets}</TabPanel>
      )}
    </ResizablePanel>
  );
  return (
    <>
      <NavRail commands={commands} menu={menu} onBackToFiles={onBackToFiles} tabs={tabs} value={shown} onChange={onTabChange} />
      {panel}
    </>
  );
});

export type RightPanelProps = {
  tab: RightTab;
  onTabChange: (tab: RightTab) => void;
  zoom: ExternalValue<number>;
  onZoom?: (action: ZoomAction) => void;
  onPlay?: () => void;
  onExport?: () => void;
  /** "Share" (Figma's Share): the one blue button; "Export" then folds into an icon beside ▶. */
  onShare?: () => void;
  /** Before ▶ and "Export" (the people in the file). */
  headerExtra?: ReactNode;
  design?: ReactNode;
  prototype?: ReactNode;
  code?: ReactNode;
  /** Replaces the tabs and their panels while a mode has no use for them (comment mode, as in Figma). */
  override?: ReactNode;
};

/** Right panel: the player and export, then "Design / Prototype / Code" with the zoom beside them. */
export const RightPanel = memo(function RightPanel({tab, onTabChange, zoom, onZoom, onPlay, onExport, onShare, headerExtra, design, prototype, code, override}: RightPanelProps) {
  const body = tab === 'design' ? design : tab === 'prototype' ? prototype : code;
  const coding = tab === 'code' && override === undefined;
  return (
    <ResizablePanel side="right" storageKey={coding ? CODE_WIDTH_KEY : RIGHT_WIDTH_KEY} defaultWidth={coding ? CODE_WIDTH : undefined} aria-label="Properties" className="dz-right">
      <header className="dz-panel-header dz-right-header">
        {headerExtra}
        <FileActions onPlay={onPlay} onExport={onExport} onShare={onShare} />
      </header>
      {override !== undefined ? (
        <>
          <div className="dz-panel-tabs dz-panel-tabs-override">
            <span className="dz-panel-override-spacer" />
            <ZoomMenu zoom={zoom} onZoom={onZoom} />
          </div>
          <div className="dz-panel-body dz-scroll">{override}</div>
        </>
      ) : (
        <>
          <div className="dz-panel-tabs">
            <Tabs idBase="dz-right" tabs={RIGHT_TABS} value={tab} onChange={onTabChange} aria-label="Right panel" />
            <ZoomMenu zoom={zoom} onZoom={onZoom} />
          </div>
          <TabPanel idBase="dz-right" id={tab} className="dz-panel-body dz-scroll">{body}</TabPanel>
        </>
      )}
    </ResizablePanel>
  );
});

/** ▶, "Export" and "Share" at the right end of the header (and of the floating bar with the panels folded). */
export function FileActions({onPlay, onExport, onShare}: {onPlay?: () => void; onExport?: () => void; onShare?: () => void}) {
  return (
    <>
      <IconButton label="Present" shortcut="Alt+Mod+Enter" disabled={!onPlay} onClick={onPlay}><IconPlay /></IconButton>
      {onShare ? (
        <>
          <IconButton label="Export" shortcut="Shift+Mod+E" disabled={!onExport} onClick={onExport}><IconExport /></IconButton>
          <Button variant="primary" className="dz-share-button" onClick={onShare}>Share</Button>
        </>
      ) : (
        <Button variant="primary" icon={<IconExport />} disabled={!onExport} onClick={onExport}>Export</Button>
      )}
    </>
  );
}
