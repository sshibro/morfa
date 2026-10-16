import {memo, useCallback, useEffect, useMemo, useRef, useState} from 'react';
import '../../styles/tablet-editor.css';
import {IconButton} from '../../ui/Button';
import {IconSliders} from '../../ui/icons';
import type {EditorLayoutProps, LeftTab, RightTab} from '../EditorLayout';
import {MinimizedBars} from '../chrome/MinimizedBars';
import {LeftPanel, RightPanel} from '../chrome/Panels';
import {Toolbar} from '../chrome/Toolbar';
import {useOptionalStoreApi} from '../../engine/useDesignStore';
import {installLongPress} from '../phone/long-press';
import {ShapeBuilderBar} from '../phone/ShapeBuilderBar';

export type TabletEditorLayoutProps = EditorLayoutProps & {
  leftTab: LeftTab;
  onLeftTabChange: (tab: LeftTab) => void;
  rightTab: RightTab;
  onRightTabChange: (tab: RightTab) => void;
};

type Side = 'left' | 'right' | null;

/**
 * The editor on a tablet: the canvas takes the
 * width with both side panels folded, as "Minimize UI" leaves them. The file bar's panel button opens the left
 * panel over the canvas from its edge, "Properties" beside the file's actions the right one; a tap outside folds it again.
 * The panels are the desktop's own, unchanged.
 */
export const TabletEditorLayout = memo(function TabletEditorLayout(props: TabletEditorLayoutProps) {
  const store = useOptionalStoreApi();
  const [open, setOpen] = useState<Side>(null);
  const close = useCallback(() => setOpen(null), []);
  const openLeft = useCallback(() => setOpen(side => (side === 'left' ? null : 'left')), []);
  const openRight = useCallback(() => setOpen(side => (side === 'right' ? null : 'right')), []);
  // A tap outside a menu opened from a panel closes the menu only; the panel stays (the tap lands on the scrim).
  const menuAtPress = useRef(false);
  useEffect(() => {
    if (!open) return;
    // On the window, in the capture phase: before the menu closes itself on the same press.
    const down = () => {
      menuAtPress.current = !!document.querySelector('[role="menu"]');
    };
    window.addEventListener('pointerdown', down, true);
    return () => window.removeEventListener('pointerdown', down, true);
  }, [open]);
  const scrimClick = () => {
    if (!menuAtPress.current) close();
    menuAtPress.current = false;
  };
  // A held finger on the panels' rows opens their menu (iPad Safari sends no contextmenu; phone/long-press.ts).
  const root = useRef<HTMLDivElement>(null);
  useEffect(() => (root.current ? installLongPress(root.current) : undefined), []);
  useEffect(() => {
    if (!open) return;
    // Before the canvas (which would clear the selection): an open panel folds first.
    const key = (event: KeyboardEvent) => {
      if (event.key !== 'Escape' || event.defaultPrevented) return;
      // A picker or menu opened from the panel takes its own Escape first.
      if ((event.target as Element | null)?.closest?.('[role="dialog"], [role="menu"], [role="listbox"]') || document.querySelector('[role="menu"]')) return;
      event.preventDefault();
      event.stopPropagation();
      close();
    };
    window.addEventListener('keydown', key, true);
    return () => window.removeEventListener('keydown', key, true);
  }, [open, close]);
  const headerExtra = useMemo(() => (
    <>
      {props.rightHeader}
      <IconButton label="Properties" pressed={open === 'right'} onClick={openRight}><IconSliders /></IconButton>
    </>
  ), [props.rightHeader, open, openRight]);
  const editorClass = ['dz-editor', 'dz-tablet-editor', 'is-ui-minimized', props.uiHidden && 'is-ui-hidden'].filter(Boolean).join(' ');
  return (
    <div ref={root} className={editorClass}>
      <main className="dz-canvas-area" aria-label="Canvas">
        {props.canvas}
        {props.overlay}
        <MinimizedBars fileName={props.fileName} onRename={props.onRename} saveState={props.saveState} renameRequest={props.renameRequest}
          commands={props.commands} menu={props.menu} onBackToFiles={props.onBackToFiles} onExpand={openLeft}
          zoom={props.zoom} onZoom={props.onZoom} onPlay={props.onPlay} onExport={props.onExport} onShare={props.onShare} headerExtra={headerExtra} />
        <Toolbar tool={props.tool} onToolChange={props.onToolChange} groups={props.toolGroups} end={props.toolbarEnd} modes={props.toolbarModes} isAvailable={props.isToolAvailable} />
        {store && <ShapeBuilderBar store={store} />}
        {open && <button type="button" className="dz-tablet-scrim" aria-label="Collapse panel" tabIndex={-1} onClick={scrimClick} />}
        {open === 'left' && (
          <div className="dz-tablet-panel is-left">
            <LeftPanel fileName={props.fileName} onRename={props.onRename} saveState={props.saveState} renameRequest={props.renameRequest}
              commands={props.commands} menu={props.menu} onBackToFiles={props.onBackToFiles} onMinimizeUI={close}
              tab={props.leftTab} onTabChange={props.onLeftTabChange} pages={props.pages} layers={props.layers} assets={props.assets} comments={props.comments} commentsBadge={props.commentsBadge} />
          </div>
        )}
        {open === 'right' && (
          <div className="dz-tablet-panel is-right">
            <RightPanel tab={props.rightTab} onTabChange={props.onRightTabChange} zoom={props.zoom} onZoom={props.onZoom} onPlay={props.onPlay} onExport={props.onExport} onShare={props.onShare}
              headerExtra={props.rightHeader} design={props.designPanel} prototype={props.prototypePanel} code={props.codePanel} override={props.rightOverride} />
          </div>
        )}
      </main>
    </div>
  );
});
