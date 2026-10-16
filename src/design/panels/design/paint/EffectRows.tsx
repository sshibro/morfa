import {memo, useState} from 'react';
import type {Effect, Paint, ShadowEffect} from '../../../../../shared/design/types';
import {solid} from '../../../../../shared/design/defaults';
import {IconButton} from '../../../ui/Button';
import {FloatingPanel, besidePanel} from '../../../ui/ColorPicker';
import {IconSliders, IconClose, IconEye, IconEyeOff, IconGrip, IconMinus} from '../../../ui/icons';
import {NumberField} from '../../../ui/NumberField';
import type {Rect} from '../../../ui/position';
import {Select, type SelectEntry} from '../../../ui/Select';
import {Checkbox} from '../../../ui/Toggle';
import {percent, toHex} from './color';
import type {Committer, Recipe} from './editing';
import {PaintPicker} from './PaintPicker';
import {HexField, PaintSwatch} from './PaintRows';
import {parseHex} from './color';
import {EFFECT_LABELS, convertEffect, displayOrder, reorderRows, removeAt, replaceAt, rowIndex} from './paints';
import {useRowReorder} from './reorder';

// The rows of "Effects" (and of an effect style): type, visibility, "−", and the settings popover
// with offsets, blur, spread, colour and "Show behind transparent areas". The top effect is
// listed first, as Figma lists them.

export type EffectWrite = (make: (effects: Effect[]) => Effect[] | null) => Recipe;

const TYPE_OPTIONS: SelectEntry<Effect['type']>[] = (Object.keys(EFFECT_LABELS) as Effect['type'][]).map(type => ({value: type, label: EFFECT_LABELS[type]}));

export function EffectRows({effects, committer, write, label}: {effects: readonly Effect[]; committer: Committer; write: EffectWrite; label: string}) {
  const [open, setOpen] = useState<{index: number; anchor: Rect; row: Element} | null>(null);
  const {listRef, gripProps} = useRowReorder((from, to) => committer.set('Reorder effects', write(list => reorderRows(list, from, to))));
  const rows = displayOrder(effects);
  const current = open ? effects[open.index] : undefined;
  return (
    <>
      <div ref={listRef} className="dz-paint-list" role="list" aria-label={label}>
        {rows.map((effect, row) => {
          const index = rowIndex(row, effects.length);
          return (
            <EffectRow key={index} effect={effect} index={index} open={open?.index === index} committer={committer} write={write}
              grip={rows.length > 1 ? gripProps(row) : null}
              onOpen={element => setOpen(value => (value?.index === index ? null : {index, anchor: besidePanel(element), row: element}))} />
          );
        })}
      </div>
      {open && current && (
        <EffectSettings anchor={open.anchor} trigger={open.row} effect={current} committer={committer} onClose={() => setOpen(null)}
          write={make => write(list => (list[open.index] ? replaceAt(list, open.index, make(list[open.index])) : null))} />
      )}
    </>
  );
}

type RowProps = {
  effect: Effect;
  index: number;
  open: boolean;
  committer: Committer;
  write: EffectWrite;
  onOpen: (row: HTMLElement) => void;
  grip: ReturnType<ReturnType<typeof useRowReorder>['gripProps']> | null;
};

const EffectRow = memo(function EffectRow({effect, index, open, committer, write, onOpen, grip}: RowProps) {
  const hidden = !effect.visible;
  const set = (label: string, make: (effect: Effect) => Effect) => committer.set(label, write(list => (list[index] ? replaceAt(list, index, make(list[index])) : null)));
  return (
    <div className={`dz-paint-row dz-effect-row ${open ? 'is-open' : ''} ${hidden ? 'is-hidden' : ''}`.trim()} role="listitem" data-reorder-row="">
      {grip && <span className="dz-row-grip" aria-hidden="true" {...grip}><IconGrip size={12} /></span>}
      <IconButton label="Effect settings" pressed={open} onClick={event => onOpen(event.currentTarget.closest('.dz-paint-row') as HTMLElement)}><IconSliders /></IconButton>
      <Select<Effect['type']> value={effect.type} options={TYPE_OPTIONS} aria-label="Effect type" appearance="quiet" className="dz-effect-type"
        onChange={type => set('Effect type', current => convertEffect(current, type))} />
      <IconButton label={hidden ? 'Show' : 'Hide'} onClick={() => set(hidden ? 'Show effect' : 'Hide effect', current => ({...current, visible: hidden}))}>
        {hidden ? <IconEyeOff /> : <IconEye />}
      </IconButton>
      <IconButton label="Delete" onClick={() => committer.set('Delete effect', write(list => removeAt(list, index)))}><IconMinus /></IconButton>
    </div>
  );
});

