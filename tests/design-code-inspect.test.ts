import {test} from 'node:test';
import assert from 'node:assert/strict';
import type {DesignDocument, SceneNode} from '../shared/design/types';
import type {TextMeasurer} from '../shared/design/text-layout';
import {templateById} from '../shared/design/templates';
import {toReact, toVue} from '../shared/design/codegen/react';
import {collectTokens, suggestTokens} from '../shared/design/codegen/tokens';
import {boxModel, cssList, detectAssets, layoutRows, propsOfUsage, stylesUsed, usageFor} from '../src/design/panels/code/inspect';
import {DEFAULT_SETTINGS, formatOf, readSettings, writeSettings} from '../src/design/panels/code/settings';

// The "Code" tab's reads of the design (src/design/panels/code/inspect.ts) on the "UI kit" template: the box model, the styles
// and variables in use, the assets, a component's playground, the CSS as a list; and the tab's remembered settings.

const measurer: TextMeasurer = {width: (text, font) => text.length * font.size * 0.56, metrics: font => ({ascent: font.size * 0.8, descent: font.size * 0.2})};
let seq = 0;
const doc: DesignDocument = templateById('ui-kit')!.build({measurer, newId: () => `t${(seq++).toString(36)}`});
const find = (type: SceneNode['type'], name: string, where: (node: SceneNode) => boolean = () => true) =>
  Object.values(doc.nodes).find(node => node.type === type && node.name === name && where(node))!;
const parentName = (node: SceneNode) => (node.parentId ? doc.nodes[node.parentId]?.name : undefined);

const buttons = find('COMPONENT_SET', 'Button');
const card = find('COMPONENT', 'Card');
const later = find('INSTANCE', 'Button', node => parentName(node) === 'Actions' && JSON.stringify(node).includes('Later'));

test('auto layout reads in the design panel\'s words, and its alignment copies both axes', () => {
  const rows = layoutRows(card)!;
  assert.deepEqual(rows.map(row => row.label), ['Direction', 'Gap', 'Padding', 'Alignment']);
  assert.match(rows[3].copy, /^justify-content: [a-z-]+; align-items: [a-z-]+;$/);
});

test('the box model: size and how it is set, padding, stroke, radius, whether the layer is in its parent\'s flow', () => {
  const box = boxModel(doc, card);
  assert.deepEqual(box.padding, [24, 24, 24, 24]);
  assert.deepEqual(box.border, [1, 1, 1, 1]);
  assert.equal(box.radius, '16px');
  assert.deepEqual(box.sizing, {horizontal: 'FIXED', vertical: 'HUG'});
  assert.equal(box.inFlow, true);
  const fill = boxModel(doc, later);
  assert.equal(fill.sizing.horizontal, 'FILL', 'a button stretched in its row');
  assert.equal(fill.padding?.every(side => side > 0), true);
});

test('styles and variables: tokens first-hand, a layer\'s shadows as one box-shadow, the variant set\'s own frame left out', () => {
  const tokens = suggestTokens(collectTokens(doc));
  const entries = stylesUsed(doc, [card.id], tokens);
  const shadow = entries.find(entry => entry.kind === 'effect' && entry.token === '--shadow-medium');
  assert.ok(shadow, 'the card\'s effect style');
  assert.equal(shadow.value, '0 2px 4px rgba(15, 17, 21, 0.04), 0 8px 16px rgba(15, 17, 21, 0.08)', 'both shadows of the style in one value');
  assert.equal(shadow.shadow, shadow.value, 'drawn as a preview');
  assert.equal(entries.filter(entry => entry.token === '--shadow-medium').length, 1);
  assert.ok(entries.some(entry => entry.kind === 'fill' && entry.token === '--color-neutral-0' && entry.copy === 'var(--color-neutral-0)'));
  assert.ok(entries.some(entry => entry.kind === 'text' && entry.token === '--color-status-warning'), 'a status colour named in English');
  const set = stylesUsed(doc, [buttons.id], tokens);
  assert.ok(!set.some(entry => entry.value === '#9747FF'), 'the dashed purple border of a variant set is the editor\'s');
  const rgb = stylesUsed(doc, [card.id], tokens, {unit: 'px', color: 'rgb', remBase: 16});
  assert.ok(rgb.some(entry => entry.token === '--color-neutral-0' && entry.value === 'rgb(255, 255, 255)'), 'the colour format applies');
});

