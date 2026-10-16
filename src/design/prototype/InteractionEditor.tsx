import {useEffect, useMemo, useRef, useState, type ClipboardEvent, type ReactNode} from 'react';
import type {Action, Easing, NodeId, Reaction, RGBA, TransitionDirection} from '../../../shared/design/types';
import {
  actionKind, changeDestinations, DEFAULT_OVERLAY_BACKGROUND, isDirectional, isSafeUrl, isSpringEasing, makeAction, makeTransition, makeTrigger, MAX_DURATION,
  MAX_TIMEOUT, needsDestination, newOverlayFrames, reactionIssues, scrollDestinations, transitionDuration, transitionsFor, type ActionKind, type NodeAction, type TransitionType,
} from '../../../shared/design/prototype';
import type {DesignStore} from '../engine/store';
import {IconButton} from '../ui/Button';
import {Checkbox} from '../ui/Toggle';
import {IconClock, IconClose, IconLink, IconMinus, IconPlus, IconWarning, type IconComponent} from '../ui/icons';
import {NumberField, type NumberChangeSource} from '../ui/NumberField';
import {besidePanel, FloatingPanel} from '../ui/ColorPicker';
import {Select, type SelectEntry} from '../ui/Select';
import {SegmentedControl} from '../ui/Tabs';
import {TextInput} from '../ui/TextInput';
import {formatShortcut, isMacPlatform} from '../ui/shortcuts';
import {ColorField} from './ColorField';
import {EasingCurve} from './EasingCurve';
import {IconProtoArrowDown, IconProtoArrowLeft, IconProtoArrowRight, IconProtoArrowUp, IconProtoChangeTo, IconProtoMatching, IconProtoCloseOverlay, IconProtoOverlay, IconProtoScrollTo, IconProtoSwap} from './icons';
import {ACTION_OPTIONS, DIRECTION_LABELS, EASING_OPTIONS, OVERLAY_POSITION_OPTIONS, transitionLabel, TRIGGER_OPTIONS} from './labels';
import {useNodeEdit, type FrameEntry, type ProtoNodeView} from './panel-state';
import {matchingInteractions} from './matching';
import {reactionsText} from './reaction-clipboard';

// One interaction's details, in a popover beside its row, laid out as Figma's Interaction details: the trigger in
// the header with "Add action" and "Close" beside it, then each action (its icon and kind) with where it
// goes, how it animates and the state it keeps; titles appear only to tell several actions apart. An action that cannot be stored yet (no frame picked, a
// link not typed) stays a draft here, so the document never holds a broken one.

type Draft = {kind: ActionKind};

export type InteractionEditorProps = {
  store: DesignStore;
  node: ProtoNodeView;
  /** The layers edited together (several selected with the same interactions); `node` is the first. */
  ids?: readonly NodeId[];
  index: number;
  frames: readonly FrameEntry[];
  anchor: Element;
  onClose: () => void;
};