function EffectSettings({anchor, trigger, effect, committer, write, onClose}: {anchor: Rect; trigger: Element; effect: Effect; committer: Committer; write: (make: (effect: Effect) => Effect) => Recipe; onClose: () => void}) {
  const [colorOpen, setColorOpen] = useState<{row: Element; anchor: Rect} | null>(null);
  const scrub = (label: string) => ({onScrubStart: () => committer.begin(label), onScrubEnd: (cancelled: boolean) => (cancelled ? committer.cancel() : committer.end())});
  const set = (label: string, make: (effect: Effect) => Effect) => committer.set(label, write(make));
  const shadow = effect.type === 'DROP_SHADOW' || effect.type === 'INNER_SHADOW' ? effect : null;
  const colorPaint: Paint | null = shadow ? solid(shadow.color, shadow.color.a) : null;
  const withShadow = (make: (shadow: ShadowEffect) => ShadowEffect) => (current: Effect) => (current.type === 'DROP_SHADOW' || current.type === 'INNER_SHADOW' ? make(current) : current);
  return (
    <FloatingPanel anchor={anchor} trigger={trigger} onClose={onClose} aria-label={EFFECT_LABELS[effect.type]} className="dz-effect-settings" layoutKey={effect.type}>
      <div className="dz-cp-header">
        <h2 className="dz-cp-title">{EFFECT_LABELS[effect.type]}</h2>
        <IconButton label="Close" tooltip={false} onClick={onClose}><IconClose /></IconButton>
      </div>
      <div className="dz-effect-grid">
        {shadow && (
          <>
            <label className="dz-effect-label">Offset</label>
            <div className="dz-effect-pair">
              <NumberField label="X" aria-label="Offset X" value={shadow.offset.x} precision={1} {...scrub('Shadow')}
                onChange={x => set('Shadow', withShadow(current => ({...current, offset: {...current.offset, x}})))} />
              <NumberField label="Y" aria-label="Offset Y" value={shadow.offset.y} precision={1} {...scrub('Shadow')}
                onChange={y => set('Shadow', withShadow(current => ({...current, offset: {...current.offset, y}})))} />
            </div>
          </>
        )}
        <label className="dz-effect-label">Blur</label>
        <NumberField aria-label="Blur" value={effect.radius} min={0} max={1000} precision={1} {...scrub('Blur')}
          onChange={radius => set('Blur', current => ({...current, radius}))} />
        {shadow && (
          <>
            <label className="dz-effect-label">Spread</label>
            <NumberField aria-label="Spread" value={shadow.spread} min={-1000} max={1000} precision={1} {...scrub('Shadow')}
              onChange={spread => set('Shadow', withShadow(current => ({...current, spread})))} />
            <label className="dz-effect-label">Color</label>
            <div className="dz-paint-row is-compact" data-paint-anchor="">
              <div className="dz-paint-field">
                <PaintSwatch paint={colorPaint!} open={!!colorOpen} label="Shadow color" onClick={row => setColorOpen(value => (value ? null : {row, anchor: besidePanel(row)}))} />
                <HexField value={toHex(shadow.color)} label="Shadow color" onCommit={text => {
                  const parsed = parseHex(text);
                  if (parsed) set('Shadow color', withShadow(current => ({...current, color: {...parsed.color, a: parsed.alpha ?? current.color.a}})));
                }} />
              </div>
              <NumberField aria-label="Shadow opacity" value={percent(shadow.color.a)} min={0} max={100} precision={0} suffix="%" className="dz-paint-opacity" {...scrub('Shadow color')}
                onChange={value => set('Shadow color', withShadow(current => ({...current, color: {...current.color, a: value / 100}})))} />
            </div>
          </>
        )}
      </div>
      {effect.type === 'DROP_SHADOW' && (
        <div className="dz-effect-footer">
          <Checkbox checked={!!effect.showShadowBehindNode} onChange={value => set('Shadow', withShadow(current => ({...current, showShadowBehindNode: value})))}>
            Show behind transparent areas
          </Checkbox>
        </div>
      )}
      {colorOpen && colorPaint && (
        <PaintPicker anchor={colorOpen.anchor} trigger={colorOpen.row} onClose={() => setColorOpen(null)} paint={colorPaint} label="Shadow color" committer={committer} kinds="solid"
          write={paint => write(withShadow(current => (paint.type === 'SOLID' ? {...current, color: {...paint.color, a: paint.opacity}} : current)))} />
      )}
    </FloatingPanel>
  );
}
