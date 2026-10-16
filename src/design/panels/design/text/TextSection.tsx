import '../../../styles/text.css';
import {memo, useCallback, useMemo, useRef, useState, useSyncExternalStore} from 'react';
import type {ListType, Style, StyleId, TextCase, TextDecoration, TextProps, TextStyle} from '../../../../../shared/design/types';
import {MIXED} from '../../../../../shared/design/text-edit';
import {groupStyles, styleDisplayName, type StyleGroup} from '../../../../../shared/design/styles';
import {layoutText} from '../../../../../shared/design/text-layout';
import {applyTextOp, createTextStyle, replaceFontFamily, type TextOp} from '../../../engine/commands/text';
import {nearestWeight} from '../../../engine/fonts';
import type {Gesture} from '../../../engine/store';
import {activeTextEdit, subscribeTextEditing, textEditingSnapshot} from '../../../engine/text-editor/registry';
import {normalizeLink} from '../../../engine/text-editor/style-ops';
import {useDesignStore} from '../../../engine/useDesignStore';
import {useEditorServices} from '../../../editor/services';
import {ComponentPropertyBindButton} from '../components/ComponentPropertyBindButton';
import {Button, IconButton} from '../../../ui/Button';
import {faceName, faceOptions} from '../../../ui/font-rows';
import {FontPicker} from '../../../ui/FontPicker';
import {
  IconChevronDown, IconDetachStyle, IconLetterSpacing, IconLineHeight, IconList, IconListNumbered, IconMinus, IconParagraphIndent, IconParagraphSpacing, IconPlus, IconSliders, IconStrikethrough,
  IconStyles, IconTextAlignBottom, IconTextAlignCenter, IconTextAlignJustify, IconTextAlignLeft, IconTextAlignMiddle, IconTextAlignRight, IconTextAlignTop,
  IconUnderline, IconWarning,
} from '../../../ui/icons';
import {useMenuTrigger} from '../../../ui/Menu';
import type {MenuItem} from '../../../ui/menu-model';
import {NumberField} from '../../../ui/NumberField';
import {PanelSection} from '../../../ui/PanelSection';
import {Popover} from '../../../ui/Popover';
import {Select} from '../../../ui/Select';
import {SegmentedControl, type SegmentOption} from '../../../ui/Tabs';
import {TextInput} from '../../../ui/TextInput';
import type {SectionProps} from '../sections';
import {sameSectionProps} from '../shared/edit';
import {offsetToPanelEdge} from '../shared/fields';
import {textPanelValues, type Mixed, type TextPanelValues} from './text-values';
import {UnitField} from './UnitField';
import {VariableSlot} from '../shared/bindable';
import {useVariableBinding} from '../../variables/VariableBindButton';

// "Text" in the design panel, laid out as Figma UI3's Typography: font, face and size, line height and letter
// spacing, alignment, and behind "Text settings" the decoration, case, list, paragraph spacing and indent, and
// link. The box's resizing sits in "Layout" beside W and H, as UI3 has it (TextResize.tsx). While a text is edited the values and the edits follow the editor's
// selection (a caret: what is typed next); otherwise they cover the selected texts whole. A text
// style in use shows on top with "Detach"; a font this computer cannot draw shows a warning
// with "Replace font".

const SIZE_PRESETS = [8, 10, 11, 12, 13, 14, 15, 16, 18, 20, 24, 28, 32, 36, 40, 48, 64, 72, 96, 128];
const FONT_WAIT_MS = 1500;

