import {createDocument, createNode, defaultAutoLayout, defaultTextProps, solid} from '../../shared/design/defaults';
import type {DesignDocument, Effect, ImageAsset, NodeId, NodeType, SceneNode} from '../../shared/design/types';
import type {TextMeasurer} from '../../shared/design/text-layout';
import {normalizeDocument} from '../../shared/design/normalize';
import {createInstance} from '../../shared/design/components';
import {combineAsVariants} from '../../shared/design/variants';

// Big design files for the co-editing and save-path checks (docs/design-tool.md §Performance): the 20 000-layer page of
// tests/design-perf.test.ts and a product file the way teams make them (40 screens of ~300 layers, text-heavy, 60
// pictures, 300 instances of 20 components with variants, nested auto layout, shadows and blurs).
// The layer, page and text content below is Russian ON PURPOSE: scripts/bench/gen-file.ts reproduces `heavyPage` byte for byte,
// and the bytes are part of the sha256 and size of every standard file in fixtures/bench/manifest.json (they also double as
// Cyrillic text-handling data), so translating them would invalidate the manifest.

export const testMeasurer: TextMeasurer = {width: (text, font) => text.length * font.size * 0.5, metrics: font => ({ascent: font.size * 0.8, descent: font.size * 0.2})};

/** 40 screens × 10 sections × a group of 48 layers: 20 041 nodes, every layer inside a group (as tests/design-perf.test.ts). */
export function heavyPage(): DesignDocument {
  const doc = createDocument('page', 'Тяжёлая страница');
  let n = 0;
  const add = (type: NodeType, parentId: NodeId, props: Partial<SceneNode>) => {
    const id = `n${++n}`;
    doc.nodes[id] = createNode(type, {...props, id, parentId});
    doc.nodes[parentId].children!.push(id);
    return id;
  };
  const kinds: NodeType[] = ['RECTANGLE', 'TEXT', 'ELLIPSE', 'VECTOR', 'RECTANGLE', 'LINE'];
  for (let s = 0; s < 40; s++) {
    const screen = add('FRAME', 'page', {name: `Экран ${s + 1}`, x: (s % 8) * 1600, y: Math.floor(s / 8) * 2200, width: 1440, height: 2000});
    for (let k = 0; k < 10; k++) {
      const section = add('FRAME', screen, {name: `Секция ${k + 1}`, x: 0, y: k * 200, width: 1440, height: 200});
      const group = add('GROUP', section, {name: `Группа ${k + 1}`, x: 20, y: 20, width: 1400, height: 160});
      for (let i = 0; i < 48; i++) {
        const type = kinds[i % kinds.length];
        add(type, group, {x: 20 + (i % 12) * 110, y: 20 + Math.floor(i / 12) * 38, width: 100, height: type === 'LINE' ? 0 : 30, ...(type === 'TEXT' ? {text: defaultTextProps('Текст')} : {})});
      }
    }
  }
  return normalizeDocument(doc, new Set(Object.keys(doc.nodes)), {measurer: testMeasurer});
}

const PARAGRAPH = 'Мы собрали всё, что нужно команде: макеты, компоненты и прототипы живут в одном файле, а изменения видны всем сразу. Комментарии, версии и общие библиотеки помогают не терять договорённости.';
const shadow = (y: number, radius: number): Effect => ({type: 'DROP_SHADOW', color: {r: 0, g: 0, b: 0, a: 0.12}, offset: {x: 0, y}, radius, spread: 0, visible: true, blendMode: 'NORMAL'});
const blur = (radius: number): Effect => ({type: 'BACKGROUND_BLUR', radius, visible: true});

/**
 * A product file: a page of 20 component sets (two variants each: a card with a picture, a title, a text and a button),
 * and a page of 40 screens, each a vertical auto layout of a header, a hero with a picture, rows of cards (instances)
 * and text sections. `images` are the picture assets the screens use (refs `img1`…); without them the pictures are solid.
 */