export function InteractionEditor({store, node, ids = [node.id], index, frames, anchor, onClose}: InteractionEditorProps) {
  const reaction = node.reactions[index] as Reaction | undefined;
  const [draft, setDraft] = useState<Draft | null>(() => (reaction && !reaction.actions.length ? {kind: 'NAVIGATE'} : null));
  const {edit, end} = useNodeEdit(store);
  // Beside the properties panel at the row's height, as the editor's other pickers open.
  const beside = useMemo(() => besidePanel(anchor), [anchor]);
  if (!reaction) return null;
  const doc = store.getState().doc;

  const setReaction = (label: string, make: (current: Reaction) => Reaction, source?: NumberChangeSource) => {
    // A frame first opened as an overlay closes on a click outside it, as Figma sets it up (the checkbox starts on).
    const now = store.getState().doc;
    const existing = now.nodes[node.id]?.reactions[index];
    const fresh = existing ? newOverlayFrames(now, node.id, make(existing)) : [];
    edit(label, [...ids, ...fresh.filter(id => !ids.includes(id))], current => {
      if (!ids.includes(current.id)) return {overlayBackgroundInteraction: 'CLOSE_ON_CLICK_OUTSIDE'};
      const own = current.reactions[index];
      return own ? {reactions: current.reactions.map((each, i) => (i === index ? make(each) : each))} : null;
    }, source);
  };
  const setAction = (label: string, actionIndex: number, next: Action | null, source?: NumberChangeSource) =>
    setReaction(label, current => ({...current, actions: next ? current.actions.map((each, i) => (i === actionIndex ? next : each)) : current.actions.filter((_, i) => i !== actionIndex)}), source);
  const appendAction = (next: Action) => {
    setReaction('Add action', current => ({...current, actions: [...current.actions, next]}));
    setDraft(null);
  };

  const changeKind = (actionIndex: number | null, kind: ActionKind) => {
    const previous = actionIndex === null ? null : reaction.actions[actionIndex];
    const next = makeAction(doc, node.id, kind, previous);
    if (actionIndex === null) {
      if (next) appendAction(next);
      else setDraft({kind});
      return;
    }
    if (next) setAction('Action', actionIndex, next);
    else {
      setAction('Action', actionIndex, null);
      setDraft({kind});
    }
  };

  const copyOrCut = (event: ClipboardEvent<HTMLDivElement>, cut: boolean) => {
    const target = event.target as HTMLElement;
    if (target.closest('input, textarea, [contenteditable="true"]')) return;
    event.preventDefault();
    event.stopPropagation();
    event.clipboardData.setData('text/plain', reactionsText([reaction]));
    if (cut) {
      edit('Cut interaction', ids, current => ({reactions: current.reactions.filter((_, i) => i !== index)}));
      onClose();
    }
  };

  const issues = reactionIssues(doc, node.id, reaction).filter(issue => !(draft && issue.code === 'no_action'));
  const trigger = reaction.trigger;

  return (
    <FloatingPanel anchor={beside} trigger={anchor} onClose={onClose} aria-label="Interaction" className="dz-proto-popover" layoutKey={reaction.actions.length + (draft ? 1 : 0)}>
      {/* ⌘C / ⌘X here copy the interaction, not the selected layers (outside a text field): ⌘V adds it to other layers. */}
      <div className="dz-proto-clipboard" onCopy={event => copyOrCut(event, false)} onCut={event => copyOrCut(event, true)}>
      <div className="dz-proto-popover__header">
        <Select aria-label="Trigger" appearance="quiet" className="dz-proto-trigger" value={trigger.type} options={TRIGGER_OPTIONS}
          onChange={type => setReaction('Trigger', current => ({...current, trigger: makeTrigger(type, current.trigger)}))} />
        <IconButton label="Select matching interactions" onClick={() => store.setSelection(matchingInteractions(store.getState().doc, node.id, index))}><IconProtoMatching /></IconButton>
        <IconButton label="Add action" disabled={!!draft} onClick={() => setDraft({kind: 'NAVIGATE'})}><IconPlus /></IconButton>
      </div>
      <div className="dz-proto-popover__body">
        {(trigger.type === 'AFTER_TIMEOUT' || trigger.type === 'ON_KEY_DOWN') && (
        <Group label="Trigger">
          {trigger.type === 'AFTER_TIMEOUT' && (
            <NumberField aria-label="Delay, ms" icon={<IconClock />} suffix=" ms" value={Math.round(trigger.timeout * 1000)} min={0} max={MAX_TIMEOUT * 1000} step={100} scrubStep={10} precision={0}
              onChange={(value, source) => setReaction('Delay', current => ({...current, trigger: {type: 'AFTER_TIMEOUT', timeout: value / 1000}}), source)}
              onScrubEnd={end} />
          )}
          {trigger.type === 'ON_KEY_DOWN' && (
            <KeyField value={trigger.keyCode} onChange={keyCode => setReaction('Key', current => ({...current, trigger: {type: 'ON_KEY_DOWN', keyCode}}))} />
          )}
        </Group>
        )}
        {reaction.actions.map((action, actionIndex) => (
          <ActionEditor key={actionIndex} store={store} sourceId={node.id} kind={actionKind(action)} action={action} frames={frames}
            title={reaction.actions.length > 1 || draft ? `Action ${actionIndex + 1}` : undefined}
            onKind={kind => changeKind(actionIndex, kind)}
            onChange={(next, source) => setAction('Action', actionIndex, next, source)}
            onScrubEnd={end}
            onRemove={reaction.actions.length > 1 || draft ? () => setAction('Remove action', actionIndex, null) : undefined} />
        ))}
        {draft && (
          <ActionEditor store={store} sourceId={node.id} kind={draft.kind} action={null} frames={frames}
            title={reaction.actions.length ? `Action ${reaction.actions.length + 1}` : undefined}
            onKind={kind => changeKind(null, kind)}
            onChange={next => next && appendAction(next)}
            onScrubEnd={end}
            onRemove={reaction.actions.length ? () => setDraft(null) : undefined} />
        )}
        {issues.length > 0 && (
          <ul className="dz-proto-issues" role="status">
            {issues.map(issue => <li key={issue.code + (issue.actionIndex ?? '')}><IconWarning />{issue.message}</li>)}
          </ul>
        )}
      </div>
      </div>
      {/* Last in the DOM so opening focuses the trigger, not the close button; shown in the header. */}
      <IconButton label="Close" tooltip={false} className="dz-proto-popover__close" onClick={onClose}><IconClose /></IconButton>
    </FloatingPanel>
  );
}