const ALIGN_H: SegmentOption<TextProps['textAlignHorizontal']>[] = [
  {value: 'LEFT', label: 'Align left', icon: <IconTextAlignLeft />},
  {value: 'CENTER', label: 'Align center', icon: <IconTextAlignCenter />},
  {value: 'RIGHT', label: 'Align right', icon: <IconTextAlignRight />},
  {value: 'JUSTIFIED', label: 'Justified', icon: <IconTextAlignJustify />},
];
const ALIGN_V: SegmentOption<TextProps['textAlignVertical']>[] = [
  {value: 'TOP', label: 'Align top', icon: <IconTextAlignTop />},
  {value: 'CENTER', label: 'Align middle', icon: <IconTextAlignMiddle />},
  {value: 'BOTTOM', label: 'Align bottom', icon: <IconTextAlignBottom />},
];
const DECORATION: SegmentOption<TextDecoration>[] = [
  {value: 'NONE', label: 'None', icon: <IconMinus />},
  {value: 'UNDERLINE', label: 'Underline', icon: <IconUnderline />},
  {value: 'STRIKETHROUGH', label: 'Strikethrough', icon: <IconStrikethrough />},
];
const CASES: SegmentOption<TextCase>[] = [
  {value: 'ORIGINAL', label: 'Original case', icon: <IconMinus />},
  {value: 'UPPER', label: 'Uppercase', icon: <span className="dz-case-glyph">AA</span>},
  {value: 'LOWER', label: 'Lowercase', icon: <span className="dz-case-glyph">aa</span>},
  {value: 'TITLE', label: 'Title case', icon: <span className="dz-case-glyph">Aa</span>},
  // Lower-case letters drawn as smaller capitals (the renderer, SVG and code export already know it).
  {value: 'SMALL_CAPS', label: 'Small caps', icon: <span className="dz-case-glyph is-small-caps">A<small>A</small></span>},
];
const LISTS: SegmentOption<ListType>[] = [
  {value: 'NONE', label: 'No list', icon: <IconMinus />},
  {value: 'UNORDERED', label: 'Bulleted list', icon: <IconList />},
  {value: 'ORDERED', label: 'Numbered list', icon: <IconListNumbered />},
];

/** Popovers of the section open beside the panel, level with the section, as Figma's do. */
const sectionOf = (element: Element): Element => element.closest('.dz-section') ?? element;

const fixed = <T,>(value: Mixed<T> | undefined): T | null => (value === undefined || value === MIXED ? null : value);
const wait = (ms: number) => new Promise<void>(resolve => setTimeout(resolve, ms));

