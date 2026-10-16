import '../styles/prototype.css';
import {memo, useCallback, useLayoutEffect, useRef, useState} from 'react';
import {createPortal} from 'react-dom';
import type {FlowStartingPoint, NodeId, PrototypeDevice, RGB} from '../../../shared/design/types';
import {
  DEFAULT_PROTOTYPE_BACKGROUND, DEVICE_PRESETS, defaultReaction, deviceScreen, flowStartingPoints, reactionIssues, withFlowRemoved, withFlowRenamed, withFlowsAdded,
} from '../../../shared/design/prototype';
import type {DesignStore} from '../engine/store';
import {useEditorServices} from '../editor/services';
import {IconButton} from '../ui/Button';
import {IconMinus, IconPlay, IconWarning} from '../ui/icons';
import {PanelSection} from '../ui/PanelSection';
import {Select, type SelectEntry} from '../ui/Select';
import {TextInput} from '../ui/TextInput';
import {ConnectionsLayer} from './CanvasOverlay';
import {ColorField} from './ColorField';
import {ensurePlayerFeed} from './feed';
import {IconProtoFlow, IconProtoInteraction, IconProtoRotate} from './icons';
import {InteractionEditor, OverlaySettings} from './InteractionEditor';
import {OVERFLOW_OPTIONS, reactionSummary, SCROLL_BEHAVIOR_OPTIONS, triggerLabel} from './labels';
import {openPlayer} from './open-player';
import {useFrames, useNodeEdit, usePageView, useProtoNodes, useSelection, type ProtoNodeView} from './panel-state';
import {prototypeUi, useOpenInteraction} from './state';
import {sameInteractions} from './matching';

// The "Prototype" tab. With nothing selected: the page's flows, the device the player shows them in
// and the player's backdrop. With a layer selected: its interactions (each opens in a popover), the
// flow it starts, how a frame scrolls and shows as an overlay, and how a child of a frame behaves
// when that frame scrolls. It reads only prototype fields, so moving layers re-renders none of it.

export const PrototypePanel = memo(function PrototypePanel() {
  const {store, fileId} = useEditorServices();
  const selection = useSelection(store);
  const nodes = useProtoNodes(store, selection);
  // While the tab is open the canvas shows the connections (drawn into the canvas's host), and the
  // editor answers players of this file with its live document.
  const anchor = useRef<HTMLDivElement>(null);
  const [host, setHost] = useState<Element | null>(null);
  useLayoutEffect(() => {
    const editor = anchor.current?.closest('.dz-editor') ?? null;
    ensurePlayerFeed(fileId, store, editor);
    setHost(editor?.querySelector('.dz-canvas-host') ?? null);
  }, [store, fileId]);
  return (
    <div ref={anchor} className="dz-proto-panel">
      {nodes.length ? <SelectionSettings store={store} fileId={fileId} nodes={nodes} /> : <PageSettings store={store} fileId={fileId} />}
      {host && createPortal(<ConnectionsLayer store={store} fileId={fileId} />, host)}
    </div>
  );
});

// ── Nothing selected ─────────────────────────────────────────────────────────────────────────────

const DEVICE_OPTIONS: SelectEntry<string>[] = [
  {value: 'NONE', label: 'None'},
  {separator: true},
  ...DEVICE_PRESETS.map(preset => ({value: preset.id, label: preset.name, description: `${preset.width}\u00a0×\u00a0${preset.height}`})),
];

