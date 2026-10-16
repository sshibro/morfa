import {memo, useEffect, useRef, useState, type ReactNode} from 'react';
import {isTypingTarget, matchesShortcut} from '../ui/shortcuts';
import {usePhone, useTablet} from '../ui/viewport';
import type {CommandLookup, MainMenuSection} from './chrome/commands';
import type {ExternalValue} from './chrome/external';
import type {SaveState} from './chrome/FileTitle';
import {LeftPanel, RightPanel, type LeftTab, type RightTab} from './chrome/Panels';
import {MinimizedBars} from './chrome/MinimizedBars';
import {Toolbar} from './chrome/Toolbar';
import type {ToolGroup, ToolId} from './chrome/tools';
import type {ZoomAction} from './chrome/ZoomMenu';
import {PhoneEditorLayout} from './phone/PhoneEditorLayout';
import {TabletEditorLayout} from './tablet/TabletEditorLayout';

export type {SaveState} from './chrome/FileTitle';
export type {LeftTab, RightTab} from './chrome/Panels';
export type {ZoomAction} from './chrome/ZoomMenu';
export type {EditorMode, ToolId, ToolGroup} from './chrome/tools';
export type {ChromeCommand, CommandLookup, MainMenuSection} from './chrome/commands';
export type {ExternalValue} from './chrome/external';

export type EditorLayoutProps = {
  // The file
  fileName: string;
  onRename: (name: string) => void;
  saveState: SaveState;
  /** Bump to put the file name into rename mode (the "Rename" command). */
  renameRequest?: number;
  onBackToFiles: () => void;

  // The main menu: the engine's command registry, and optionally its own section structure
  commands: CommandLookup;
  menu?: readonly MainMenuSection[];

  // Tools
  /** Null while a mode outside the toolbar's tools is active (gradient, crop, eyedropper). */
  tool: ToolId | null;
  onToolChange: (tool: ToolId) => void;
  toolGroups?: readonly ToolGroup[];
  /** After the tools: "Actions", the AI. */
  toolbarEnd?: ReactNode;
  /** The inset segment at the toolbar's right end: the modes (chrome/Toolbar.tsx ModeSwitcher). */
  toolbarModes?: ReactNode;
  /** Tools whose module is registered; the others are left off the bar. Default: every tool. */
  isToolAvailable?: (tool: ToolId) => boolean;

  // View
  zoom: ExternalValue<number>;
  /** Absent until the engine can zoom: the zoom menu is shown disabled. */
  onZoom?: (action: ZoomAction) => void;
  /** Absent until the player exists: the ▶ button is shown disabled. */
  onPlay?: () => void;
  /** Absent until export exists: "Export" is shown disabled. */
  onExport?: () => void;
  /** "Share": who can open the file, and inviting people (src/design/teams/ShareDialog.tsx). */
  onShare?: () => void;
  /** Beside ▶ and "Export" (the people in the file). */
  rightHeader?: ReactNode;
  /** ⌘\ hides the panels and the toolbar; ⌘\ again or Escape brings them back. */
  uiHidden: boolean;
  onUiHiddenChange: (hidden: boolean) => void;
  /** ⇧\ or the panel button folds the side panels into floating bars (Figma's Minimize UI); the toolbar stays. */
  uiMinimized?: boolean;
  onUiMinimizedChange?: (minimized: boolean) => void;

  // Tabs: controlled when the value is passed, otherwise remembered here
  leftTab?: LeftTab;
  onLeftTabChange?: (tab: LeftTab) => void;
  rightTab?: RightTab;
  onRightTabChange?: (tab: RightTab) => void;

  // Slots filled by the engine and the panels
  canvas: ReactNode;
  pages?: ReactNode;
  layers?: ReactNode;
  assets?: ReactNode;
  designPanel?: ReactNode;
  prototypePanel?: ReactNode;
  codePanel?: ReactNode;
  /** The left panel's "Comments" tab (absent: no such tab) and its unread count. */
  comments?: ReactNode;
  commentsBadge?: number;
  /** Replaces the right panel's tabs while a mode hides the design tools (comment mode). */
  rightOverride?: ReactNode;
  /** Over the canvas (the player, the import progress…). */
  overlay?: ReactNode;
};

/**
 * The editor's frame: left panel | canvas | right panel, the floating toolbar over the canvas.
 * Purely presentational: props in, callbacks out. Every part is memoized with narrow props and
 * the zoom arrives by subscription, so canvas drags and viewport changes re-render none of it;
 * pass stable callbacks (useCallback) and stable slot elements to keep it that way.
 */