export const TextSection = memo(function TextSection({ids, nodes}: SectionProps) {
  const {store, fonts} = useEditorServices();
  const editing = useSyncExternalStore(useCallback(listener => subscribeTextEditing(store, listener), [store]), () => textEditingSnapshot(store));
  const styles = useDesignStore(state => state.doc.styles, Object.is, {slice: 'doc', store});
  const values = useMemo(() => textPanelValues(nodes, editing), [nodes, editing]);
  const [picker, setPicker] = useState<{anchor: Element; replace?: string} | null>(null);
  const [settings, setSettings] = useState<Element | null>(null);
  const [creating, setCreating] = useState<Element | null>(null);
  const gesture = useRef<Gesture | null>(null);
  const families = useMemo(() => fonts.families(), [fonts, picker]); // eslint-disable-line react-hooks/exhaustive-deps
  const familyInfo = useCallback((family: string) => families.find(info => info.family === family), [families]);
  const textIds = values?.ids ?? ids;
  const content = useVariableBinding('characters', {ids: textIds});

  const apply = useCallback((op: TextOp, label: string) => {
    if (gesture.current?.active) applyTextOp(store, op, label, {ids: textIds, gesture: gesture.current});
    else applyTextOp(store, op, label, {ids: textIds});
  }, [store, textIds]);
  const scrubStart = useCallback((label: string) => {
    gesture.current = store.gesture(label);
  }, [store]);
  const scrubEnd = useCallback((cancelled: boolean) => {
    const current = gesture.current;
    gesture.current = null;
    if (!current?.active) return;
    if (cancelled) current.cancel();
    else current.commit();
  }, [store]); // eslint-disable-line react-hooks/exhaustive-deps

  /** Loads a face before a change that needs it, so auto-resizing text is measured with it. */
  const withFace = useCallback(async (family: string, weight: number, italic: boolean) => {
    await Promise.race([fonts.ensure({family, weight, italic, size: 16}), wait(FONT_WAIT_MS)]);
  }, [fonts]);

  const pickFamily = async (family: string) => {
    const replace = picker?.replace;
    setPicker(null);
    const info = familyInfo(family);
    const weights = info?.weights.length ? info.weights : [400];
    const current = fixed(values?.fontWeight) ?? 400;
    await withFace(family, nearestWeight(weights, current), values?.italic === true && !!info?.italic);
    if (replace) replaceFontFamily(store, textIds, replace, family);
    else apply({kind: 'style', change: style => ({fontFamily: family, fontWeight: nearestWeight(weights, style.fontWeight), italic: style.italic && !!info?.italic})}, 'Font');
    activeTextEdit(store)?.focus();
  };

  if (!values) return null;
  const family = fixed(values.fontFamily);
  const info = family ? familyInfo(family) : undefined;
  const known = new Set(families.map(each => each.family));
  const missing = values.families.filter(name => !known.has(name));
  const weight = fixed(values.fontWeight), italic = fixed(values.italic);
  const faces = faceOptions(info, weight !== null && italic !== null ? {weight, italic} : undefined);
  const faceValue = weight !== null && italic !== null ? `${weight}${italic ? 'i' : ''}` : null;
  const fontSize = fixed(values.fontSize);
  const autoPixels = (() => {
    const node = nodes.find(each => each.id === values.ids[0]);
    if (!node?.text || values.lineHeight === MIXED || values.lineHeight.unit !== 'AUTO') return null;
    const probe = {width: 0, height: 0, fills: node.fills, text: {...node.text, characters: '', runs: [], style: {...node.text.style, fontSize: fontSize ?? node.text.style.fontSize}}};
    return layoutText(probe, store.measurer, null).height || null;
  })();
  const styleId = fixed(values.textStyleId);
  const style = styleId ? styles[styleId] : undefined;

  return (
    <PanelSection title="Text" className="dz-text-section" actions={
      <>
        {/* A text inside a main component: its content can drive a TEXT property (nothing elsewhere). */}
        {values.ids.length === 1 && <ComponentPropertyBindButton nodeId={values.ids[0]} field="characters" />}
        {/* A string (or number) variable as the text itself, as Figma's “Apply variable” in the Text section. */}
        {content.button}
        <StyleMenu styles={styles} current={values.textStyleId} onApply={id => apply({kind: 'textStyle', styleId: id}, 'Text style')}
          onDetach={() => apply({kind: 'textStyle', styleId: null}, 'Detach style')} onCreate={setCreating} />
      </>
    }>
      {style && (
        <div className="dz-text-style-row">
          <span className="dz-text-style-chip" title={style.description || undefined}>
            <span className="dz-text-style-icon" aria-hidden="true"><IconStyles size={12} /></span>
            <span className="dz-text-style-name">{styleDisplayName(style)}</span>
            {style.text && <span className="dz-text-style-meta">{style.text.fontSize}</span>}
          </span>
          <IconButton label="Detach style" onClick={() => apply({kind: 'textStyle', styleId: null}, 'Detach style')}><IconDetachStyle /></IconButton>
        </div>
      )}
      {missing.map(name => (
        <div key={name} className="dz-text-missing" role="status">
          <span className="dz-text-missing-icon" aria-hidden="true"><IconWarning /></span>
          <span className="dz-text-missing-text" title="The text is drawn with a similar font until it is replaced">Missing font <b>{name}</b></span>
          <Button size={24} variant="ghost" onClick={event => setPicker({anchor: event.currentTarget, replace: name})}>Replace font</Button>
        </div>
      ))}
      {content.chip && <div className="dz-text-variable-row">{content.chip}</div>}
      <VariableSlot field="fontFamily" ids={textIds}>
        <button type="button" className={`dz-select is-24 is-field dz-text-family ${missing.includes(family ?? '') ? 'is-missing' : ''}`.trim()} aria-label="Font" aria-haspopup="dialog"
          aria-expanded={!!picker && !picker.replace} onClick={event => setPicker({anchor: event.currentTarget})}>
          <span className={`dz-select-value ${family ? '' : 'is-placeholder'}`}>{family ?? 'Mixed'}</span>
          <span className="dz-select-chevron"><IconChevronDown size={12} /></span>
        </button>
      </VariableSlot>
      <div className="dz-text-row">
        <VariableSlot field="fontWeight" ids={textIds}>
          <Select aria-label="Style" value={faceValue} mixed={faceValue === null} options={faces}
            onChange={async value => {
              const nextWeight = parseInt(value, 10), nextItalic = value.endsWith('i');
              if (family) await withFace(family, nextWeight, nextItalic);
              apply({kind: 'style', change: {fontWeight: nextWeight, italic: nextItalic}}, 'Style');
              activeTextEdit(store)?.focus();
            }} />
        </VariableSlot>
        <VariableSlot field="fontSize" ids={textIds}>
          <SizeField value={values.fontSize} onChange={(value, source) => apply({kind: 'style', change: {fontSize: value}}, source === 'scrub' ? 'Font size' : 'Font size')}
            onScrubStart={() => scrubStart('Font size')} onScrubEnd={scrubEnd} />
        </VariableSlot>
      </div>
      <div className="dz-text-row">
        <VariableSlot field="lineHeight" ids={textIds}>
          <UnitField kind="lineHeight" value={values.lineHeight} autoPixels={autoPixels} icon={<IconLineHeight />} aria-label="Line height" title="Line height"
            onChange={value => apply({kind: 'style', change: {lineHeight: value as TextStyle['lineHeight']}}, 'Line height')}
            onScrubStart={() => scrubStart('Line height')} onScrubEnd={scrubEnd} />
        </VariableSlot>
        <VariableSlot field="letterSpacing" ids={textIds}>
          <UnitField kind="letterSpacing" value={values.letterSpacing} icon={<IconLetterSpacing />} aria-label="Letter spacing" title="Letter spacing"
            onChange={value => apply({kind: 'style', change: {letterSpacing: value as TextStyle['letterSpacing']}}, 'Letter spacing')}
            onScrubStart={() => scrubStart('Letter spacing')} onScrubEnd={scrubEnd} />
        </VariableSlot>
      </div>
      <div className="dz-text-row is-align">
        <SegmentedControl aria-label="Horizontal alignment" options={ALIGN_H} value={fixed(values.textAlignHorizontal)}
          onChange={value => apply({kind: 'props', props: {textAlignHorizontal: value}}, 'Text alignment')} />
        <SegmentedControl aria-label="Vertical alignment" options={ALIGN_V} value={fixed(values.textAlignVertical)}
          onChange={value => apply({kind: 'props', props: {textAlignVertical: value}}, 'Text alignment')} />
        <IconButton label="Text settings" pressed={!!settings} onClick={event => setSettings(settings ? null : sectionOf(event.currentTarget))}><IconSliders /></IconButton>
      </div>
      {settings && <TextSettings anchor={settings} values={values} onClose={() => setSettings(null)} apply={apply} />}
      {picker && (
        <FontPicker anchor={picker.anchor} offset={offsetToPanelEdge(picker.anchor)} value={picker.replace ? null : family} fonts={fonts} onClose={() => setPicker(null)} onPick={family => void pickFamily(family)}
          aria-label={picker.replace ? `Replace font "${picker.replace}"` : 'Fonts'} />
      )}
      {creating && (
        <CreateStyle anchor={creating} onClose={() => setCreating(null)} onCreate={name => {
          setCreating(null);
          const look = styleOf(values, nodes.find(node => node.id === values.ids[0])?.text?.style);
          if (look) createTextStyle(store, name, look, textIds);
        }} suggested={`Text ${Object.values(styles).filter(each => each.type === 'TEXT').length + 1}`} />
      )}
    </PanelSection>
  );
}, sameTextSectionProps);

