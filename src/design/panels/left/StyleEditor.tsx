import {useEffect, useState, type CSSProperties} from 'react';
import type {Effect, LayoutGrid, Paint, RGBA, Style, TextStyle} from '../../../../shared/design/types';
import {updateStyleUpdates} from '../../../../shared/design/styles';
import type {DesignStore} from '../../engine/store';
import {useEditorServices} from '../../editor/services';
import {ColorSwatch} from '../../ui/ColorSwatch';
import {faceOptions} from '../../ui/font-rows';
import {FontPicker} from '../../ui/FontPicker';
import {IconChevronDown} from '../../ui/icons';
import {NumberField} from '../../ui/NumberField';
import {Popover} from '../../ui/Popover';
import {Select} from '../../ui/Select';
import {TextInput} from '../../ui/TextInput';
import {colorHex, paintBackground, parseHex} from './assets-model';

// The popover a style opens in the assets panel: its name and description, and the values it sets —
// solid colours (hex and opacity) for a colour style, family, weight, size and spacing for a text
// style. Gradients, pictures, effects and grids are listed read-only here. Every change rewrites the
// style's users in the same undo step (updateStyleUpdates); edits in quick succession merge into one.

const TYPE_LABELS = {FILL: 'Color style', TEXT: 'Text style', EFFECT: 'Effect style', GRID: 'Grid style'} as const;

export function saveStyle(store: DesignStore, next: Style, label = 'Edit style') {
  const {doc} = store.getState();
  const updates = updateStyleUpdates(doc, next);
  store.transact(label, tx => {
    tx.setStyle(next);
    for (const [id, patch] of updates) tx.update(id, patch);
  }, {coalesce: `style:${next.id}`});
}

function HexField({value, onCommit, label}: {value: string; onCommit: (color: RGBA) => void; label: string}) {
  const [draft, setDraft] = useState(value);
  useEffect(() => setDraft(value), [value]);
  const commit = (text: string) => {
    const color = parseHex(text);
    if (color) onCommit(color);
    else setDraft(value);
  };
  return <TextInput className="dz-style-hex" value={draft} onChange={setDraft} onCommit={commit} onCancel={() => setDraft(value)} aria-label={label} maxLength={9} />;
}

function PaintRow({paint, index, onChange}: {paint: Paint; index: number; onChange: (paint: Paint) => void}) {
  if (paint.type !== 'SOLID') {
    const label = paint.type === 'IMAGE' ? 'Image' : 'Gradient';
    const background = paintBackground([paint]);
    return (
      <div className="dz-style-field is-readonly">
        {background && <span className="dz-style-chip" style={{'--dz-paint': background} as CSSProperties} aria-hidden="true" />}
        <span className="dz-style-kind">{label}</span>
      </div>
    );
  }
  return (
    <div className="dz-style-field">
      <ColorSwatch color={paint.color} opacity={paint.opacity} size={16} aria-label={`Color ${colorHex(paint.color)}`} />
      <HexField value={colorHex(paint.color)} label={`Fill color ${index + 1}`}
        onCommit={color => onChange({...paint, color: {r: color.r, g: color.g, b: color.b}, opacity: color.a < 1 ? color.a : paint.opacity})} />
      <NumberField className="dz-style-opacity" aria-label="Opacity" value={Math.round(paint.opacity * 100)} suffix="%" min={0} max={100} precision={0}
        onChange={value => onChange({...paint, opacity: value / 100})} />
    </div>
  );
}

/** The same typography controls as the "Text" section: the font picker for the family and the family's
 *  own faces by name ("Semi Bold", "Bold Italic"), not a typed family and a bare weight number. */
function TextFields({text, onChange}: {text: TextStyle; onChange: (text: TextStyle) => void}) {
  const {fonts} = useEditorServices();
  const [picker, setPicker] = useState<Element | null>(null);
  const info = fonts.families().find(each => each.family === text.fontFamily);
  const faces = faceOptions(info, {weight: text.fontWeight, italic: text.italic});
  const line = text.lineHeight;
  return (
    <div className="dz-style-grid">
      <div className="dz-style-label is-wide"><span aria-hidden="true">Font</span>
        <button type="button" className="dz-select is-24 is-field" aria-label="Font" aria-haspopup="dialog" aria-expanded={!!picker}
          onClick={event => setPicker(picker ? null : event.currentTarget)}>
          <span className="dz-select-value">{text.fontFamily}</span>
          <span className="dz-select-chevron"><IconChevronDown size={12} /></span>
        </button>
      </div>
      {picker && <FontPicker anchor={picker} value={text.fontFamily} fonts={fonts} placement="right-start" aria-label="Style font"
        onPick={family => {
          setPicker(null);
          if (family !== text.fontFamily) onChange({...text, fontFamily: family});
        }} onClose={() => setPicker(null)} />}
      <div className="dz-style-label"><span aria-hidden="true">Style</span>
        <Select aria-label="Style" value={`${text.fontWeight}${text.italic ? 'i' : ''}`} options={faces}
          onChange={value => onChange({...text, fontWeight: parseInt(value, 10), italic: value.endsWith('i')})} />
      </div>
      <label className="dz-style-label">Size
        <NumberField aria-label="Size" value={text.fontSize} min={1} max={1000} precision={2} onChange={value => onChange({...text, fontSize: value})} />
      </label>
      <label className="dz-style-label">Line height
        <NumberField aria-label="Line height" value={line.unit === 'AUTO' ? null : line.value} placeholder="Auto" suffix={line.unit === 'PERCENT' ? '%' : ''} min={0} precision={2}
          onChange={value => onChange({...text, lineHeight: {unit: line.unit === 'PERCENT' ? 'PERCENT' : 'PIXELS', value}})} />
      </label>
      <label className="dz-style-label">Letter spacing
        <NumberField aria-label="Letter spacing" value={text.letterSpacing.value} suffix={text.letterSpacing.unit === 'PERCENT' ? '%' : ''} precision={2}
          onChange={value => onChange({...text, letterSpacing: {...text.letterSpacing, value}})} />
      </label>
    </div>
  );
}