export const EditorLayout = memo(function EditorLayout(props: EditorLayoutProps) {
  const {uiHidden, onUiHiddenChange} = props;
  const [ownLeft, setOwnLeft] = useState<LeftTab>('file');
  const [ownRight, setOwnRight] = useState<RightTab>('design');
  const leftTab = props.leftTab ?? ownLeft;
  const rightTab = props.rightTab ?? ownRight;
  const changeLeft = useStable((tab: LeftTab) => {
    if (props.leftTab === undefined) setOwnLeft(tab);
    props.onLeftTabChange?.(tab);
  });
  const changeRight = useStable((tab: RightTab) => {
    if (props.rightTab === undefined) setOwnRight(tab);
    props.onRightTabChange?.(tab);
  });
  const minimized = !!props.uiMinimized;
  const minimize = useStable(() => props.onUiMinimizedChange ? props.onUiMinimizedChange(true) : onUiHiddenChange(true));
  const expand = useStable(() => props.onUiMinimizedChange?.(false));

  useEffect(() => {
    const key = (event: KeyboardEvent) => {
      if (event.defaultPrevented) return;
      if (matchesShortcut(event, 'Mod+Backslash') || matchesShortcut(event, 'Mod+Period')) {
        event.preventDefault();
        onUiHiddenChange(!uiHidden);
      } else if (uiHidden && event.key === 'Escape' && !isTypingTarget(event.target)) {
        event.preventDefault();
        onUiHiddenChange(false);
      }
    };
    window.addEventListener('keydown', key);
    return () => window.removeEventListener('keydown', key);
  }, [uiHidden, onUiHiddenChange]);

  // A phone gets its own frame: the canvas is the screen, the panels are sheets.
  const phone = usePhone();
  const tablet = useTablet();
  if (phone) return <PhoneEditorLayout {...props} leftTab={leftTab} onLeftTabChange={changeLeft} rightTab={rightTab} onRightTabChange={changeRight} />;
  // A touch tablet keeps the desktop's panels, folded until asked for (editor/tablet).
  if (tablet) return <TabletEditorLayout {...props} leftTab={leftTab} onLeftTabChange={changeLeft} rightTab={rightTab} onRightTabChange={changeRight} />;

  return (
    <div className={['dz-editor', uiHidden && 'is-ui-hidden', minimized && 'is-ui-minimized'].filter(Boolean).join(' ')}>
      {!minimized && (
        <LeftPanel fileName={props.fileName} onRename={props.onRename} saveState={props.saveState} renameRequest={props.renameRequest}
          commands={props.commands} menu={props.menu} onBackToFiles={props.onBackToFiles} onMinimizeUI={minimize}
          tab={leftTab} onTabChange={changeLeft} pages={props.pages} layers={props.layers} assets={props.assets} comments={props.comments} commentsBadge={props.commentsBadge} />
      )}
      <main className="dz-canvas-area" aria-label="Canvas">
        {props.canvas}
        {props.overlay}
        {minimized && (
          <MinimizedBars fileName={props.fileName} onRename={props.onRename} saveState={props.saveState} renameRequest={props.renameRequest}
            commands={props.commands} menu={props.menu} onBackToFiles={props.onBackToFiles} onExpand={expand}
            zoom={props.zoom} onZoom={props.onZoom} onPlay={props.onPlay} onExport={props.onExport} onShare={props.onShare} headerExtra={props.rightHeader} />
        )}
        <Toolbar tool={props.tool} onToolChange={props.onToolChange} groups={props.toolGroups} end={props.toolbarEnd} modes={props.toolbarModes} isAvailable={props.isToolAvailable} />
      </main>
      {!minimized && (
        <RightPanel tab={rightTab} onTabChange={changeRight} zoom={props.zoom} onZoom={props.onZoom} onPlay={props.onPlay} onExport={props.onExport} onShare={props.onShare}
          headerExtra={props.rightHeader} design={props.designPanel} prototype={props.prototypePanel} code={props.codePanel} override={props.rightOverride} />
      )}
    </div>
  );
});

/** A callback with a stable identity that always runs the latest closure (keeps memoized panels quiet). */
function useStable<A extends unknown[]>(callback: (...args: A) => void) {
  const latest = useRef(callback);
  latest.current = callback;
  const [stable] = useState(() => (...args: A) => latest.current(...args));
  return stable;
}