function PageSettings({store, fileId}: {store: DesignStore; fileId: string}) {
  const page = usePageView(store);
  const {edit, end} = useNodeEdit(store);
  const device = page.prototypeDevice ?? {type: 'NONE'};
  const screen = deviceScreen(device);
  const setDevice = (next: PrototypeDevice) => edit('Device', [page.id], () => ({prototypeDevice: next}));
  const background = page.prototypeBackground ?? DEFAULT_PROTOTYPE_BACKGROUND;
  // As Figma's Prototype tab with nothing selected: "Prototype settings" (device, orientation, background) first, then the
  // page's flows.
  return (
    <>
      <PanelSection title="Prototype settings" first>
        <div className="dz-proto-setting">
          <span className="dz-proto-setting-label">Device</span>
          <div className="dz-proto-row">
            <Select aria-label="Device" className="dz-proto-grow" value={device.type === 'PRESET' ? device.presetId : 'NONE'} options={DEVICE_OPTIONS}
              onChange={id => setDevice(id === 'NONE' ? {type: 'NONE'} : {type: 'PRESET', presetId: id, rotation: device.type === 'PRESET' ? device.rotation : 0})} />
            <IconButton label={screen?.landscape ? 'Rotate to portrait' : 'Rotate to landscape'} pressed={!!screen?.landscape}
              disabled={!screen || screen.preset.kind === 'desktop' || screen.preset.kind === 'laptop'}
              onClick={() => device.type === 'PRESET' && setDevice({...device, rotation: device.rotation === 90 ? 0 : 90})}>
              <IconProtoRotate />
            </IconButton>
          </div>
        </div>
        <p className="dz-panel-note">{screen ? `Screen ${screen.width} × ${screen.height}. Frames are fitted to the width.` : 'Frames are shown at their own size.'}</p>
        <div className="dz-proto-setting">
          <span className="dz-proto-setting-label">Background</span>
          <ColorField label="Player background" color={background} onChangeEnd={end}
            onChange={(color: RGB, source) => edit('Player background', [page.id], () => ({prototypeBackground: {r: color.r, g: color.g, b: color.b}}), source)} />
        </div>
      </PanelSection>
      <FlowsSection store={store} fileId={fileId} pageId={page.id} />
    </>
  );
}

function FlowsSection({store, fileId, pageId, first}: {store: DesignStore; fileId: string; pageId: NodeId; first?: boolean}) {
  usePageView(store);
  const frames = useFrames(store);
  const services = useEditorServices();
  const doc = store.getState().doc;
  const flows = flowStartingPoints(doc, pageId);
  const {edit} = useNodeEdit(store);
  const write = (label: string, make: (list: readonly FlowStartingPoint[]) => FlowStartingPoint[]) =>
    edit(label, [pageId], page => ({flowStartingPoints: make(page.flowStartingPoints ?? [])}));
  const reveal = (id: NodeId) => {
    store.setSelection([id]);
    services.revealNodes([id]);
  };
  return (
    <PanelSection title="Flows" first={first} empty={!flows.length && !frames.length}>
      {flows.length ? (
        <ul className="dz-proto-flows">
          {flows.map(flow => (
            <FlowRow key={flow.nodeId} flow={flow} onSelect={() => reveal(flow.nodeId)} onPlay={() => openPlayer(fileId, flow.nodeId)}
              onRename={name => write('Rename flow', list => withFlowRenamed(list, flow.nodeId, name))}
              onRemove={() => write('Delete flow', list => withFlowRemoved(list, flow.nodeId))} />
          ))}
        </ul>
      ) : (
        <p className="dz-panel-note">Select a frame and add it as a flow starting point — the flow can then be run in the player.</p>
      )}
    </PanelSection>
  );
}

function FlowRow({flow, onSelect, onPlay, onRename, onRemove}: {flow: FlowStartingPoint; onSelect: () => void; onPlay: () => void; onRename: (name: string) => void; onRemove: () => void}) {
  const [renaming, setRenaming] = useState(false);
  const [name, setName] = useState(flow.name);
  return (
    <li className="dz-proto-flow">
      <span className="dz-proto-flow__icon"><IconProtoFlow /></span>
      {renaming ? (
        <TextInput aria-label="Flow name" appearance="field" autoFocus selectOnFocus value={name} onChange={setName}
          onCommit={value => {
            onRename(value);
            setRenaming(false);
          }}
          onCancel={() => setRenaming(false)} onBlur={() => setRenaming(false)} className="dz-proto-grow" />
      ) : (
        <button type="button" className="dz-proto-flow__name" onClick={onSelect} onDoubleClick={() => {
          setName(flow.name);
          setRenaming(true);
        }} title="Double-click to rename">{flow.name}</button>
      )}
      <IconButton label="Run" className="dz-proto-flow__play" onClick={onPlay}><IconPlay /></IconButton>
      <IconButton label="Delete flow" className="dz-proto-flow__remove" onClick={onRemove}><IconMinus /></IconButton>
    </li>
  );
}