/** The section reads a node's text, fills and text style only: moving or resizing a text layer hands
 *  the host fresh `nodes` on every frame of the drag, and none of them should re-render (or re-lay out) this. */
function sameTextSectionProps(a: SectionProps, b: SectionProps): boolean {
  if (a.nodes === b.nodes) return sameSectionProps(a, b);
  return sameSectionProps(a, b) && a.nodes.length === b.nodes.length && a.nodes.every((node, i) => {
    const other = b.nodes[i];
    return node === other || (node.id === other.id && node.type === other.type && node.text === other.text && node.fills === other.fills && node.textStyleId === other.textStyleId);
  });
}

/** The selection's look as a full text style (mixed fields take the text's own). */
function styleOf(values: TextPanelValues, base: TextStyle | undefined): TextStyle | null {
  if (!base) return null;
  const pick = <K extends keyof TextStyle>(key: K): TextStyle[K] => {
    const value = values[key as keyof TextPanelValues] as Mixed<TextStyle[K]>;
    return value === MIXED || value === undefined ? base[key] : value;
  };
  return {
    fontFamily: pick('fontFamily'), fontWeight: pick('fontWeight'), italic: pick('italic'), fontSize: pick('fontSize'),
    lineHeight: pick('lineHeight'), letterSpacing: pick('letterSpacing'), textDecoration: pick('textDecoration'), textCase: pick('textCase'),
  };
}