export function productFile(images: Record<string, ImageAsset> = {}): DesignDocument {
  let doc = createDocument('screens', 'Экраны');
  const componentsPage = createNode('PAGE', {id: 'components', name: 'Компоненты'});
  doc = {...doc, pages: ['screens', 'components'], nodes: {...doc.nodes, components: componentsPage}, images: {...images}};
  const refs = Object.keys(images);
  const nodes = doc.nodes;
  let n = 0;
  const add = (type: NodeType, parentId: NodeId, props: Partial<SceneNode>, id = `p${++n}`) => {
    nodes[id] = createNode(type, {...props, id, parentId});
    nodes[parentId].children!.push(id);
    return id;
  };
  const picture = (k: number) =>
    refs.length ? [{type: 'IMAGE' as const, imageRef: refs[k % refs.length], scaleMode: 'FILL' as const, visible: true, opacity: 1, blendMode: 'NORMAL' as const}] : [solid({r: 0.8, g: 0.85, b: 0.9})];
  const autoLayout = (mode: 'HORIZONTAL' | 'VERTICAL', spacing: number, padding: number) => ({...defaultAutoLayout(mode), itemSpacing: spacing, paddingLeft: padding, paddingRight: padding, paddingTop: padding, paddingBottom: padding});
  const text = (parentId: NodeId, characters: string, size: number, props: Partial<SceneNode> = {}) =>
    add('TEXT', parentId, {name: characters.slice(0, 24), width: 320, height: size * 1.2, text: {...defaultTextProps(characters), style: {...defaultTextProps(characters).style, fontSize: size}, textAutoResize: 'HEIGHT'}, layoutSizingHorizontal: 'FILL', ...props});

  // ── Components: 20 sets × 2 variants ──
  const sets: NodeId[] = [];
  for (let c = 0; c < 20; c++) {
    const variants: NodeId[] = [];
    for (const [v, state] of ['Обычная', 'Выделенная'].entries()) {
      const id = add('COMPONENT', 'components', {name: `Состояние=${state}`, x: c * 400, y: v * 500, width: 320, height: 420, autoLayout: autoLayout('VERTICAL', 12, 16), fills: [solid(v ? {r: 0.95, g: 0.97, b: 1} : {r: 1, g: 1, b: 1})], cornerRadius: 12, effects: [shadow(4, 16)]}, `c${c}v${v}`);
      add('RECTANGLE', id, {name: 'Картинка', width: 288, height: 160, fills: picture(c), cornerRadius: 8, layoutSizingHorizontal: 'FILL'}, `${id}-img`);
      text(id, `Карточка ${c + 1}`, 20);
      text(id, PARAGRAPH.slice(0, 120), 14);
      const button = add('FRAME', id, {name: 'Кнопка', width: 120, height: 40, autoLayout: autoLayout('HORIZONTAL', 8, 10), fills: [solid({r: 0.2, g: 0.4, b: 1})], cornerRadius: 8, layoutSizingHorizontal: 'HUG', layoutSizingVertical: 'HUG'}, `${id}-btn`);
      text(button, 'Подробнее', 14, {layoutSizingHorizontal: 'HUG'});
      variants.push(id);
    }
    const combined = combineAsVariants(doc, variants, `set${c}`);
    doc = combined.doc;
    Object.assign(nodes, doc.nodes);
    doc = {...doc, nodes};
    sets.push(combined.setId);
  }

  // ── Screens: 40 × (header, hero, 2 card rows of 4 instances, 9 text sections with pictures) ──
  const instances: {parent: NodeId; set: number}[] = [];
  for (let s = 0; s < 40; s++) {
    const screen = add('FRAME', 'screens', {name: `Экран ${s + 1}`, x: (s % 8) * 1600, y: Math.floor(s / 8) * 4200, width: 1440, height: 4000, autoLayout: autoLayout('VERTICAL', 32, 0), layoutSizingVertical: 'HUG', fills: [solid({r: 1, g: 1, b: 1})]});
    const header = add('FRAME', screen, {name: 'Шапка', width: 1440, height: 80, autoLayout: autoLayout('HORIZONTAL', 24, 24), layoutSizingHorizontal: 'FILL', effects: [shadow(1, 4), blur(20)], fills: [solid({r: 1, g: 1, b: 1}, 0.8)]});
    add('VECTOR', header, {name: 'Логотип', width: 32, height: 32});
    for (const item of ['Продукт', 'Цены', 'Команда', 'Блог', 'Контакты']) text(header, item, 16, {layoutSizingHorizontal: 'HUG'});
    const hero = add('FRAME', screen, {name: 'Обложка', width: 1440, height: 600, autoLayout: autoLayout('HORIZONTAL', 48, 64), layoutSizingHorizontal: 'FILL'});
    const copy = add('FRAME', hero, {name: 'Текст', width: 600, height: 400, autoLayout: autoLayout('VERTICAL', 16, 0), layoutSizingHorizontal: 'FILL', layoutSizingVertical: 'HUG'});
    text(copy, `Экран ${s + 1}: всё для совместной работы`, 48);
    text(copy, PARAGRAPH, 18);
    add('RECTANGLE', hero, {name: 'Иллюстрация', width: 640, height: 480, fills: picture(s), cornerRadius: 24, effects: [shadow(12, 40)]});
    for (let row = 0; row < 2; row++) {
      const cards = add('FRAME', screen, {name: `Карточки ${row + 1}`, width: 1440, height: 460, autoLayout: autoLayout('HORIZONTAL', 24, 40), layoutSizingHorizontal: 'FILL', layoutSizingVertical: 'HUG'});
      for (let k = 0; k < 4; k++) instances.push({parent: cards, set: (s * 8 + row * 4 + k) % 20});
    }
    for (let section = 0; section < 9; section++) {
      const block = add('FRAME', screen, {name: `Раздел ${section + 1}`, width: 1440, height: 300, autoLayout: autoLayout('HORIZONTAL', 32, 40), layoutSizingHorizontal: 'FILL', layoutSizingVertical: 'HUG'});
      const column = add('FRAME', block, {name: 'Колонка', width: 700, height: 300, autoLayout: autoLayout('VERTICAL', 12, 0), layoutSizingHorizontal: 'FILL', layoutSizingVertical: 'HUG'});
      text(column, `Раздел ${section + 1}`, 32);
      for (let p = 0; p < 4; p++) text(column, PARAGRAPH, 16);
      const list = add('FRAME', column, {name: 'Список', width: 700, height: 200, autoLayout: autoLayout('VERTICAL', 8, 0), layoutSizingHorizontal: 'FILL', layoutSizingVertical: 'HUG'});
      for (let item = 0; item < 6; item++) {
        const line = add('FRAME', list, {name: 'Пункт', width: 700, height: 24, autoLayout: autoLayout('HORIZONTAL', 8, 0), layoutSizingHorizontal: 'FILL', layoutSizingVertical: 'HUG'});
        add('ELLIPSE', line, {name: 'Маркер', width: 8, height: 8, fills: [solid({r: 0.2, g: 0.4, b: 1})]});
        text(line, `Пункт ${item + 1}: ${PARAGRAPH.slice(0, 60)}`, 14);
      }
      add('RECTANGLE', block, {name: 'Фото', width: 560, height: 360, fills: picture(s * 6 + section), cornerRadius: 16, effects: section % 2 ? [shadow(8, 24)] : [blur(8)]});
    }
  }
  doc = {...doc, nodes};
  let k = 0;
  for (const {parent, set} of instances) doc = createInstance(doc, sets[set], {parentId: parent, newId: `i${++k}`}).doc;
  return normalizeDocument(doc, new Set(Object.keys(doc.nodes)), {measurer: testMeasurer});
}