// ── A selection ──────────────────────────────────────────────────────────────────────────────────

function SelectionSettings({store, fileId, nodes}: {store: DesignStore; fileId: string; nodes: ProtoNodeView[]}) {
  const single = nodes.length === 1 ? nodes[0] : null;
  const frames = useFrames(store);
  const page = usePageView(store);
  const {edit} = useNodeEdit(store);
  const topLevel = nodes.filter(node => node.topLevel);
  const frameLike = nodes.filter(node => node.frameLike);
  const children = nodes.filter(node => node.inFrame);
  const ids = (list: ProtoNodeView[]) => list.map(node => node.id);
  const same = <T,>(list: ProtoNodeView[], read: (node: ProtoNodeView) => T): T | 'mixed' => (list.every(node => read(node) === read(list[0])) ? read(list[0]) : 'mixed');

  return (
    <>
      {topLevel.length > 0 && <FlowStartSection store={store} fileId={fileId} pageId={page.id} frames={topLevel} />}
      {single || (nodes.length > 1 && sameInteractions(nodes)) ? (
        // Several layers with the same interactions are edited together, as Figma's interactions in bulk.
        <InteractionsSection store={store} node={single ?? nodes[0]} ids={ids(nodes)} frames={frames} first={!topLevel.length} />
      ) : (
        <PanelSection title="Interactions" first={!topLevel.length} onAdd={() => {
          edit('New interaction', ids(nodes), () => ({reactions: [defaultReaction(null)]}));
          prototypeUi(store).set({open: {nodeId: nodes[0].id, reactionIndex: 0}});
        }} addLabel="Replace interactions on all">
          <p className="dz-panel-note">The selected layers have different interactions. “+” replaces them with one new interaction on all.</p>
        </PanelSection>
      )}
      {frameLike.length > 0 && (
        <PanelSection title="Overflow scrolling">
          <Select aria-label="Overflow scrolling" value={valueOrNull(same(frameLike, node => node.overflowDirection ?? 'NONE'))} mixed={same(frameLike, node => node.overflowDirection ?? 'NONE') === 'mixed'}
            options={OVERFLOW_OPTIONS} onChange={direction => edit('Overflow scrolling', ids(frameLike), () => ({overflowDirection: direction}))} />
          <p className="dz-panel-note">The frame scrolls what extends past its edges. A tall top-level frame scrolls by itself in the player.</p>
        </PanelSection>
      )}
      {children.length > 0 && (
        <PanelSection title="Scroll behavior">
          <Select aria-label="Scroll behavior" value={valueOrNull(same(children, node => node.scrollBehavior ?? 'SCROLLS'))} mixed={same(children, node => node.scrollBehavior ?? 'SCROLLS') === 'mixed'}
            options={SCROLL_BEHAVIOR_OPTIONS} onChange={behavior => edit('Scroll behavior', ids(children), () => ({scrollBehavior: behavior}))} />
        </PanelSection>
      )}
      {single?.topLevel && (
        <PanelSection title="Overlay" collapsible defaultOpen={false}>
          <OverlaySettings store={store} frameId={single.id} />
        </PanelSection>
      )}
    </>
  );
}

const valueOrNull = <T,>(value: T | 'mixed'): T | null => (value === 'mixed' ? null : value);