// ── Size with presets ──────────────────────────────────────────────────────────────────────────

function SizeField({value, onChange, onScrubStart, onScrubEnd}: {value: Mixed<number>; onChange: (value: number, source: string) => void; onScrubStart: () => void; onScrubEnd: (cancelled: boolean) => void}) {
  const current = value === MIXED ? null : value;
  const items = useCallback((): MenuItem[] => SIZE_PRESETS.map(size => ({id: String(size), label: String(size), checked: size === current, radio: true, onSelect: () => onChange(size, 'input')})), [current, onChange]);
  const menu = useMenuTrigger({items, label: 'Font sizes', placement: 'bottom-end', minWidth: 72, alignItemId: current !== null && SIZE_PRESETS.includes(current) ? String(current) : undefined, alignInset: 8});
  return (
    <div className="dz-text-size">
      <NumberField value={value} aria-label="Font size" title="Font size" min={0.5} max={10000} precision={2}
        onChange={onChange} onScrubStart={onScrubStart} onScrubEnd={onScrubEnd} />
      <button type="button" className="dz-text-size-presets" aria-label="Font sizes" {...menu.triggerProps}><IconChevronDown size={12} /></button>
      {menu.element}
    </div>
  );
}

// ── Text styles ────────────────────────────────────────────────────────────────────────────────

function StyleMenu({styles, current, onApply, onDetach, onCreate}: {styles: Record<StyleId, Style>; current: Mixed<StyleId | null>; onApply: (id: StyleId) => void; onDetach: () => void; onCreate: (anchor: Element) => void}) {
  const trigger = useRef<HTMLElement | null>(null);
  const items = useCallback((): MenuItem[] => {
    const text = Object.values(styles).filter(style => style.type === 'TEXT');
    const out: MenuItem[] = [{type: 'label', label: 'Text styles'}];
    const walk = (group: StyleGroup, depth: string) => {
      for (const style of group.styles) {
        const look = style.text;
        out.push({id: style.id, label: depth + styleDisplayName(style), description: look ? `${look.fontFamily} · ${faceName(look.fontWeight, look.italic)} · ${look.fontSize}` : undefined,
          checked: current === style.id, radio: true, onSelect: () => onApply(style.id)});
      }
      for (const child of group.groups) walk(child, `${depth}${child.name} / `);
    };
    if (text.length) walk(groupStyles(text), '');
    else out.push({id: 'none', label: 'No text styles yet', disabled: true, onSelect: () => {}});
    out.push({type: 'separator'});
    out.push({id: 'create', label: 'Create style…', icon: <IconPlus />, onSelect: () => trigger.current && onCreate(sectionOf(trigger.current))});
    if (current !== null) out.push({id: 'detach', label: 'Detach style', onSelect: onDetach});
    return out;
  }, [styles, current, onApply, onDetach, onCreate]);
  const menu = useMenuTrigger({items, label: 'Text styles', placement: 'bottom-end', minWidth: 200});
  return (
    <>
      <IconButton label="Text styles" {...menu.triggerProps} ref={element => {
        trigger.current = element;
        menu.triggerProps.ref(element);
      }}><IconStyles /></IconButton>
      {menu.element}
    </>
  );
}

function CreateStyle({anchor, suggested, onCreate, onClose}: {anchor: Element; suggested: string; onCreate: (name: string) => void; onClose: () => void}) {
  const [name, setName] = useState(suggested);
  return (
    <Popover anchor={anchor} onClose={onClose} placement="left-start" aria-label="New text style" className="dz-text-popover">
      <form className="dz-text-create" onSubmit={event => {
        event.preventDefault();
        if (name.trim()) onCreate(name);
      }}>
        <h3 className="dz-text-popover-title">New text style</h3>
        <TextInput value={name} onChange={setName} aria-label="Style name" placeholder="Style name" selectOnFocus autoFocus
          onKeyDown={event => {
            if (event.key !== 'Enter' || event.nativeEvent.isComposing) return;
            event.preventDefault();
            if (name.trim()) onCreate(name);
          }} />
        <p className="dz-text-hint">A "/" in the name creates a group: "Headings/Large".</p>
        <div className="dz-text-create-actions">
          <Button size={24} variant="ghost" onClick={onClose}>Cancel</Button>
          <Button size={24} variant="primary" type="submit" disabled={!name.trim()}>Create</Button>
        </div>
      </form>
    </Popover>
  );
}

