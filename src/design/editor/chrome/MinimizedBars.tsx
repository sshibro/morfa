import {memo, type ReactNode} from 'react';
import {IconButton} from '../../ui/Button';
import {IconPanel} from '../../ui/icons';
import type {CommandLookup, MainMenuSection} from './commands';
import type {ExternalValue} from './external';
import {FileTitle, type SaveState} from './FileTitle';
import {MainMenu} from './MainMenu';
import {FileActions} from './Panels';
import {ZoomMenu, type ZoomAction} from './ZoomMenu';

export type MinimizedBarsProps = {
  fileName: string;
  onRename: (name: string) => void;
  saveState: SaveState;
  renameRequest?: number;
  commands: CommandLookup;
  menu?: readonly MainMenuSection[];
  onBackToFiles: () => void;
  /** Unfolds the side panels again (the bar's panel button, ⇧\). */
  onExpand: () => void;
  zoom: ExternalValue<number>;
  onZoom?: (action: ZoomAction) => void;
  onPlay?: () => void;
  onExport?: () => void;
  onShare?: () => void;
  /** Collaborators, the meeting and the AI balance: what the right panel's header carries. */
  headerExtra?: ReactNode;
};

/** "Minimize UI" (Figma's Minimize UI): with the side panels folded, the file and its actions float over the
 *  canvas — the main menu, the name and the panel button top left; collaborators, zoom, ▶, "Export" and "Share" top right. */
export const MinimizedBars = memo(function MinimizedBars(props: MinimizedBarsProps) {
  return (
    <>
      <div className="dz-float-bar dz-float-file" role="toolbar" aria-label="File">
        <MainMenu commands={props.commands} menu={props.menu} onBackToFiles={props.onBackToFiles} />
        <FileTitle name={props.fileName} onRename={props.onRename} saveState={props.saveState} renameRequest={props.renameRequest} />
        <IconButton label="Expand UI" shortcut="Shift+Backslash" onClick={props.onExpand}><IconPanel /></IconButton>
      </div>
      <div className="dz-float-bar dz-float-actions" role="toolbar" aria-label="File actions">
        {props.headerExtra}
        <ZoomMenu zoom={props.zoom} onZoom={props.onZoom} />
        <FileActions onPlay={props.onPlay} onExport={props.onExport} onShare={props.onShare} />
      </div>
    </>
  );
});
