import {memo, useCallback, useMemo, useState} from 'react';
import type {Effect, NodeId, StyleId} from '../../../../../shared/design/types';
import type {EditorState} from '../../../engine/store';
import {useDesignStore, useStoreApi} from '../../../engine/useDesignStore';
import {userUpdate} from '../../../engine/user-edit';
import {IconButton} from '../../../ui/Button';
import {besidePanel} from '../../../ui/ColorPicker';
import {IconStyles} from '../../../ui/icons';
import {PanelSection} from '../../../ui/PanelSection';
import type {Rect} from '../../../ui/position';
import type {SectionProps} from '../sections';
import {useCommitter, type Recipe} from './editing';
import {EffectRows} from './EffectRows';
import {sameItems, StyleRow} from './PaintSection';
import {RowNote} from './PaintRows';
import {MIXED, commonList, newDropShadow, takesEffects} from './paints';
import {StyleEditor, StylesPopover} from './StyleList';
import {applyStyleTo, createStyleFrom, detachStyleFrom} from './style-ops';

// "Effects" (100): shadows and blurs of the selection, "+" adds Figma's first drop shadow (black
// 25 %, 4 px down, 4 px blur), and effect styles are applied, made, edited and detached here.

type EffectData = {targets: NodeId[]; lists: (readonly Effect[])[]; styleIds: (StyleId | undefined)[]};
const sameData = (a: EffectData, b: EffectData) => sameItems(a.targets, b.targets) && sameItems(a.lists, b.lists) && sameItems(a.styleIds, b.styleIds);

function selectEffects(state: EditorState, ids: readonly NodeId[]): EffectData {
  const data: EffectData = {targets: [], lists: [], styleIds: []};
  for (const id of ids) {
    const node = state.doc.nodes[id];
    if (!node || !takesEffects(node.type)) continue;
    data.targets.push(id);
    data.lists.push(node.effects);
    data.styleIds.push(node.effectStyleId);
  }
  return data;
}

function EffectsBody({ids}: SectionProps) {
  const store = useStoreApi();
  const selector = useCallback((state: EditorState) => selectEffects(state, ids), [ids]);
  const data = useDesignStore(selector, sameData, {slice: 'doc'});
  const committer = useCommitter();
  const [stylesAt, setStylesAt] = useState<{anchor: Rect; row: Element} | null>(null);
  const [editingStyle, setEditingStyle] = useState<{anchor: Rect; row: Element} | null>(null);
  const {targets} = data;
  const list = useMemo(() => commonList(data.lists), [data.lists]);
  const styleId = data.styleIds[0] && data.styleIds.every(each => each === data.styleIds[0]) ? data.styleIds[0] : null;
  const style = useDesignStore(state => (styleId ? state.doc.styles[styleId] : undefined), Object.is, {slice: 'doc'});
  const write = useCallback((make: (effects: Effect[]) => Effect[] | null): Recipe => tx => {
    for (const id of targets) {
      const node = tx.get(id);
      const next = node && make(node.effects);
      if (next) userUpdate(tx, id, {effects: next});
    }
  }, [targets]);
  if (!targets.length) return null;

  const add = () => store.transact('Effect', write(effects => (list === MIXED ? [newDropShadow()] : [...effects, newDropShadow()])));
  const empty = list !== MIXED && !list.length && !style;
  const canCreate = list !== MIXED && list.length > 0;
  return (
    <PanelSection title="Effects" empty={empty} onAdd={add} addLabel="Add effect"
      actions={(
        <IconButton label="Effect styles" pressed={!!stylesAt} onClick={event => {
          const row = event.currentTarget;
          setStylesAt(current => (current ? null : {anchor: besidePanel(row), row}));
        }}>
          <IconStyles />
        </IconButton>
      )}>
      {style ? (
        <StyleRow style={style} onEdit={row => setEditingStyle(current => (current ? null : {anchor: besidePanel(row), row}))}
          onSwap={row => setStylesAt(current => (current ? null : {anchor: besidePanel(row), row}))}
          onDetach={() => store.transact('Detach style', tx => detachStyleFrom(tx, targets, 'effects'))} />
      ) : list === MIXED ? (
        <RowNote>Click "+" to replace mixed effects</RowNote>
      ) : (
        list.length > 0 && <EffectRows effects={list} committer={committer} write={write} label="Effects" />
      )}
      {stylesAt && (
        <StylesPopover anchor={stylesAt.anchor} trigger={stylesAt.row} onClose={() => setStylesAt(null)} type="EFFECT" title="Effect styles" currentStyleId={styleId}
          onApply={id => {
            store.transact('Effect style', tx => applyStyleTo(tx, targets, id, 'effects'));
            setStylesAt(null);
          }}
          onCreate={canCreate ? name => store.transact('New style', tx => {
            createStyleFrom(tx, targets, 'effects', name);
          }) : undefined} />
      )}
      {editingStyle && style && <StyleEditor anchor={editingStyle.anchor} trigger={editingStyle.row} styleId={style.id} onClose={() => setEditingStyle(null)} />}
    </PanelSection>
  );
}

/** Keyed by the selection: a new selection closes what this section had open. */
export const EffectsSection = memo(function EffectsSection({ids, nodes}: SectionProps) {
  return <EffectsBody key={ids.join(',')} ids={ids} nodes={nodes} />;
}, (a, b) => sameItems(a.ids, b.ids));