test('assets: an icon drawn the same in every variant is one file named after its component; a card lists each picture once', () => {
  const set = detectAssets(doc, [buttons.id], {measurer});
  assert.deepEqual(set.map(asset => [asset.kind, asset.fileName, asset.count, asset.width]), [['icon', 'button-icon.svg', 12, 16]]);
  assert.equal(set[0].monochrome, true);
  assert.match(set[0].svg!, /^<svg xmlns="http:\/\/www\.w3\.org\/2000\/svg" width="16" height="16" viewBox="0 0 16 16" fill="none">.*currentColor.*<\/svg>\n$/s, 'the file draws in currentColor, as the code');
  assert.ok(!/#[0-9A-F]{6}/i.test(set[0].svg!), 'whichever variant it came from');
  const form = find('FRAME', 'Example: sign in');
  const icons = detectAssets(doc, [form.id], {measurer});
  assert.deepEqual(icons.map(asset => asset.fileName), ['field-icon.svg', 'check.svg']);
  assert.equal(detectAssets(doc, [buttons.id], {measurer, limit: 0}).length, 0);
});

test('the playground reads an instance\'s props from its usage and writes the usage back, defaults left out', () => {
  const info = toReact(doc, [buttons.id], {measurer}).entries[0];
  const usage = toReact(doc, [later.id], {measurer}).entries[0].usage;
  assert.equal(usage, '<Button variant="outline" showIcon={false}>Later</Button>');
  const values = propsOfUsage(info, usage);
  assert.deepEqual(values, {variant: "'outline'", disabled: false, children: 'Later', showIcon: false});
  assert.equal(usageFor(info, values), usage, 'a round trip');
  assert.equal(usageFor(info, {...values, variant: "'primary'", showIcon: true, disabled: true}), '<Button disabled>Later</Button>');
  assert.equal(usageFor(info, {...values, children: 'Two\nwords {x}'}), '<Button variant="outline" showIcon={false}>Two<br />{"words {x}"}</Button>', 'lines and braces stay JSX');
  assert.equal(usageFor(info, {...values, children: ''}), '<Button variant="outline" showIcon={false} />');
  assert.deepEqual(propsOfUsage(info, undefined), {variant: "'primary'", disabled: false, children: '', showIcon: true}, 'the defaults');
});

test('the playground speaks Vue for a Vue component: bindings with a colon, the label as the default slot', () => {
  const info = toVue(doc, [buttons.id], {measurer}).entries[0];
  const usage = toVue(doc, [later.id], {measurer}).entries[0].usage;
  assert.equal(usage, '<Button variant="outline" :showIcon="false">Later</Button>');
  assert.equal(info.props.find(prop => prop.native && prop.kind === 'text')?.name, 'default', 'the label is the default slot');
  const values = propsOfUsage(info, usage);
  assert.deepEqual(values, {variant: "'outline'", disabled: false, default: 'Later', showIcon: false});
  assert.equal(usageFor(info, values, 'vue'), usage, 'a round trip');
  assert.equal(usageFor(info, {...values, variant: "'primary'", showIcon: true, disabled: true}, 'vue'), '<Button disabled>Later</Button>');
  assert.equal(usageFor(info, {...values, default: 'Two\nwords {x} <b>'}, 'vue'), '<Button variant="outline" :showIcon="false">Two<br />words {x} &lt;b></Button>', 'lines and markup stay text');
});

test('the CSS as a list: grouped declarations, each copying `prop: value;`, in the chosen units', () => {
  const groups = cssList(doc, card.id);
  assert.deepEqual(groups.map(group => group.title), ['Auto layout', 'Size', 'Inside auto layout', 'Appearance']);
  const layout = groups[0].rows.map(row => row.copy);
  assert.ok(layout.includes('padding: 24px;'));
  assert.ok(layout.includes('gap: 20px;'));
  const rem = cssList(doc, card.id, {format: {unit: 'rem', color: 'hex', remBase: 16}});
  assert.ok(rem[0].rows.some(row => row.copy === 'padding: 1.5rem;'), 'px → rem');
  const look = rem.find(group => group.title === 'Appearance')!.rows;
  assert.ok(look.some(row => row.label === 'border-radius' && row.value === '1rem'), 'a radius scales');
  assert.ok(look.some(row => row.label === 'box-shadow' && row.value.startsWith('inset 0 0 0 1px')), 'a hairline stays in pixels');
});

test('settings: stored per browser, each field checked, the language kept from before the settings existed', () => {
  const store = new Map<string, string>();
  const storage = {getItem: (key: string) => store.get(key) ?? null, setItem: (key: string, value: string) => void store.set(key, value)};
  assert.deepEqual(readSettings(storage), DEFAULT_SETTINGS);
  assert.deepEqual(readSettings(null), DEFAULT_SETTINGS, 'no storage');
  store.set('morfa-design-code-mode', 'tailwind');
  assert.equal(readSettings(storage).language, 'tailwind', 'the old key');
  writeSettings({...DEFAULT_SETTINGS, language: 'css', unit: 'rem', color: 'hsl', suggest: false, view: 'list'}, storage);
  assert.deepEqual(readSettings(storage), {language: 'css', unit: 'rem', color: 'hsl', suggest: false, view: 'list'});
  store.set('morfa-design-code-settings', JSON.stringify({language: 'php', unit: 'em', color: 'lab', suggest: 'yes', view: 'grid'}));
  assert.deepEqual(readSettings(storage), DEFAULT_SETTINGS, 'bad values fall back to the defaults');
  store.set('morfa-design-code-settings', '{');
  assert.deepEqual(readSettings({getItem: () => '{'}), DEFAULT_SETTINGS, 'broken JSON');
  assert.doesNotThrow(() => writeSettings(DEFAULT_SETTINGS, {setItem: () => { throw new Error('quota'); }}));
  assert.deepEqual(formatOf({...DEFAULT_SETTINGS, unit: 'rem', color: 'rgb'}), {unit: 'rem', remBase: 16, color: 'rgb'});
});