const effectLabel = (effect: Effect) => {
  if (!('offset' in effect)) return `${effect.type === 'LAYER_BLUR' ? 'Layer blur' : 'Background blur'} · ${effect.radius}`;
  const kind = effect.type === 'DROP_SHADOW' ? 'Drop shadow' : 'Inner shadow';
  return `${kind} · ${effect.offset.x}, ${effect.offset.y} · blur ${effect.radius}`;
};

const gridLabel = (grid: LayoutGrid) => grid.pattern === 'GRID' ? `Grid · ${grid.sectionSize}` : `${grid.pattern === 'COLUMNS' ? 'Columns' : 'Rows'} · ${grid.count} · gutter ${grid.gutterSize}`;

export function StyleEditor({style, anchor, onClose}: {style: Style; anchor: Element; onClose: () => void}) {
  const {store} = useEditorServices();
  const [name, setName] = useState(style.name);
  const [description, setDescription] = useState(style.description);
  useEffect(() => setName(style.name), [style.name]);
  useEffect(() => setDescription(style.description), [style.description]);
  const save = (next: Style) => saveStyle(store, next);
  return (
    <Popover anchor={anchor} onClose={onClose} aria-label={TYPE_LABELS[style.type]} placement="right-start" className="dz-style-editor" layoutKey={style.type}>
      <div className="dz-style-editor-head">{TYPE_LABELS[style.type]}</div>
      {/* A shared library's style (docs/design-tool.md §Teams) is read-only here: it changes in the library's file. */}
      {style.remote && <p className="dz-style-remote-note">Library style: changed in its file, arrives here with an update.</p>}
      <fieldset disabled={!!style.remote} className="dz-readonly-fieldset">
      {/* Escape in a field reverts it and closes the popover, as in the design panel's pickers. */}
      <div className="dz-style-editor-body" onKeyDownCapture={event => {
        // Escape inside a picker opened from here (rendered elsewhere, reached through React's tree) closes that picker only.
        if (event.key === 'Escape' && event.currentTarget.contains(event.target as Node)) onClose();
      }}>
        <label className="dz-style-label is-wide">Name
          <TextInput value={name} onChange={setName} aria-label="Style name" onCancel={() => setName(style.name)}
            onCommit={value => value.trim() && value.trim() !== style.name && saveStyle(store, {...style, name: value.trim()}, 'Rename style')} />
        </label>
        <label className="dz-style-label is-wide">Description
          <TextInput value={description} onChange={setDescription} aria-label="Style description" placeholder="When to use it" onCancel={() => setDescription(style.description)}
            onCommit={value => value !== style.description && save({...style, description: value})} />
        </label>
        {style.type === 'FILL' && (
          <div className="dz-style-values">
            {[...(style.paints ?? [])].map((paint, index) => ({paint, index})).reverse().map(({paint, index}) => (
              <PaintRow key={index} paint={paint} index={index} onChange={next => save({...style, paints: (style.paints ?? []).map((each, i) => (i === index ? next : each))})} />
            ))}
          </div>
        )}
        {style.type === 'TEXT' && style.text && <TextFields text={style.text} onChange={text => save({...style, text})} />}
        {style.type === 'EFFECT' && (
          <div className="dz-style-values">
            {(style.effects ?? []).map((effect, index) => <div key={index} className="dz-style-field is-readonly"><span className="dz-style-kind">{effectLabel(effect)}</span></div>)}
          </div>
        )}
        {style.type === 'GRID' && (
          <div className="dz-style-values">
            {(style.grids ?? []).map((grid, index) => <div key={index} className="dz-style-field is-readonly"><span className="dz-style-kind">{gridLabel(grid)}</span></div>)}
          </div>
        )}
      </div>
      </fieldset>
    </Popover>
  );
}