// ── "Text settings" ─────────────────────────────────────────────────────────────────────────

function TextSettings({anchor, values, onClose, apply}: {anchor: Element; values: TextPanelValues; onClose: () => void; apply: (op: TextOp, label: string) => void}) {
  const link = values.hyperlink;
  const url = link && link !== MIXED && link.type === 'URL' ? link.url : '';
  const [draft, setDraft] = useState(url);
  const [error, setError] = useState<string | null>(null);
  const editing = values.editing;
  const textCase = fixed(values.textCase);
  const commitLink = (value: string) => {
    if (!value.trim()) {
      setError(null);
      apply({kind: 'link', link: null}, 'Link');
      return;
    }
    const normalized = normalizeLink(value);
    if (!normalized) {
      setError('Enter a link that starts with http:// or https://');
      return;
    }
    setError(null);
    setDraft(normalized);
    apply({kind: 'link', link: {type: 'URL', url: normalized}}, 'Link');
  };
  return (
    <Popover anchor={anchor} onClose={onClose} placement="left-start" aria-label="Text settings" className="dz-text-popover">
      <div className="dz-text-settings">
        <h3 className="dz-text-popover-title">Text settings</h3>
        <div className="dz-text-setting">
          <span className="dz-text-setting-label">Decoration</span>
          <SegmentedControl aria-label="Decoration" options={DECORATION} value={fixed(values.textDecoration)} fill
            onChange={value => apply({kind: 'style', change: {textDecoration: value}}, 'Text decoration')} />
        </div>
        <div className="dz-text-setting">
          <span className="dz-text-setting-label">Case</span>
          <SegmentedControl aria-label="Case" options={CASES} value={textCase} fill
            onChange={value => apply({kind: 'style', change: {textCase: value}}, 'Case')} />
        </div>
        <div className="dz-text-setting">
          <span className="dz-text-setting-label">List</span>
          <SegmentedControl aria-label="List" options={LISTS} value={fixed(values.listType)} fill
            onChange={value => apply({kind: 'list', type: value}, 'List')} />
        </div>
        <div className="dz-text-setting">
          <span className="dz-text-setting-label">Paragraph spacing</span>
          <VariableSlot field="paragraphSpacing" ids={values.ids}>
            <NumberField value={values.paragraphSpacing} icon={<IconParagraphSpacing />} aria-label="Paragraph spacing" title="Paragraph spacing" min={0} max={10000} precision={2}
              onChange={value => apply({kind: 'props', props: {paragraphSpacing: value}}, 'Paragraph spacing')} />
          </VariableSlot>
        </div>
        <div className="dz-text-setting">
          <span className="dz-text-setting-label">Paragraph indent</span>
          <VariableSlot field="paragraphIndent" ids={values.ids}>
            <NumberField value={values.paragraphIndent} icon={<IconParagraphIndent />} aria-label="Paragraph indent" title="First-line paragraph indent" min={0} max={10000} precision={2}
              onChange={value => apply({kind: 'props', props: {paragraphIndent: value}}, 'Paragraph indent')} />
          </VariableSlot>
        </div>
        <div className="dz-text-setting">
          <span className="dz-text-setting-label">Link</span>
          <TextInput value={draft} onChange={value => {
            setDraft(value);
            if (error) setError(null);
          }} onCommit={commitLink} aria-label="Link" placeholder={link === MIXED ? 'Mixed' : 'https://…'} aria-invalid={!!error || undefined}
            className={error ? 'is-invalid' : undefined} />
        </div>
        {error ? <p className="dz-text-error" role="alert">{error}</p>
          : <p className="dz-text-hint">{editing ? 'The link is applied to the selected words.' : 'The link is applied to the whole text; to link only a part, select it in the text.'}</p>}
      </div>
    </Popover>
  );
}