/** A block of the details: `label` names it for assistive technology; `title` shows a heading row (several actions). */
function Group({label, title, actions, className = '', children}: {label: string; title?: string; actions?: ReactNode; className?: string; children: ReactNode}) {
  return (
    <section className={`dz-proto-group ${title ? 'has-title' : ''} ${className}`.trim()} aria-label={title ?? label}>
      {title && <div className="dz-proto-group__title"><span>{title}</span>{actions}</div>}
      {children}
    </section>
  );
}

type ActionEditorProps = {
  store: DesignStore;
  sourceId: NodeId;
  kind: ActionKind;
  /** null: a draft not stored yet. */
  action: Action | null;
  frames: readonly FrameEntry[];
  /** Shown when the interaction has several actions; one action goes untitled, as in Figma. */
  title?: string;
  onKind: (kind: ActionKind) => void;
  onChange: (next: Action | null, source?: NumberChangeSource) => void;
  onScrubEnd: (cancelled: boolean) => void;
  onRemove?: () => void;
};

const DIRECTIONS: {value: TransitionDirection; label: string; icon: ReactNode}[] = [
  {value: 'LEFT', label: DIRECTION_LABELS.LEFT, icon: <IconProtoArrowLeft />},
  {value: 'RIGHT', label: DIRECTION_LABELS.RIGHT, icon: <IconProtoArrowRight />},
  {value: 'TOP', label: DIRECTION_LABELS.TOP, icon: <IconProtoArrowUp />},
  {value: 'BOTTOM', label: DIRECTION_LABELS.BOTTOM, icon: <IconProtoArrowDown />},
];

function ActionEditor({store, sourceId, kind, action, frames, title, onKind, onChange, onScrubEnd, onRemove}: ActionEditorProps) {
  const doc = store.getState().doc;
  const nodeAction = action?.type === 'NODE' ? action : null;
  const destinations = destinationOptions(store, sourceId, kind, frames);
  const removeButton = onRemove ? <IconButton label="Remove action" onClick={onRemove}><IconMinus /></IconButton> : undefined;
  const pickDestination = (destinationId: NodeId) => {
    const next = makeAction(doc, sourceId, kind, action, destinationId);
    if (next) onChange(next);
  };
  return (
    <Group label="Action" title={title} actions={removeButton} className="dz-proto-action">
        <Select aria-label="Action" appearance="quiet" icon={<ActionIcon kind={kind} />} className="dz-proto-strong" value={kind} options={ACTION_OPTIONS} onChange={onKind} />
        {needsDestination(kind) && (
          <Select aria-label="Destination" appearance="quiet" className="dz-proto-indent" value={nodeAction?.destinationId ?? null} options={destinations} onChange={pickDestination}
            placeholder={destinations.length ? (kind === 'CHANGE_TO' ? 'Choose a variant' : kind === 'SCROLL_TO' ? 'Choose a layer' : 'Choose a frame') : 'Nowhere to go: no suitable layers'}
            disabled={!destinations.length} />
        )}
        {kind === 'URL' && <UrlField action={action?.type === 'URL' ? action : null} onChange={onChange} />}
        {(kind === 'OVERLAY' || kind === 'SWAP') && nodeAction && <OverlaySettings store={store} frameId={nodeAction.destinationId} />}
        {nodeAction && transitionsFor(kind).length > 0 && (
          <TransitionEditor kind={kind} action={nodeAction} onChange={onChange} onScrubEnd={onScrubEnd} />
        )}
        {kind === 'NAVIGATE' && nodeAction && (
          <div className="dz-proto-indent dz-proto-state" role="group" aria-label="State">
            <div className="dz-proto-caption">State</div>
            <Checkbox checked={!!nodeAction.preserveScrollPosition} onChange={checked => onChange(withFlag(nodeAction, 'preserveScrollPosition', checked))}>Preserve scroll position</Checkbox>
          </div>
        )}
    </Group>
  );
}

