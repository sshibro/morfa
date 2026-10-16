import {memo, useCallback, useEffect, useMemo, useRef, useState} from 'react';
import '../../styles/phone-editor.css';
import '../../styles/phone-editor-comments.css';
import '../../styles/phone-editor-meeting.css';
import {IconButton} from '../../ui/Button';
import {IconBack, IconExport, IconFrame, IconLasso, IconList, IconPlay, IconSliders, IconUndo, IconUserPlus} from '../../ui/icons';
import {useContextMenu} from '../../ui/Menu';
import {TabPanel, Tabs} from '../../ui/Tabs';
import type {EditorLayoutProps, LeftTab, RightTab} from '../EditorLayout';
import {FileTitle} from '../chrome/FileTitle';
import {MainMenu} from '../chrome/MainMenu';
import {Toolbar} from '../chrome/Toolbar';
import {ZoomMenu} from '../chrome/ZoomMenu';
import {registerTool} from '../../engine/tools/registry';
import {followSelectionOff, TOUCH_SELECT_TOOL, TouchSelectTool} from '../../engine/touch/select-tool';
import {useDesignStore, useOptionalStoreApi} from '../../engine/useDesignStore';
import type {DesignStore} from '../../engine/store';
import {layerTreeState} from '../../panels/left/tree-state';
import {followKeyboard} from './keyboard';
import {blockPageZoom, installLongPress} from './long-press';
import {FrameStrip} from './FrameStrip';
import {ShapeBuilderBar} from './ShapeBuilderBar';
import {PhoneSheet} from './PhoneSheet';

export type PhoneEditorLayoutProps = EditorLayoutProps & {
  leftTab: LeftTab;
  onLeftTabChange: (tab: LeftTab) => void;
  rightTab: RightTab;
  onRightTabChange: (tab: RightTab) => void;
};

type Sheet = 'layers' | 'properties' | null;

const LEFT_TABS = [{id: 'file', label: 'File'}, {id: 'assets', label: 'Assets'}] as const;
const COMMENTS_TAB = {id: 'comments', label: 'Comments'} as const;
const RIGHT_TABS = [{id: 'design', label: 'Design'}, {id: 'prototype', label: 'Prototype'}, {id: 'code', label: 'Code'}] as const;

/**
 * The editor on a phone: the canvas is the screen; one row on top (back to the files, the file's
 * name and save state, the people here, ▶, share, "⋯" for the main menu); the tools in one row at the bottom, between
 * "Layers" and "Properties", which open the side panels' content as bottom sheets. Every slot the desktop panels show is here.
 */
export const PhoneEditorLayout = memo(function PhoneEditorLayout(props: PhoneEditorLayoutProps) {
  const root = useRef<HTMLDivElement>(null);
  const store = useOptionalStoreApi();
  const [sheet, setSheet] = useState<Sheet>(null);
  const [strip, setStrip] = useState(false);
  useEffect(() => {
    const element = root.current;
    if (!element) return;
    const stops = [installLongPress(element), blockPageZoom(), followKeyboard(element, store, () => element.getBoundingClientRect().top)];
    return () => stops.forEach(stop => stop());
  }, [store]);
  // "Rename" from the canvas menu asks the layers tree to edit a name: with "Layers" closed there is no tree, so the
  // sheet opens on "File" and the request is made again once the tree is there.
  const sheetRef = useRef<Sheet>(null);
  sheetRef.current = sheet;
  const {onLeftTabChange} = props;
  useEffect(() => {
    if (!store) return;
    const tree = layerTreeState(store);
    return tree.onRenameRequest(id => {
      if (sheetRef.current === 'layers') return;
      onLeftTabChange('file');
      setSheet('layers');
      requestAnimationFrame(() => requestAnimationFrame(() => tree.requestRename(id)));
    });
  }, [store, onLeftTabChange]);
  const close = useCallback(() => setSheet(null), []);
  const toggle = (next: Exclude<Sheet, null>) => setSheet(current => (current === next ? null : next));
  const editorClass = ['dz-editor', 'dz-phone-editor', props.uiHidden && 'is-ui-hidden'].filter(Boolean).join(' ');
  return (
    <div ref={root} className={editorClass}>
      <main className="dz-canvas-area" aria-label="Canvas">
        {props.canvas}
        {props.overlay}
        <header className="dz-phone-top" role="toolbar" aria-label="File">
          <IconButton label="Back to files" tooltip={false} size={32} onClick={props.onBackToFiles}><IconBack /></IconButton>
          <FileTitle name={props.fileName} onRename={props.onRename} saveState={props.saveState} renameRequest={props.renameRequest} />
          <div className="dz-phone-top-end">
            {props.rightHeader}
            <PhoneFileActions {...props} />
            <MainMenu commands={props.commands} menu={props.menu} onBackToFiles={props.onBackToFiles} face="more" />
          </div>
        </header>
        <div className="dz-phone-bottom">
          <IconButton label="Layers" tooltip={false} size={32} pressed={sheet === 'layers'} className="dz-phone-sheet-button" onClick={() => toggle('layers')}>
            <IconList />
          </IconButton>
          {store && (
            <IconButton label="Frames" tooltip={false} size={32} pressed={strip} className="dz-phone-sheet-button" onClick={() => setStrip(open => !open)}>
              <IconFrame />
            </IconButton>
          )}
          <Toolbar tool={props.tool} onToolChange={props.onToolChange} groups={props.toolGroups} end={props.toolbarEnd} modes={props.toolbarModes} isAvailable={props.isToolAvailable} />
          {store && <SelectToggle store={store} />}
          <IconButton label="Properties" tooltip={false} size={32} pressed={sheet === 'properties'} className="dz-phone-sheet-button" onClick={() => toggle('properties')}>
            <IconSliders />
          </IconButton>
        </div>
        {strip && store && !sheet && <FrameStrip store={store} />}
        {store && !sheet && <ShapeBuilderBar store={store} />}
        {sheet === 'layers' && <LayersSheet {...props} onClose={close} />}
        {sheet === 'properties' && <PropertiesSheet {...props} onClose={close} />}
      </main>
    </div>
  );
});