function FlowStartSection({store, fileId, pageId, frames}: {store: DesignStore; fileId: string; pageId: NodeId; frames: ProtoNodeView[]}) {
  usePageView(store);
  const {edit} = useNodeEdit(store);
  const doc = store.getState().doc;
  const flows = flowStartingPoints(doc, pageId);
  const starting = frames.map(frame => flows.find(flow => flow.nodeId === frame.id)).filter((flow): flow is FlowStartingPoint => !!flow);
  const missing = frames.filter(frame => !flows.some(flow => flow.nodeId === frame.id));
  const write = (label: string, make: (list: readonly FlowStartingPoint[]) => FlowStartingPoint[]) =>
    edit(label, [pageId], node => ({flowStartingPoints: make(node.flowStartingPoints ?? [])}));
  const add = () => edit('Flow starting point', [pageId], () => ({flowStartingPoints: withFlowsAdded(store.getState().doc, pageId, missing.map(frame => frame.id))}));
  return (
    <PanelSection title="Flow starting point" first empty={!starting.length} onAdd={missing.length ? add : undefined} addLabel="Make flow starting point">
      {starting.length > 0 && (
        <ul className="dz-proto-flows">
          {starting.map(flow => (
            <FlowRow key={flow.nodeId} flow={flow} onSelect={() => store.setSelection([flow.nodeId])} onPlay={() => openPlayer(fileId, flow.nodeId)}
              onRename={name => write('Rename flow', list => withFlowRenamed(list, flow.nodeId, name))}
              onRemove={() => write('Delete flow', list => withFlowRemoved(list, flow.nodeId))} />
          ))}
        </ul>
      )}
    </PanelSection>
  );
}

function InteractionsSection({store, node, ids, frames, first}: {store: DesignStore; node: ProtoNodeView; ids: readonly NodeId[]; frames: ReturnType<typeof useFrames>; first: boolean}) {
  const opened = useOpenInteraction(store);
  const rows = useRef(new Map<number, HTMLElement>());
  const open = opened && opened.nodeId === node.id && opened.reactionIndex < node.reactions.length ? opened.reactionIndex : null;
  // The popover hangs off its row, which exists only after the render that adds it.
  const [anchor, setAnchor] = useState<HTMLElement | null>(null);
  useLayoutEffect(() => setAnchor(open !== null ? rows.current.get(open) ?? null : null), [open, node.reactions.length]);
  const setOpen = useCallback((index: number | null) => prototypeUi(store).set({open: index === null ? null : {nodeId: node.id, reactionIndex: index}}), [store, node.id]);
  const {edit} = useNodeEdit(store);
  const doc = store.getState().doc;
  const add = () => {
    const index = node.reactions.length;
    edit('New interaction', ids, current => ({reactions: [...current.reactions, defaultReaction(null)]}));
    setOpen(index);
  };
  const remove = (index: number) => {
    if (open !== null) setOpen(null);
    edit('Delete interaction', ids, current => ({reactions: current.reactions.filter((_, i) => i !== index)}));
  };
  return (
    <PanelSection title="Interactions" first={first} empty={!node.reactions.length} onAdd={add} addLabel="Add interaction">
      {node.reactions.length > 0 && (
        <ul className="dz-proto-interactions">
          {node.reactions.map((reaction, index) => {
            const broken = reactionIssues(doc, node.id, reaction).some(issue => issue.code !== 'no_action');
            return (
              <li key={index} ref={element => {
                if (element) rows.current.set(index, element);
                else rows.current.delete(index);
              }} className={`dz-proto-interaction ${open === index ? 'is-open' : ''}`}>
                <button type="button" className="dz-proto-interaction__main" aria-expanded={open === index} onClick={() => setOpen(open === index ? null : index)}>
                  <span className="dz-proto-interaction__icon">{broken ? <IconWarning /> : <IconProtoInteraction />}</span>
                  <span className="dz-proto-interaction__text">
                    <span className="dz-proto-interaction__trigger">{triggerLabel(reaction.trigger)}</span>
                    <span className="dz-proto-interaction__action">{reactionSummary(doc, reaction)}</span>
                  </span>
                </button>
                <IconButton label="Delete interaction" className="dz-proto-interaction__remove" onClick={() => remove(index)}><IconMinus /></IconButton>
              </li>
            );
          })}
        </ul>
      )}
      {open !== null && anchor && (
        <InteractionEditor key={`${node.id}:${open}`} store={store} node={node} ids={ids} index={open} frames={frames} anchor={anchor} onClose={() => setOpen(null)} />
      )}
    </PanelSection>
  );
}