function withFlag(action: NodeAction, key: 'preserveScrollPosition', value: boolean): NodeAction {
  const next = {...action};
  if (value) next[key] = true;
  else delete next[key];
  return next;
}

function destinationOptions(store: DesignStore, sourceId: NodeId, kind: ActionKind, frames: readonly FrameEntry[]): SelectEntry<NodeId>[] {
  const doc = store.getState().doc;
  const named = (id: NodeId) => ({value: id, label: doc.nodes[id]?.name || 'Unnamed'});
  if (kind === 'SCROLL_TO') return scrollDestinations(doc, sourceId, 300).map(named);
  if (kind === 'CHANGE_TO') return changeDestinations(doc, sourceId).map(named);
  return frames.map(([id, name]) => ({value: id, label: name || 'Unnamed'}));
}

function TransitionEditor({kind, action, onChange, onScrubEnd}: {kind: ActionKind; action: NodeAction; onChange: ActionEditorProps['onChange']; onScrubEnd: (cancelled: boolean) => void}) {
  const transition = action.transition;
  const options: SelectEntry<TransitionType>[] = transitionsFor(kind).map(type => ({value: type, label: transitionLabel(type, kind)}));
  const set = (next: NodeAction['transition'], source?: NumberChangeSource) => onChange({...action, transition: next}, source);
  const animated = transition.type !== 'INSTANT';
  const spring = animated && isSpringEasing(transition.easing);
  const seconds = transitionDuration(transition);
  return (
    <div className="dz-proto-indent dz-proto-transition" role="group" aria-label="Animation">
      <Select aria-label="Animation" appearance="quiet" value={transition.type} options={options} onChange={type => set(makeTransition(type, transition))} />
      {animated && 'direction' in transition && (
        <SegmentedControl aria-label="Direction" fill options={DIRECTIONS} value={transition.direction} onChange={direction => set({...transition, direction})} />
      )}
      {animated && (
        <>
          <EasingCurve easing={transition.easing} seconds={seconds} />
          <div className="dz-proto-row">
            <Select aria-label="Easing" value={transition.easing} options={EASING_OPTIONS} onChange={(easing: Easing) => set({...transition, easing})} className="dz-proto-grow" />
            <NumberField aria-label="Duration, ms" icon={<IconClock />} suffix=" ms" className="dz-proto-duration" value={Math.round(seconds * 1000)} min={1} max={MAX_DURATION * 1000} step={50} scrubStep={5} precision={0}
              disabled={spring} title={spring ? 'A spring sets its own duration' : undefined}
              onChange={(value, source) => set({...transition, duration: value / 1000}, source)} onScrubEnd={onScrubEnd} />
          </div>
        </>
      )}
      {animated && isDirectional(transition.type) && kind !== 'SCROLL_TO' && (
        <p className="dz-proto-note">The screen moves as a whole. To make layers with the same name flow into each other, choose “Smart animate”.</p>
      )}
    </div>
  );
}

/** The action's glyph before its kind, as Figma's details show one (drawn here, not Figma's). */
function ActionIcon({kind}: {kind: ActionKind}) {
  const Icon = ACTION_ICONS[kind];
  return <Icon />;
}

const ACTION_ICONS: Record<ActionKind, IconComponent> = {
  NAVIGATE: IconProtoArrowRight, OVERLAY: IconProtoOverlay, SWAP: IconProtoSwap, SCROLL_TO: IconProtoScrollTo,
  CHANGE_TO: IconProtoChangeTo, BACK: IconProtoArrowLeft, CLOSE: IconProtoCloseOverlay, URL: IconLink,
};