/** "Layers": the left panel's tabs — "File" (pages over layers), "Assets", "Comments". */
function LayersSheet(props: PhoneEditorLayoutProps & {onClose: () => void}) {
  const {comments, commentsBadge} = props;
  const tabs = useMemo(() => (comments === undefined ? LEFT_TABS : [...LEFT_TABS, {...COMMENTS_TAB, badge: commentsBadge}]), [comments, commentsBadge]);
  const shown = props.leftTab === 'comments' && comments === undefined ? 'file' : props.leftTab;
  const header = <Tabs idBase="dz-phone-left" tabs={tabs} value={shown} onChange={props.onLeftTabChange} aria-label="Layers and assets" />;
  return (
    <PhoneSheet label="Layers" onClose={props.onClose} header={header}>
      {shown === 'comments' ? (
        <TabPanel idBase="dz-phone-left" id="comments" className="dz-phone-sheet-panel dz-left-comments">{comments}</TabPanel>
      ) : shown === 'file' ? (
        <TabPanel idBase="dz-phone-left" id="file" className="dz-phone-sheet-panel dz-left-file">
          {props.pages !== undefined && <div className="dz-left-pages">{props.pages}</div>}
          <div className="dz-left-layers">{props.layers}</div>
        </TabPanel>
      ) : (
        <TabPanel idBase="dz-phone-left" id="assets" className="dz-phone-sheet-panel dz-scroll">{props.assets}</TabPanel>
      )}
    </PhoneSheet>
  );
}

/** "Properties": the right panel — "Design", "Prototype", "Code" and the zoom, or what a mode puts in their place. */
function PropertiesSheet(props: PhoneEditorLayoutProps & {onClose: () => void}) {
  const {rightTab, rightOverride} = props;
  const body = rightTab === 'design' ? props.designPanel : rightTab === 'prototype' ? props.prototypePanel : props.codePanel;
  const zoom = <ZoomMenu zoom={props.zoom} onZoom={props.onZoom} />;
  const header = rightOverride !== undefined
    ? <><span className="dz-panel-override-spacer" />{zoom}</>
    : <><Tabs idBase="dz-phone-right" tabs={RIGHT_TABS} value={rightTab} onChange={props.onRightTabChange} aria-label="Properties" />{zoom}</>;
  return (
    <PhoneSheet label="Properties" onClose={props.onClose} header={header}>
      {rightOverride !== undefined
        ? <div className="dz-phone-sheet-panel dz-scroll">{rightOverride}</div>
        : <TabPanel idBase="dz-phone-right" id={rightTab} className="dz-phone-sheet-panel dz-scroll">{body}</TabPanel>}
    </PhoneSheet>
  );
}

/** Undo (no keyboard on a phone; redo is in "⋯ › Edit"), ▶ and "Share" as icons so the name keeps its room;
 *  "Export" lives in "⋯ › File" unless there is no sharing. */
function PhoneFileActions({commands, onPlay, onExport, onShare}: PhoneEditorLayoutProps) {
  // A long press on "Undo" (long-press.ts sends it as a context menu) offers "Redo".
  const menu = useContextMenu();
  const redo = commands('edit.redo');
  const offerRedo = (event: React.MouseEvent<HTMLButtonElement>) => {
    if (!redo) return;
    menu.open(event, [{id: 'edit.redo', label: redo.label, onSelect: redo.run}]);
  };
  return (
    <>
      <IconButton label="Undo" tooltip={false} size={32} onClick={() => commands('edit.undo')?.run()} onContextMenu={offerRedo}><IconUndo /></IconButton>
      {menu.element}
      <IconButton label="Present" tooltip={false} size={32} disabled={!onPlay} onClick={onPlay}><IconPlay /></IconButton>
      {onShare
        ? <IconButton label="Share" tooltip={false} size={32} className="dz-phone-share" onClick={onShare}><IconUserPlus /></IconButton>
        : <IconButton label="Export" tooltip={false} size={32} disabled={!onExport} onClick={onExport}><IconExport /></IconButton>}
    </>
  );
}

/** "Select": while on, a tap adds to or takes from the selection and a one-finger drag is a marquee (engine/touch/select-tool.ts);
 *  it goes off by itself once the selection is cleared. */
function SelectToggle({store}: {store: DesignStore}) {
  const on = useDesignStore(state => state.tool === TOUCH_SELECT_TOOL, Object.is, {store, slice: 'tool'});
  useEffect(() => {
    const unregister = registerTool(TOUCH_SELECT_TOOL, () => new TouchSelectTool());
    const stop = followSelectionOff(store);
    return () => {
      stop();
      if (store.getState().tool === TOUCH_SELECT_TOOL) store.setTool('move');
      unregister();
    };
  }, [store]);
  return (
    <IconButton label="Select" tooltip={false} size={32} pressed={on} className="dz-phone-sheet-button" onClick={() => store.setTool(on ? 'move' : TOUCH_SELECT_TOOL)}>
      <IconLasso />
    </IconButton>
  );
}