function UrlField({action, onChange}: {action: Extract<Action, {type: 'URL'}> | null; onChange: (next: Action) => void}) {
  const [text, setText] = useState(action?.url ?? '');
  const [newTab, setNewTab] = useState(action?.openInNewTab ?? true);
  const [error, setError] = useState(false);
  useEffect(() => {
    if (action) {
      setText(action.url);
      setNewTab(action.openInNewTab);
    }
  }, [action]);
  const commit = (value: string) => {
    const url = value.trim();
    if (!url) return;
    // A bare address gets https:// as browsers' address bars do.
    const candidate = /^[a-z][a-z0-9+.-]*:/i.test(url) ? url : 'https://' + url;
    if (!isSafeUrl(candidate)) {
      setError(true);
      return;
    }
    setError(false);
    setText(candidate);
    onChange({type: 'URL', url: candidate, openInNewTab: newTab});
  };
  return (
    <>
      <TextInput aria-label="Link address" placeholder="https://" value={text} onChange={value => {setText(value); setError(false);}} onCommit={commit}
        aria-invalid={error || undefined} className={error ? 'is-invalid' : ''} />
      {error && <p className="dz-proto-error">The link must start with http://, https:// or mailto:.</p>}
      <Checkbox checked={newTab} onChange={checked => {
        setNewTab(checked);
        if (action) onChange({...action, openInNewTab: checked});
      }}>Open in a new tab</Checkbox>
    </>
  );
}

/** "Key": press to record the next key (with its modifiers); Escape gives up. */
function KeyField({value, onChange}: {value: string; onChange: (keyCode: string) => void}) {
  const [listening, setListening] = useState(false);
  const button = useRef<HTMLButtonElement>(null);
  useEffect(() => {
    if (!listening) return;
    const mac = isMacPlatform();
    const key = (event: KeyboardEvent) => {
      event.preventDefault();
      event.stopPropagation();
      if (event.code === 'Escape' && !event.shiftKey && !event.altKey && !event.metaKey && !event.ctrlKey) {
        setListening(false);
        return;
      }
      if (['ShiftLeft', 'ShiftRight', 'AltLeft', 'AltRight', 'MetaLeft', 'MetaRight', 'ControlLeft', 'ControlRight'].includes(event.code) || !event.code) return;
      const parts = [
        mac && event.ctrlKey ? 'Ctrl' : '',
        event.altKey ? 'Alt' : '',
        event.shiftKey ? 'Shift' : '',
        (mac ? event.metaKey : event.ctrlKey) ? 'Mod' : '',
        event.code,
      ].filter(Boolean);
      onChange(parts.join('+').slice(0, 64));
      setListening(false);
    };
    const leave = (event: PointerEvent) => {
      if (event.target !== button.current) setListening(false);
    };
    window.addEventListener('keydown', key, true);
    window.addEventListener('pointerdown', leave, true);
    return () => {
      window.removeEventListener('keydown', key, true);
      window.removeEventListener('pointerdown', leave, true);
    };
  }, [listening, onChange]);
  return (
    <button ref={button} type="button" className={`dz-proto-key ${listening ? 'is-listening' : ''}`} aria-label="Key" aria-pressed={listening} onClick={() => setListening(!listening)}>
      {listening ? 'Press a key…' : <kbd className="dz-kbd">{value ? formatShortcut(value) : '—'}</kbd>}
    </button>
  );
}

/** How the destination frame shows as an overlay. These settings live on that frame (Figma's model),
 *  so every interaction opening it agrees. */
export function OverlaySettings({store, frameId}: {store: DesignStore; frameId: NodeId}) {
  const {edit, end} = useNodeEdit(store);
  const frame = store.getState().doc.nodes[frameId];
  if (!frame) return null;
  const background = frame.overlayBackground?.type === 'SOLID_COLOR' ? frame.overlayBackground.color : null;
  const set = (label: string, partial: Parameters<typeof edit>[2], source?: NumberChangeSource) => edit(label, [frameId], partial, source);
  return (
    <div className="dz-proto-overlay-settings">
      <Select aria-label="Overlay position" value={frame.overlayPositionType ?? 'CENTER'} options={OVERLAY_POSITION_OPTIONS}
        onChange={position => set('Overlay position', () => ({overlayPositionType: position}))} />
      <Checkbox checked={frame.overlayBackgroundInteraction === 'CLOSE_ON_CLICK_OUTSIDE'}
        onChange={checked => set('Overlay closing', () => ({overlayBackgroundInteraction: checked ? 'CLOSE_ON_CLICK_OUTSIDE' : 'NONE'}))}>Close when clicking outside</Checkbox>
      <Checkbox checked={!!background} onChange={checked => set('Overlay background', () => ({overlayBackground: checked ? {type: 'SOLID_COLOR', color: {...DEFAULT_OVERLAY_BACKGROUND}} : {type: 'NONE'}}))}>Dim the background</Checkbox>
      {background && (
        <ColorField label="Overlay background color" color={background} alpha onChangeEnd={end}
          onChange={(color: RGBA, source) => set('Overlay background', () => ({overlayBackground: {type: 'SOLID_COLOR', color}}), source)} />
      )}
    </div>
  );
}
