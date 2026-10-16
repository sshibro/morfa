import {createDocument, createNode, defaultAutoLayout, defaultTextProps, defaultTextStyle, solid} from '../../shared/design/defaults';
import type {
  AutoLayout, BlendMode, BooleanOperation, DesignDocument, Effect, ImageAsset, LayoutGrid, LayoutSizing, NodeId, NodeType, Paint, PathCommand, RGB, RGBA,
  SceneNode, StrokeMarker, Style, TextProps, Variable, VariableAlias, VariableId, VectorPath,
} from '../../shared/design/types';
import {normalizeDocument} from '../../shared/design/normalize';
import {addComponentProperty, assignFields, bindProperty, createComponent, createInstance, setInstanceProperty, withOverrideTracking} from '../../shared/design/components';
import {combineAsVariants} from '../../shared/design/variants';
import {addVariableMode, bindPaintVariable, bindVariable, createVariable, createVariableCollection, setNodeVariableMode, setVariableValue} from '../../shared/design/variables';
import {applyFillsToRange, applyStyleToRange, insertText, setListType} from '../../shared/design/text-edit';
import {beginTransaction, type Transaction} from '../../shared/design/transaction';
import type {DocumentPatch} from '../../shared/design/patch';
import {testMeasurer} from './design-big-files';

// Seeded design documents for the differential oracle and the merge tests: `fuzzDocument(seed, {nodes})`
// builds a file of about `nodes` layers with every node type, nested auto layout, sections, groups with masks, booleans
// (nested ones too), every leaf kind with radii, arcs, markers and vector paths, gradient and image paints (with entries in
// `images`), shadows and blurs, rotations and flips, fill/text/effect/grid styles, text with style runs, fill runs, lists
// and hyperlinks, components made with createComponent (from a frame, a group and a wrapped shape), variant sets
// (combineAsVariants), BOOLEAN/TEXT/INSTANCE_SWAP properties (addComponentProperty, bindProperty), nested instances,
// instances (createInstance) with overrides recorded by withOverrideTracking and property values set by
// setInstanceProperty (variant switches included), variable collections with modes, aliases (inside and across
// collections), bindings on fields and paints, and per-frame modes. The result is settled by `normalizeDocument` with
// `testMeasurer`: instances synced, variables applied, layout and group boxes computed.
//
// Deterministic by seed: no Math.random, clock or newId; every id comes from a counter behind a seed-derived prefix
// that starts with a letter (seed 1: `f1-n2h`, instance copies `f1-n7e;f1-n12`). Same seed and options → the same JSON bytes.
//
// `fuzzPatch(doc, seed)` is one person's edit as a real transaction (beginTransaction … commit with testMeasurer);
// `fuzzPatchPair(doc, seed)` two concurrent ones of the same base touching some of the same nodes (hot set) and some
// disjoint ones: field and text edits, overrides on instance copies, creates, leaf removes, moves, reorders, page order
// and new pages, style, image and variable table edits, node modes. `fuzzCommits` chains edits for shadow-document runs.
//
// Stand-ins this replaces: lane L1's scripts/geometry/fuzz-docs.ts (`mulberry32`, `randomPathData(r, scale)` and
// `randomDocument(seed, parse)` keep their signatures; `randomDocument` also takes an rng as L2a's did) and lane L2a's
// crates/ops/harness/fuzz.ts, now tests/helpers/ops-fuzz.ts (`randomEdit(base, rng)` and `patchPair(base, rng)` →
// `{theirs, ours}` of `{doc, patch}` keep theirs). `fuzzPatchPair(doc, seed?)` takes a seed instead of an rng and returns `{a, b, docA, docB}`: `a` and `b` are the
// patches against `doc`, `docA`/`docB` the documents each one alone gives.

export type Rng = () => number;

export function mulberry32(seed: number): Rng {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

const int = (r: Rng, n: number) => Math.floor(r() * n);
const pick = <T>(r: Rng, items: readonly T[]): T => items[int(r, items.length)];
const chance = (r: Rng, p: number) => r() < p;
const range = (r: Rng, lo: number, hi: number) => lo + r() * (hi - lo);
/** Two decimals: readable numbers that still exercise fractions. */
const r2 = (value: number) => Math.round(value * 100) / 100;
const weighted = <T>(r: Rng, items: readonly [T, number][]): T => {
  let roll = r() * items.reduce((sum, [, w]) => sum + w, 0);
  for (const [item, w] of items) if ((roll -= w) < 0) return item;
  return items[items.length - 1][0];
};

export type Feature =
  | 'autoLayout' | 'sections' | 'components' | 'variants' | 'properties' | 'overrides' | 'variables' | 'styles'
  | 'text' | 'masks' | 'booleans' | 'transforms' | 'effects' | 'images' | 'gradients' | 'prototype';
export const FEATURES: readonly Feature[] = [
  'autoLayout', 'sections', 'components', 'variants', 'properties', 'overrides', 'variables', 'styles',
  'text', 'masks', 'booleans', 'transforms', 'effects', 'images', 'gradients', 'prototype',
];
export type FuzzOptions = {
  /** About how many nodes the file holds, pages and instance copies included (default 300; 20 000 is fine). */
  nodes?: number;
  /** Pages, the components page included (default 2 + one per 4 000 nodes, at most 8). */
  pages?: number;
  /** Everything is on unless switched off here. */
  features?: Partial<Record<Feature, boolean>>;
  /** VECTOR paths from random SVG path data (`randomPathData`) through this parser (L1's harness hands both engines the
   *  same commands); without it paths are made as commands directly. */
  parsePathData?: (d: string) => PathCommand[];
};

const ALL_TYPES: readonly NodeType[] = [
  'PAGE', 'FRAME', 'GROUP', 'SECTION', 'COMPONENT', 'COMPONENT_SET', 'INSTANCE', 'BOOLEAN_OPERATION',
  'RECTANGLE', 'ELLIPSE', 'LINE', 'POLYGON', 'STAR', 'VECTOR', 'TEXT', 'SLICE',
];
export const NODE_TYPES = ALL_TYPES;

// The Cyrillic words stay on purpose: the fuzzed texts must shape and wrap non-Latin letters (ё, a combining diaeresis,
// emoji, a long hyphenated word) as well as Latin ones.
const WORDS = ['Привет', 'мир', 'дизайн', 'Morfa', 'layout', 'кнопка', 'карточка', 'ёж', 'Ünïcode', '😀', '42', 'Lorem', 'ipsum', 'текст', 'A', 'длинное-слово'];
const words = (r: Rng, n: number) => Array.from({length: n}, () => pick(r, WORDS)).join(' ');
const BLENDS: BlendMode[] = ['NORMAL', 'MULTIPLY', 'SCREEN', 'OVERLAY', 'DARKEN', 'LIGHTEN', 'DIFFERENCE', 'LUMINOSITY'];
const MARKERS: StrokeMarker[] = ['NONE', 'NONE', 'LINE_ARROW', 'TRIANGLE_ARROW', 'REVERSED_TRIANGLE', 'CIRCLE', 'DIAMOND', 'ROUND', 'SQUARE'];

/** Random SVG path data: the full grammar, relative and absolute, several subpaths, open and closed (L1's signature). */
export function randomPathData(r: Rng, scale = 200): string {
  const n = (v: number) => (Number.isInteger(v) ? String(v) : v.toFixed(3));
  const c = () => n(r2(range(r, 0, scale)));
  const d = () => n(r2(range(r, -scale / 3, scale / 3)));
  const parts: string[] = [];
  const subpaths = 1 + int(r, 3);
  for (let s = 0; s < subpaths; s++) {
    parts.push(`M${c()} ${c()}`);
    for (let k = 1 + int(r, 6); k > 0; k--) {
      const rel = chance(r, 0.4);
      const p = () => (rel ? `${d()} ${d()}` : `${c()} ${c()}`);
      const cmd = pick(r, ['L', 'H', 'V', 'C', 'S', 'Q', 'T', 'A', 'L', 'C'] as const);
      const letter = rel ? cmd.toLowerCase() : cmd;
      if (cmd === 'L' || cmd === 'T') parts.push(`${letter}${p()}`);
      else if (cmd === 'H' || cmd === 'V') parts.push(`${letter}${rel ? d() : c()}`);
      else if (cmd === 'C') parts.push(`${letter}${p()} ${p()} ${p()}`);
      else if (cmd === 'S' || cmd === 'Q') parts.push(`${letter}${p()} ${p()}`);
      else parts.push(`${letter}${n(r2(range(r, 1, scale / 2)))} ${n(r2(range(r, 1, scale / 2)))} ${int(r, 360) - 180} ${int(r, 2)} ${int(r, 2)} ${p()}`);
    }
    if (chance(r, 0.6)) parts.push(chance(r, 0.5) ? 'Z' : 'z');
  }
  return parts.join(' ');
}

/** Absolute commands in a w×h box, without a parser. */
function randomCommands(r: Rng, w: number, h: number): PathCommand[] {
  const x = () => r2(range(r, 0, w)), y = () => r2(range(r, 0, h));
  const out: PathCommand[] = [{type: 'M', x: x(), y: y()}];
  for (let k = 2 + int(r, 5); k > 0; k--) {
    const roll = r();
    if (roll < 0.4) out.push({type: 'L', x: x(), y: y()});
    else if (roll < 0.75) out.push({type: 'C', x1: x(), y1: y(), x2: x(), y2: y(), x: x(), y: y()});
    else out.push({type: 'Q', x1: x(), y1: y(), x: x(), y: y()});
  }
  if (chance(r, 0.6)) out.push({type: 'Z'});
  return out;
}

const seedPrefix = (seed: number) => `f${(seed >>> 0).toString(36)}`;

type CompInfo = {id: NodeId; size: number; variants: {key: string; options: string[]}[]; props: {key: string; type: 'BOOLEAN' | 'TEXT' | 'INSTANCE_SWAP'}[]};

/** A seeded document of about `options.nodes` nodes, normalized (see the header). */
export function fuzzDocument(seed: number, options: FuzzOptions = {}): DesignDocument {
  const r = mulberry32(seed ^ 0x9e3779b9);
  const target = Math.max(40, Math.floor(options.nodes ?? 300));
  const on = (feature: Feature) => options.features?.[feature] ?? true;
  const prefix = seedPrefix(seed);
  let counter = 0;
  const gen = (kind = 'n') => `${prefix}-${kind}${(++counter).toString(36)}`;
  const nextNode = () => gen('n');

  // ── Pages, tables ──
  const pageCount = Math.max(1, Math.floor(options.pages ?? Math.min(8, 2 + Math.floor(target / 4000))));
  const pageIds = Array.from({length: pageCount}, () => gen('p'));
  let doc = createDocument(pageIds[0], 'Page 1');
  for (let p = 1; p < pageCount; p++) doc.nodes[pageIds[p]] = createNode('PAGE', {id: pageIds[p], name: `Page ${p + 1}`, ...(chance(r, 0.5) ? {backgroundColor: {r: 0.96, g: 0.96, b: 0.97}} : {})});
  doc.pages = [...pageIds];
  const componentsPage = pageIds[pageCount - 1];
  const contentPages = pageCount > 1 && on('components') ? pageIds.slice(0, -1) : pageIds;

  const imageRefs: string[] = [];
  if (on('images'))
    for (let i = 0; i < 2 + int(r, 4); i++) {
      const ref = gen('img');
      imageRefs.push(ref);
      doc.images[ref] = {url: `/uploads/${ref}.png`, width: 64 + int(r, 2000), height: 64 + int(r, 2000), ...(chance(r, 0.5) ? {name: `Image ${i + 1}.png`} : {})} satisfies ImageAsset;
    }

  const color = (): RGB => ({r: r2(r()), g: r2(r()), b: r2(r())});
  const rgba = (a = r2(range(r, 0.1, 1))): RGBA => ({...color(), a});
  const paint = (allowImage = true): Paint => {
    const roll = r();
    if (allowImage && imageRefs.length && roll < 0.12) {
      const scaleMode = pick(r, ['FILL', 'FIT', 'CROP', 'TILE'] as const);
      return {
        type: 'IMAGE', imageRef: pick(r, imageRefs), scaleMode, opacity: 1, visible: true, blendMode: 'NORMAL',
        ...(scaleMode === 'CROP' ? {imageTransform: [[0.5, 0, 0.25], [0, 0.5, 0.25]]} : {}),
        ...(scaleMode === 'TILE' ? {scalingFactor: pick(r, [0.25, 0.5, 1, 2])} : {}),
        ...(chance(r, 0.2) ? {rotation: pick(r, [0, 90, 180, 270] as const)} : {}),
        ...(chance(r, 0.2) ? {filters: {exposure: r2(range(r, -1, 1)), contrast: r2(range(r, -1, 1))}} : {}),
      };
    }
    if (on('gradients') && roll < 0.3)
      return {
        type: pick(r, ['GRADIENT_LINEAR', 'GRADIENT_RADIAL', 'GRADIENT_ANGULAR', 'GRADIENT_DIAMOND'] as const), opacity: r2(range(r, 0.5, 1)), visible: true, blendMode: 'NORMAL',
        gradientStops: [{position: 0, color: rgba(1)}, ...(chance(r, 0.4) ? [{position: 0.5, color: rgba()}] : []), {position: 1, color: rgba()}],
        gradientHandlePositions: [{x: 0, y: 0.5}, {x: 1, y: 0.5}, {x: 0, y: 1}],
      };
    return {...solid(color(), chance(r, 0.8) ? 1 : r2(range(r, 0.2, 1))), ...(chance(r, 0.05) ? {visible: false} : {}), ...(chance(r, 0.05) ? {blendMode: pick(r, BLENDS)} : {})};
  };
  const effect = (): Effect => {
    const roll = r();
    if (roll < 0.6) return {type: chance(r, 0.75) ? 'DROP_SHADOW' : 'INNER_SHADOW', color: {r: 0, g: 0, b: 0, a: r2(range(r, 0.05, 0.4))}, offset: {x: int(r, 9) - 4, y: int(r, 16)}, radius: int(r, 40), spread: int(r, 8) - 2, visible: true, blendMode: 'NORMAL', ...(chance(r, 0.2) ? {showShadowBehindNode: true} : {})};
    return {type: roll < 0.8 ? 'LAYER_BLUR' : 'BACKGROUND_BLUR', radius: 1 + int(r, 30), visible: true};
  };

  // Styles: nodes that use one carry its values and its id, as styles.ts keeps them.
  const styles = {fill: [] as Style[], text: [] as Style[], effect: [] as Style[], grid: [] as Style[]};
  if (on('styles')) {
    for (let i = 0; i < 3; i++) styles.fill.push({id: gen('s'), type: 'FILL', name: `Colors/Fill ${i + 1}`, description: i ? '' : 'Primary color', paints: [solid(color())]});
    for (let i = 0; i < 3; i++) styles.text.push({id: gen('s'), type: 'TEXT', name: `Text/Style ${i + 1}`, description: '', text: {...defaultTextStyle(), fontSize: pick(r, [12, 14, 16, 24, 32]), fontWeight: pick(r, [400, 500, 700]), lineHeight: chance(r, 0.5) ? {unit: 'AUTO'} : {unit: 'PIXELS', value: 24}}});
    for (let i = 0; i < 2; i++) styles.effect.push({id: gen('s'), type: 'EFFECT', name: `Shadows/Shadow ${i + 1}`, description: '', effects: [effect()]});
    styles.grid.push({id: gen('s'), type: 'GRID', name: 'Grids/12 columns', description: '', grids: [{pattern: 'COLUMNS', alignment: 'STRETCH', count: 12, gutterSize: 20, offset: 40, sectionSize: 60, visible: true, color: {r: 1, g: 0, b: 0, a: 0.1}}]});
    for (const style of [...styles.fill, ...styles.text, ...styles.effect, ...styles.grid]) doc.styles[style.id] = style;
  }

  // ── Variables: two collections with two modes, aliases inside and across collections ──
  const vars = {color: [] as VariableId[], space: [] as VariableId[], radius: [] as VariableId[], opacity: [] as VariableId[], size: [] as VariableId[], bool: [] as VariableId[], string: [] as VariableId[]};
  const collections: {id: string; modes: string[]}[] = [];
  if (on('variables')) {
    const theme = gen('vc'), light = gen('m'), dark = gen('m');
    doc = createVariableCollection(doc, {id: theme, name: 'Theme', modes: [{modeId: light, name: 'Light'}, {modeId: dark, name: 'Dark'}]}).doc;
    const spacing = gen('vc'), compact = gen('m'), regular = gen('m');
    doc = createVariableCollection(doc, {id: spacing, name: 'Spacing', modes: [{modeId: compact, name: 'Compact'}]}).doc;
    doc = addVariableMode(doc, spacing, {modeId: regular, name: 'Regular'}, compact).doc;
    collections.push({id: theme, modes: [light, dark]}, {id: spacing, modes: [compact, regular]});
    const make = (list: VariableId[], collectionId: string, name: string, type: Variable['type'], values: Variable['valuesByMode'][string][]) => {
      const id = gen('v');
      doc = createVariable(doc, {id, name, collectionId, type, value: values[0], ...(chance(r, 0.3) ? {description: 'Description'} : {})}).doc;
      const modes = collections.find(c => c.id === collectionId)!.modes;
      if (values[1] !== undefined) doc = setVariableValue(doc, id, modes[1], values[1]).doc;
      list.push(id);
      return id;
    };
    const primary = make(vars.color, theme, 'Color/Primary', 'COLOR', [rgba(1), rgba(1)]);
    make(vars.color, theme, 'Color/Background', 'COLOR', [{r: 1, g: 1, b: 1, a: 1}, {r: 0.1, g: 0.1, b: 0.12, a: 1}]);
    const alias = (id: VariableId): VariableAlias => ({type: 'VARIABLE_ALIAS', id});
    // An alias in one mode, a value in the other; then an alias of an alias.
    const accent = make(vars.color, theme, 'Color/Accent', 'COLOR', [alias(primary), rgba(1)]);
    make(vars.color, theme, 'Color/Link', 'COLOR', [alias(accent), alias(primary)]);
    const s = make(vars.space, spacing, 'Spacing/S', 'FLOAT', [4, 8]);
    const m = make(vars.space, spacing, 'Spacing/M', 'FLOAT', [8, 16]);
    make(vars.space, spacing, 'Spacing/Card', 'FLOAT', [alias(m), alias(s)]);
    make(vars.radius, spacing, 'Radius', 'FLOAT', [4, 12]);
    // Across collections: the theme's radius follows the spacing one.
    make(vars.radius, theme, 'Radius/Card', 'FLOAT', [alias(vars.radius[0]), 16]);
    make(vars.opacity, theme, 'Opacity', 'FLOAT', [100, 60]);
    make(vars.size, spacing, 'Font size', 'FLOAT', [14, 16]);
    make(vars.bool, theme, 'Visible', 'BOOLEAN', [true, true]);
    make(vars.string, theme, 'Label', 'STRING', ['Light theme', 'Dark theme']);
  }
  /** Direct bindings for a node (cheap: no table copy); the real binding APIs run on a sample later. */
  const bindings = (type: NodeType, props: Partial<SceneNode>): Partial<SceneNode> => {
    if (!on('variables') || !chance(r, 0.1)) return props;
    const bound: Record<string, VariableAlias> = {...(props.boundVariables ?? {})};
    const to = (list: VariableId[]): VariableAlias => ({type: 'VARIABLE_ALIAS', id: pick(r, list)});
    if (chance(r, 0.5)) bound.opacity = to(vars.opacity);
    if (props.autoLayout && props.autoLayout.layoutMode !== 'NONE') {
      bound.itemSpacing = to(vars.space);
      if (chance(r, 0.5)) bound.paddingLeft = to(vars.space);
    }
    if ((type === 'RECTANGLE' || type === 'FRAME') && chance(r, 0.5)) bound.cornerRadius = to(vars.radius);
    if (type === 'TEXT' && chance(r, 0.5)) bound.fontSize = to(vars.size);
    if (type === 'TEXT' && chance(r, 0.1)) bound.characters = to(vars.string);
    if (chance(r, 0.03)) bound.visible = to(vars.bool);
    const out = {...props};
    if (Object.keys(bound).length) out.boundVariables = bound;
    const fills = out.fills;
    if (fills?.length && fills[0].type === 'SOLID' && chance(r, 0.6)) out.fills = [{...fills[0], boundVariables: {color: to(vars.color)}}, ...fills.slice(1)];
    return out;
  };

  // ── Node builders ──
  let added = 0;
  const add = (type: NodeType, parentId: NodeId, props: Partial<SceneNode> = {}, id = nextNode()) => {
    added++;
    // `undefined` in props clears a field a builder set (a flip on a component's part): drop the key, as stored JSON would.
    const defined = Object.fromEntries(Object.entries(props).filter(([, value]) => value !== undefined)) as Partial<SceneNode>;
    doc.nodes[id] = createNode(type, {...defined, id, parentId});
    doc.nodes[parentId].children!.push(id);
    return id;
  };
  const transform = (): Partial<SceneNode> => {
    if (!on('transforms')) return {};
    const out: Partial<SceneNode> = {};
    if (chance(r, 0.15)) out.rotation = pick(r, [90, -90, 180, 45, -30, r2(range(r, -180, 180))]);
    if (chance(r, 0.08)) out.flipX = true;
    if (chance(r, 0.08)) out.flipY = true;
    return out;
  };
  const strokes = (): Partial<SceneNode> => {
    if (!chance(r, 0.3)) return {};
    return {
      strokes: [paint(false)], strokeWeight: pick(r, [0.5, 1, 2, 4, 8]), strokeAlign: pick(r, ['INSIDE', 'CENTER', 'OUTSIDE'] as const),
      strokeCap: pick(r, ['NONE', 'ROUND', 'SQUARE'] as const), strokeJoin: pick(r, ['MITER', 'BEVEL', 'ROUND'] as const),
      ...(chance(r, 0.25) ? {dashPattern: [pick(r, [2, 4, 8]), pick(r, [2, 4])]} : {}),
    };
  };
  const looks = (fillsToo = true): Partial<SceneNode> => {
    const out: Partial<SceneNode> = {...strokes()};
    if (fillsToo) {
      if (styles.fill.length && chance(r, 0.15)) {
        const style = pick(r, styles.fill);
        out.fills = style.paints!.map(p => ({...p}));
        out.fillStyleId = style.id;
      } else if (chance(r, 0.85)) out.fills = Array.from({length: chance(r, 0.15) ? 2 : 1}, () => paint());
      else out.fills = [];
    }
    if (on('effects') && chance(r, 0.12)) {
      if (styles.effect.length && chance(r, 0.3)) {
        const style = pick(r, styles.effect);
        out.effects = style.effects!.map(e => ({...e}));
        out.effectStyleId = style.id;
      } else out.effects = Array.from({length: 1 + int(r, 2)}, effect);
    }
    if (chance(r, 0.08)) out.opacity = r2(range(r, 0.2, 1));
    if (chance(r, 0.05)) out.blendMode = pick(r, BLENDS);
    if (chance(r, 0.03)) out.visible = false;
    if (chance(r, 0.03)) out.locked = true;
    if (chance(r, 0.03)) out.annotations = [{id: 'a1', label: words(r, 2)}];
    if (chance(r, 0.02)) out.pluginData = {source: 'fuzz', k: String(int(r, 9))};
    return out;
  };
  const text = (characters: string): TextProps => {
    let t: TextProps = {...defaultTextProps(characters), textAutoResize: pick(r, ['WIDTH_AND_HEIGHT', 'WIDTH_AND_HEIGHT', 'HEIGHT', 'NONE', 'TRUNCATE'] as const), textAlignHorizontal: pick(r, ['LEFT', 'LEFT', 'CENTER', 'RIGHT', 'JUSTIFIED'] as const)};
    if (t.textAutoResize === 'TRUNCATE' && chance(r, 0.5)) t.maxLines = 1 + int(r, 3);
    if (chance(r, 0.3)) t = {...t, style: {...t.style, fontSize: pick(r, [12, 14, 18, 24, 36]), fontWeight: pick(r, [300, 400, 600, 700]), italic: chance(r, 0.1)}};
    if (chance(r, 0.1)) t = {...t, style: {...t.style, letterSpacing: {unit: 'PIXELS', value: 1}, textCase: pick(r, ['UPPER', 'TITLE', 'SMALL_CAPS'] as const), textDecoration: pick(r, ['UNDERLINE', 'STRIKETHROUGH'] as const)}};
    // Style runs through the editor's own range edits.
    const len = characters.length;
    if (len > 3 && chance(r, 0.55)) {
      const start = int(r, len - 2), end = start + 1 + int(r, len - start - 1);
      t = applyStyleToRange(t, start, end, pick(r, [{fontWeight: 700}, {italic: true}, {fontSize: 22}, {textDecoration: 'UNDERLINE' as const}, {fontFamily: 'Roboto', fontWeight: 500}]));
      if (chance(r, 0.4)) t = applyStyleToRange(t, 0, 1 + int(r, Math.min(3, len)), {letterSpacing: {unit: 'PERCENT', value: 5}});
      if (chance(r, 0.15)) t = applyStyleToRange(t, 0, Math.min(len, 2), {hyperlink: {type: 'URL', url: 'https://example.com/fuzz'}});
    }
    if (characters.includes('\n') && chance(r, 0.5)) t = setListType(t, 0, len, pick(r, ['ORDERED', 'UNORDERED'] as const));
    if (chance(r, 0.15)) t = {...t, paragraphSpacing: 8, paragraphIndent: chance(r, 0.5) ? 12 : 0};
    return t;
  };
  const textNode = (parentId: NodeId, props: Partial<SceneNode> = {}, characters = words(r, 1 + int(r, 6)) + (chance(r, 0.15) ? '\n' + words(r, 2) : '')) => {
    let t = text(characters);
    const extra: Partial<SceneNode> = {};
    if (styles.text.length && chance(r, 0.15)) {
      const style = pick(r, styles.text);
      t = {...t, style: {...style.text!}};
      extra.textStyleId = style.id;
    }
    let fills: Paint[] = [solid({r: 0.1, g: 0.1, b: 0.1})];
    if (t.characters.length > 2 && chance(r, 0.2)) {
      const filled = applyFillsToRange(t, fills, 0, 1 + int(r, t.characters.length - 1), [solid(color())]);
      t = filled.text;
      fills = filled.fills;
    }
    const width = t.textAutoResize === 'WIDTH_AND_HEIGHT' ? 0 : 80 + int(r, 240);
    return add('TEXT', parentId, bindings('TEXT', {name: characters.slice(0, 24), x: int(r, 300), y: int(r, 300), width, height: 20, text: t, fills, ...extra, ...transform(), ...props}));
  };
  const vectorPaths = (w: number, h: number): VectorPath[] => {
    const windingRule = chance(r, 0.4) ? 'EVENODD' as const : 'NONZERO' as const;
    if (options.parsePathData) return [{windingRule, commands: options.parsePathData(randomPathData(r, Math.max(w, h)))}];
    return Array.from({length: chance(r, 0.25) ? 2 : 1}, () => ({windingRule, commands: randomCommands(r, w, h)}));
  };
  const SHAPES: [NodeType, number][] = [['RECTANGLE', 3], ['TEXT', 3], ['ELLIPSE', 2], ['VECTOR', 1.5], ['LINE', 1], ['POLYGON', 1], ['STAR', 1], ['SLICE', 0.3]];
  const leaf = (parentId: NodeId, type: NodeType = weighted(r, SHAPES), props: Partial<SceneNode> = {}): NodeId => {
    if (type === 'TEXT') return on('text') ? textNode(parentId, props) : leaf(parentId, 'RECTANGLE', props);
    const width = 8 + int(r, 200), height = type === 'LINE' ? 0 : 8 + int(r, 160);
    const base: Partial<SceneNode> = {x: int(r, 400), y: int(r, 300), width, height, ...looks(type !== 'LINE' && type !== 'SLICE'), ...transform()};
    switch (type) {
      case 'RECTANGLE':
        if (chance(r, 0.4)) base.cornerRadius = pick(r, [2, 4, 8, 16, 999]);
        if (chance(r, 0.15)) base.rectangleCornerRadii = [int(r, 20), int(r, 20), int(r, 20), int(r, 20)];
        if (chance(r, 0.15)) base.cornerSmoothing = 0.6;
        if (chance(r, 0.08)) base.individualStrokeWeights = {top: 1, right: 0, bottom: 2, left: 0};
        break;
      case 'ELLIPSE':
        if (chance(r, 0.3)) base.arcData = {startingAngle: r2(range(r, 0, Math.PI)), endingAngle: r2(range(r, Math.PI, 2 * Math.PI)), innerRadius: pick(r, [0, 0.5, r2(r())])};
        break;
      case 'POLYGON':
        base.pointCount = pick(r, [3, 5, 6, 8]);
        if (chance(r, 0.3)) base.cornerRadius = 4;
        break;
      case 'STAR':
        base.pointCount = pick(r, [4, 5, 7]);
        base.innerRadius = pick(r, [0.382, 0.2, 0.7]);
        break;
      case 'LINE':
        base.strokes = [solid(color())];
        base.strokeWeight = pick(r, [1, 2, 4]);
        base.strokeStartMarker = pick(r, MARKERS);
        base.strokeEndMarker = pick(r, MARKERS);
        if (chance(r, 0.1)) base.variableWidthStrokeProperties = {widthProfile: pick(r, ['WEDGE', 'TAPER', 'EYE'] as const)};
        break;
      case 'VECTOR':
        base.vectorPaths = vectorPaths(width, height);
        base.strokeStartMarker = pick(r, MARKERS);
        base.strokeEndMarker = pick(r, MARKERS);
        break;
      case 'SLICE':
        base.exportSettings = [{format: pick(r, ['PNG', 'SVG', 'PDF', 'JPG'] as const), suffix: '', constraint: {type: 'SCALE', value: pick(r, [1, 2, 3])}}];
        break;
    }
    return add(type, parentId, bindings(type, {...base, ...props}));
  };
  const autoLayout = (mode?: 'HORIZONTAL' | 'VERTICAL'): AutoLayout => {
    const m = mode ?? pick(r, ['HORIZONTAL', 'VERTICAL'] as const);
    const pad = pick(r, [0, 8, 12, 16, 24]);
    return {
      ...defaultAutoLayout(m), itemSpacing: pick(r, [0, 4, 8, 12, 24]), paddingLeft: pad, paddingRight: pad, paddingTop: pick(r, [0, pad]), paddingBottom: pad,
      primaryAxisAlignItems: pick(r, ['MIN', 'MIN', 'CENTER', 'MAX', 'SPACE_BETWEEN'] as const), counterAxisAlignItems: pick(r, ['MIN', 'MIN', 'CENTER', 'MAX'] as const),
      ...(m === 'HORIZONTAL' && chance(r, 0.15) ? {layoutWrap: 'WRAP' as const, counterAxisSpacing: 8} : {}),
      ...(chance(r, 0.05) ? {itemReverseZIndex: true} : {}), ...(chance(r, 0.05) ? {strokesIncludedInLayout: true} : {}),
    };
  };
  const isAuto = (id: NodeId) => {
    const node = doc.nodes[id];
    return !!node.autoLayout && node.autoLayout.layoutMode !== 'NONE';
  };
  /** How a child sits in its parent: FILL/HUG and absolute children in auto layout, constraints elsewhere. */
  const placement = (parentId: NodeId, type: NodeType, autoSelf: boolean): Partial<SceneNode> => {
    if (!isAuto(parentId)) return chance(r, 0.2) ? {constraints: {horizontal: pick(r, ['MIN', 'MAX', 'CENTER', 'STRETCH', 'SCALE'] as const), vertical: pick(r, ['MIN', 'MAX', 'CENTER', 'STRETCH', 'SCALE'] as const)}} : {};
    if (chance(r, 0.06)) return {layoutPositioning: 'ABSOLUTE', constraints: {horizontal: 'MAX', vertical: 'MIN'}};
    // Groups and booleans fit their children: a FILL would rescale them on every pass.
    if (type === 'GROUP' || type === 'BOOLEAN_OPERATION') return {};
    const hug = autoSelf || type === 'TEXT';
    // FILL never stands in a parent that hugs on that axis (the editor turns the parent FIXED first): layout has no fixed point there.
    const parent = doc.nodes[parentId];
    const sizing = (parentHugs: boolean): LayoutSizing => weighted(r, [['FIXED', 2], ...(parentHugs ? [] : [['FILL', 1.5] as [LayoutSizing, number]]), ...(hug ? [['HUG', 2] as [LayoutSizing, number]] : [])]);
    return {layoutSizingHorizontal: sizing(parent.layoutSizingHorizontal === 'HUG'), layoutSizingVertical: sizing(parent.layoutSizingVertical === 'HUG'), ...(chance(r, 0.05) ? {minWidth: 40, maxWidth: 600} : {})};
  };
  const frame = (parentId: NodeId, props: Partial<SceneNode> = {}, mode?: 'HORIZONTAL' | 'VERTICAL'): NodeId => {
    const auto = on('autoLayout') && (mode !== undefined || chance(r, 0.6));
    const al = auto ? autoLayout(mode) : undefined;
    const grids: Partial<SceneNode> = {};
    if (chance(r, 0.05)) {
      if (styles.grid.length && chance(r, 0.5)) Object.assign(grids, {layoutGrids: styles.grid[0].grids!.map(g => ({...g})), gridStyleId: styles.grid[0].id});
      else grids.layoutGrids = [{pattern: 'GRID', sectionSize: 8, visible: true, color: {r: 0, g: 0, b: 1, a: 0.1}} satisfies LayoutGrid];
    }
    return add('FRAME', parentId, bindings('FRAME', {
      name: auto ? 'Auto layout' : 'Frame', x: int(r, 400), y: int(r, 400), width: 120 + int(r, 500), height: 80 + int(r, 400),
      ...looks(), ...(chance(r, 0.4) ? {cornerRadius: pick(r, [4, 8, 16])} : {}), clipsContent: chance(r, 0.7),
      ...(al ? {autoLayout: al} : {}), ...grids, ...(chance(r, 0.05) ? {overflowDirection: 'VERTICAL' as const} : {}),
      ...placement(parentId, 'FRAME', auto), ...(chance(r, 0.3) ? transform() : {}), ...props,
    }));
  };
  const mask = (): Partial<SceneNode> => (on('masks') ? {isMask: true, ...(chance(r, 0.5) ? {maskType: pick(r, ['ALPHA', 'VECTOR', 'LUMINANCE'] as const)} : {})} : {});
  /** A group of 2–4 layers, the first a mask now and then. */
  const group = (parentId: NodeId, props: Partial<SceneNode> = {}): NodeId => {
    const id = add('GROUP', parentId, {name: 'Group', ...placement(parentId, 'GROUP', false), ...transform(), ...(chance(r, 0.1) ? {opacity: 0.8} : {}), ...props});
    const masked = chance(r, 0.3);
    for (let i = 0, n = 2 + int(r, 3); i < n; i++) leaf(id, i === 0 && masked ? pick(r, ['RECTANGLE', 'ELLIPSE', 'VECTOR'] as const) : undefined, i === 0 && masked ? mask() : {});
    return id;
  };
  const OPERAND: NodeType[] = ['RECTANGLE', 'ELLIPSE', 'STAR', 'POLYGON', 'RECTANGLE', 'VECTOR'];
  const booleanOp = (parentId: NodeId, depth = 0, props: Partial<SceneNode> = {}): NodeId => {
    const op: BooleanOperation = pick(r, ['UNION', 'INTERSECT', 'SUBTRACT', 'EXCLUDE']);
    const id = add('BOOLEAN_OPERATION', parentId, {name: op, booleanOperation: op, fills: [paint(false)], ...(depth ? {} : placement(parentId, 'BOOLEAN_OPERATION', false)), ...(depth ? {} : transform()), ...props});
    for (let i = 0, n = 2 + int(r, 2); i < n; i++) {
      if (depth < 1 && i === n - 1 && chance(r, 0.25)) booleanOp(id, depth + 1);
      else leaf(id, pick(r, OPERAND), {x: int(r, 80), y: int(r, 80), width: 20 + int(r, 100), height: 20 + int(r, 100), rotation: 0, flipX: undefined, flipY: undefined});
    }
    return id;
  };

  // ── Components (on the last page) ──
  const comps: CompInfo[] = [];
  const subtreeSize = (id: NodeId): number => 1 + (doc.nodes[id].children ?? []).reduce((sum, child) => sum + subtreeSize(child), 0);
  /** The table is copied after every API call: writing into one an API returned could leave its cached indexes stale. */
  const own = () => {
    doc = {...doc, nodes: {...doc.nodes}};
  };
  if (on('components')) {
    const count = Math.max(4, Math.min(20, Math.floor(target / 150)));
    const icons: NodeId[] = [];
    let x = 0;
    for (let c = 0; c < count; c++) {
      const kind = c % 4;
      if (kind === 0) {
        // An icon: a group made a component in place.
        const g = add('GROUP', componentsPage, {name: `Icon ${c + 1}`, x, y: 0});
        if (on('masks') && chance(r, 0.4)) leaf(g, 'ELLIPSE', {x: 0, y: 0, width: 24, height: 24, ...mask(), rotation: 0, flipX: undefined, flipY: undefined});
        leaf(g, 'VECTOR', {x: 2, y: 2, width: 20, height: 20, rotation: 0});
        leaf(g, 'STAR', {x: 4, y: 4, width: 16, height: 16, rotation: 0});
        const made = createComponent(doc, [g], gen);
        doc = made.doc;
        own();
        icons.push(g);
        comps.push({id: g, size: subtreeSize(g), variants: [], props: []});
      } else if (kind === 1) {
        // A card family: frames made components, combined as variants, with BOOLEAN and TEXT properties.
        const sizes = ['Small', 'Large'], states = ['Regular', 'Selected'];
        const n = on('variants') ? 2 + int(r, 3) : 1;
        const ids: NodeId[] = [];
        const parts: {icon: NodeId; title: NodeId}[] = [];
        for (let v = 0; v < n; v++) {
          const f = add('FRAME', componentsPage, {name: on('variants') ? `Size=${sizes[v % 2]}, State=${states[Math.floor(v / 2) % 2]}` : `Card ${c + 1}`, x, y: v * 400, width: 240 + (v % 2) * 80, height: 300,
            autoLayout: on('autoLayout') ? {...autoLayout('VERTICAL'), paddingLeft: 16, paddingRight: 16, paddingTop: 16, paddingBottom: 16} : undefined, fills: [paint()], cornerRadius: 12, ...(on('effects') ? {effects: [effect()]} : {})});
          leaf(f, 'RECTANGLE', {name: 'Image', width: 200, height: 120, fills: [paint()], rotation: 0, flipX: undefined, flipY: undefined, ...(on('autoLayout') ? {layoutSizingHorizontal: 'FILL'} : {})});
          const title = on('text') ? textNode(f, {name: 'Title', rotation: 0, flipX: undefined, flipY: undefined, boundVariables: undefined}, `Card ${c + 1}`) : leaf(f, 'RECTANGLE');
          if (on('text')) textNode(f, {name: 'Description', rotation: 0, flipX: undefined, flipY: undefined, ...(on('autoLayout') ? {layoutSizingHorizontal: 'FILL'} : {}), text: {...text(words(r, 8)), textAutoResize: 'HEIGHT'}});
          if (on('booleans')) booleanOp(f, 0, {rotation: 0, flipX: undefined, flipY: undefined});
          const button = add('FRAME', f, {name: 'Button', width: 120, height: 40, fills: [solid({r: 0.2, g: 0.4, b: 1})], cornerRadius: 8, ...(on('autoLayout') ? {autoLayout: {...autoLayout('HORIZONTAL'), paddingLeft: 12, paddingRight: 12, itemSpacing: 6}, layoutSizingHorizontal: 'HUG', layoutSizingVertical: 'HUG'} : {})});
          const icon = leaf(button, 'ELLIPSE', {name: 'Icon', width: 12, height: 12, rotation: 0, flipX: undefined, flipY: undefined});
          if (on('text')) textNode(button, {name: 'Label', rotation: 0, flipX: undefined, flipY: undefined, layoutSizingHorizontal: 'HUG', layoutSizingVertical: 'HUG', boundVariables: undefined}, 'Learn more');
          ids.push(f);
          parts.push({icon, title});
        }
        doc = createComponent(doc, ids, gen).doc;
        let owner = ids[0];
        if (on('variants')) {
          const setId = gen('set');
          doc = combineAsVariants(doc, ids, setId).doc;
          owner = setId;
        }
        const info: CompInfo = {id: owner, size: 0, variants: [], props: []};
        if (on('properties')) {
          const shown = addComponentProperty(doc, owner, {name: 'Icon', type: 'BOOLEAN', defaultValue: true});
          doc = shown.doc;
          for (const part of parts) doc = bindProperty(doc, part.icon, 'visible', shown.key).doc;
          info.props.push({key: shown.key, type: 'BOOLEAN'});
          if (on('text')) {
            const label = addComponentProperty(doc, owner, {name: 'Title', type: 'TEXT', defaultValue: `Card ${c + 1}`});
            doc = label.doc;
            for (const part of parts) doc = bindProperty(doc, part.title, 'characters', label.key).doc;
            info.props.push({key: label.key, type: 'TEXT'});
          }
        }
        for (const [key, def] of Object.entries(doc.nodes[owner].componentPropertyDefinitions ?? {})) if (def.type === 'VARIANT') info.variants.push({key, options: def.variantOptions ?? []});
        own();
        const first = doc.nodes[owner].type === 'COMPONENT_SET' ? doc.nodes[owner].children![0] : owner;
        info.size = subtreeSize(first);
        comps.push(info);
      } else if (kind === 2) {
        // A badge: an auto layout frame with a nested instance of an icon (an INSTANCE_SWAP property drives it).
        const f = add('FRAME', componentsPage, {name: `Badge ${c + 1}`, x, y: 0, width: 160, height: 40, fills: [paint(false)], cornerRadius: 20, ...(on('autoLayout') ? {autoLayout: {...autoLayout('HORIZONTAL'), itemSpacing: 6, paddingLeft: 10, paddingRight: 10}, layoutSizingHorizontal: 'HUG', layoutSizingVertical: 'HUG'} : {})});
        if (on('text')) textNode(f, {name: 'Text', rotation: 0, flipX: undefined, flipY: undefined, layoutSizingHorizontal: 'HUG', layoutSizingVertical: 'HUG', boundVariables: undefined}, words(r, 2));
        const icon = icons.length ? pick(r, icons) : undefined;
        let nested: NodeId | undefined;
        if (icon) {
          const made = createInstance(doc, icon, {parentId: f, newId: gen});
          doc = made.doc;
          nested = made.id;
        }
        doc = createComponent(doc, [f], gen).doc;
        const info: CompInfo = {id: f, size: 0, variants: [], props: []};
        if (on('properties') && nested && icons.length) {
          const swap = addComponentProperty(doc, f, {name: 'Icon', type: 'INSTANCE_SWAP', defaultValue: icon!, preferredValues: icons.slice(0, 3)});
          doc = bindProperty(swap.doc, nested, 'mainComponent', swap.key).doc;
          info.props.push({key: swap.key, type: 'INSTANCE_SWAP'});
        }
        own();
        info.size = subtreeSize(f);
        comps.push(info);
      } else {
        // A lone shape wrapped in a new component.
        const shape = leaf(componentsPage, pick(r, ['POLYGON', 'STAR', 'RECTANGLE'] as const), {x, y: 0, rotation: 0, flipX: undefined, flipY: undefined, boundVariables: undefined});
        const made = createComponent(doc, [shape], gen);
        doc = made.doc;
        own();
        if (on('properties') && chance(r, 0.5)) doc.nodes[made.componentIds[0]] = {...doc.nodes[made.componentIds[0]], description: 'A shape in a wrapper'};
        comps.push({id: made.componentIds[0], size: subtreeSize(made.componentIds[0]), variants: [], props: []});
      }
      x += 400;
    }
  }

  // A private copy of the file as the components left it, plus a scratch frame: where instances are made (below).
  const scratch = gen('scratch');
  const staging: DesignDocument = structuredClone(doc);
  staging.nodes[scratch] = createNode('FRAME', {id: scratch, parentId: componentsPage, name: 'Scratch'});
  staging.nodes[componentsPage].children!.push(scratch);

  // ── Content: screens of nested frames, sections, groups, booleans, masks, leaves and instance slots ──
  type Open = {id: NodeId; depth: number};
  const open: Open[] = [];
  const slots: {parentId: NodeId; index: number; comp: CompInfo; x: number; y: number}[] = [];
  const screens: NodeId[] = [];
  const settled = Object.keys(doc.nodes).length - added;
  let copies = 0;
  const count = () => settled + added + copies;
  const sectionsOf = new Map<NodeId, NodeId[]>();
  const newScreen = () => {
    const pageId = contentPages[screens.length % contentPages.length];
    let parentId = pageId;
    const i = screens.length;
    if (on('sections') && chance(r, 0.25)) {
      const existing = sectionsOf.get(pageId) ?? [];
      if (existing.length && chance(r, 0.5)) parentId = pick(r, existing);
      else {
        parentId = add('SECTION', pageId, {name: `Section ${existing.length + 1}`, x: (i % 10) * 1600, y: Math.floor(i / 10) * 1200 - 100, width: 1500, height: 1100, fills: [solid({r: 0.95, g: 0.95, b: 0.95})]});
        existing.push(parentId);
        sectionsOf.set(pageId, existing);
      }
    }
    const inSection = parentId !== pageId;
    const id = frame(parentId, {name: `Screen ${i + 1}`, x: inSection ? 40 : (i % 10) * 1600, y: inSection ? 40 : Math.floor(i / 10) * 1200, width: 1440, height: 900, rotation: 0, flipX: undefined, flipY: undefined, clipsContent: true, layoutPositioning: 'AUTO', constraints: {horizontal: 'MIN', vertical: 'MIN'}}, on('autoLayout') && chance(r, 0.7) ? 'VERTICAL' : undefined);
    if (on('prototype') && screens.length && chance(r, 0.3))
      doc.nodes[id] = {...doc.nodes[id], reactions: [{trigger: {type: 'ON_CLICK'}, actions: [{type: 'NODE', navigation: 'NAVIGATE', destinationId: screens[screens.length - 1], transition: {type: 'DISSOLVE', duration: 0.3, easing: 'EASE_OUT'}}]}]};
    if (on('prototype') && !screens.some(s => doc.nodes[s].parentId === pageId)) doc.nodes[pageId] = {...doc.nodes[pageId], flowStartingPoints: [{nodeId: id, name: 'Flow 1'}]};
    screens.push(id);
    open.push({id, depth: 1});
  };
  while (count() < target) {
    if (!open.length || chance(r, 0.02)) {
      newScreen();
      continue;
    }
    const parent = chance(r, 0.7) ? open[open.length - 1 - int(r, Math.min(6, open.length))] : pick(r, open);
    const before = doc.nodes[parent.id].children!.length;
    const roll = r();
    if (roll < 0.12 && parent.depth < 12) {
      const id = frame(parent.id);
      open.push({id, depth: parent.depth + 1});
    } else if (roll < 0.18) {
      group(parent.id);
    } else if (roll < 0.23 && on('booleans')) {
      booleanOp(parent.id);
    } else if (roll < 0.31 && comps.length) {
      const comp = pick(r, comps);
      slots.push({parentId: parent.id, index: before, comp, x: int(r, 400), y: int(r, 300)});
      copies += comp.size;
    } else {
      leaf(parent.id, undefined, {...placement(parent.id, 'RECTANGLE', false), ...(on('masks') && chance(r, 0.02) ? mask() : {})});
    }
  }

  // ── Instances, overrides, property values ──
  // Each instance is made (and its property values set) in a staging copy of the file that holds only the components
  // and a scratch frame, then moved into its slot: the APIs copy the node table they work on, and the full table would
  // make a 20 000-node file quadratic. Normalization syncs every instance in place afterwards.
  const instances: {id: NodeId; comp: CompInfo}[] = [];
  const placed = new Map<NodeId, number>();
  let budget = on('properties') ? Math.min(80, slots.length) : 0;
  for (const slot of slots) {
    const {comp} = slot;
    let made = createInstance(staging, comp.id, {parentId: scratch, newId: gen});
    if (budget > 0 && chance(r, 0.4)) {
      budget--;
      for (const prop of comp.props) {
        if (!chance(r, 0.6)) continue;
        const swaps = comps.filter(c => c.id !== comp.id && !c.variants.length && !c.props.length);
        if (prop.type === 'INSTANCE_SWAP' && !swaps.length) continue;
        const value = prop.type === 'BOOLEAN' ? false : prop.type === 'TEXT' ? words(r, 2) : pick(r, swaps).id;
        try {
          made = {...made, ...setInstanceProperty(made.doc, made.id, prop.key, value)};
        } catch {
          // An INSTANCE_SWAP target the component refuses (a cycle) is skipped.
        }
      }
      for (const variant of comp.variants)
        if (variant.options.length > 1 && chance(r, 0.5)) {
          try {
            made = {...made, ...setInstanceProperty(made.doc, made.id, variant.key, pick(r, variant.options))};
          } catch {
            // A combination no variant has.
          }
        }
    }
    const stack = [made.id];
    while (stack.length) {
      const node = made.doc.nodes[stack.pop()!];
      doc.nodes[node.id] = node.id === made.id ? {...node, parentId: slot.parentId, x: slot.x, y: slot.y} : node;
      if (node.children) stack.push(...node.children);
    }
    const shift = placed.get(slot.parentId) ?? 0;
    const parent = doc.nodes[slot.parentId];
    const children = [...parent.children!];
    children.splice(Math.min(children.length, slot.index + shift), 0, made.id);
    doc.nodes[slot.parentId] = {...parent, children};
    placed.set(slot.parentId, shift + 1);
    instances.push({id: made.id, comp});
  }
  own();
  if (on('overrides')) {
    const set = (id: NodeId, partial: Partial<SceneNode>) => {
      const tracked = withOverrideTracking(doc, id, partial);
      doc.nodes[id] = assignFields(doc.nodes[id], tracked);
    };
    for (const {id} of instances) {
      if (!chance(r, 0.45) || !doc.nodes[id]) continue;
      const copies: NodeId[] = [];
      const stack = [...(doc.nodes[id].children ?? [])];
      while (stack.length) {
        const node = doc.nodes[stack.pop()!];
        if (!node) continue;
        copies.push(node.id);
        if (node.children) stack.push(...node.children);
      }
      if (chance(r, 0.3)) set(id, {fills: [paint(false)]});
      for (let k = 1 + int(r, 3); k > 0 && copies.length; k--) {
        const copy = doc.nodes[pick(r, copies)];
        const roll = r();
        if (copy.type === 'TEXT' && copy.text && roll < 0.5) set(copy.id, {text: insertText(copy.text, 0, copy.text.characters.length, words(r, 1 + int(r, 3)))});
        else if (roll < 0.65) set(copy.id, {fills: [paint(false)]});
        else if (roll < 0.75) set(copy.id, {opacity: r2(range(r, 0.2, 0.9))});
        else if (roll < 0.83) set(copy.id, {visible: !copy.visible});
        else if (roll < 0.9) set(copy.id, {name: `Renamed ${int(r, 99)}`});
        else if (on('effects') && roll < 0.95) set(copy.id, {effects: [effect()]});
        else if (on('variables') && vars.opacity.length) set(copy.id, {boundVariables: {...(copy.boundVariables ?? {}), opacity: {type: 'VARIABLE_ALIAS', id: vars.opacity[0]}}});
        else set(copy.id, {strokes: [solid(color())], strokeWeight: 2});
      }
    }
  }

  // ── Variables through the real APIs on a sample; modes per frame ──
  if (on('variables')) {
    const layers = Object.keys(doc.nodes).filter(id => doc.nodes[id].type !== 'PAGE' && doc.nodes[id].mainId === undefined && doc.nodes[id].type !== 'INSTANCE');
    for (let k = 0; k < Math.min(6, layers.length); k++) {
      const node = doc.nodes[pick(r, layers)];
      try {
        if (node.fills[0]?.type === 'SOLID' && chance(r, 0.5)) doc = bindPaintVariable(doc, node.id, 'fills', 0, pick(r, vars.color)).doc;
        else doc = bindVariable(doc, node.id, 'opacity', pick(r, vars.opacity)).doc;
      } catch {
        // Not bindable on this layer.
      }
    }
    for (let k = 0; k < Math.min(4, screens.length); k++) {
      const collection = pick(r, collections);
      doc = setNodeVariableMode(doc, pick(r, screens), collection.id, collection.modes[1]).doc;
    }
    const frames = layers.filter(id => doc.nodes[id]?.type === 'FRAME');
    if (frames.length) doc = setNodeVariableMode(doc, pick(r, frames), collections[1].id, collections[1].modes[0]).doc;
  }

  return normalizeDocument(doc, new Set(Object.keys(doc.nodes)), {measurer: testMeasurer});
}

/** L1's `randomDocument(seed, parse)` (geometry harness) and L2a's `randomDocument(rng)` (ops harness): a small fuzz document. */
export function randomDocument(seed: number | Rng, parse?: (d: string) => PathCommand[]): DesignDocument {
  const value = typeof seed === 'function' ? Math.floor(seed() * 4294967296) : seed;
  return fuzzDocument(value, {nodes: 60 + (value % 5) * 30, ...(parse ? {parsePathData: parse} : {})});
}

// ── Statistics (what the tests count) ──────────────────────────────────────────────────────────

export type FuzzStats = {
  nodes: number;
  types: Partial<Record<NodeType, number>>;
  autoLayout: number;
  nestedAutoLayout: number;
  instancesWithOverrides: number;
  overriddenCopies: number;
  instanceProperties: number;
  nestedInstances: number;
  componentSets: number;
  componentProperties: number;
  aliases: number;
  boundNodes: number;
  boundPaints: number;
  variableModes: number;
  textRuns: number;
  masks: number;
  booleans: number;
  nestedBooleans: number;
  rotated: number;
  flipped: number;
  effects: number;
  gradients: number;
  images: number;
  styled: number;
};

export function fuzzStats(doc: DesignDocument): FuzzStats {
  const stats: FuzzStats = {
    nodes: 0, types: {}, autoLayout: 0, nestedAutoLayout: 0, instancesWithOverrides: 0, overriddenCopies: 0, instanceProperties: 0, nestedInstances: 0, componentSets: 0, componentProperties: 0,
    aliases: 0, boundNodes: 0, boundPaints: 0, variableModes: Object.keys(doc.variableModes ?? {}).length, textRuns: 0, masks: 0, booleans: 0, nestedBooleans: 0,
    rotated: 0, flipped: 0, effects: 0, gradients: 0, images: 0, styled: 0,
  };
  const auto = (node: SceneNode | undefined) => !!node?.autoLayout && node.autoLayout.layoutMode !== 'NONE';
  const overridden = new Set<NodeId>();
  for (const node of Object.values(doc.nodes)) {
    stats.nodes++;
    stats.types[node.type] = (stats.types[node.type] ?? 0) + 1;
    const parent = node.parentId ? doc.nodes[node.parentId] : undefined;
    if (auto(node)) {
      stats.autoLayout++;
      if (auto(parent)) stats.nestedAutoLayout++;
    }
    if (node.type === 'COMPONENT_SET') stats.componentSets++;
    stats.componentProperties += Object.keys(node.componentPropertyDefinitions ?? {}).length;
    if (node.type === 'INSTANCE' && node.mainId !== undefined) stats.nestedInstances++;
    if (node.type === 'INSTANCE' && node.overrides?.some(path => path.startsWith('componentProperties.'))) stats.instanceProperties++;
    if (node.overrides?.length) {
      if (node.mainId !== undefined) stats.overriddenCopies++;
      let root: SceneNode | undefined = node;
      while (root && root.mainId !== undefined) root = root.parentId ? doc.nodes[root.parentId] : undefined;
      if (root?.type === 'INSTANCE') overridden.add(root.id);
    }
    if (node.boundVariables && Object.keys(node.boundVariables).length) stats.boundNodes++;
    for (const p of [...node.fills, ...node.strokes]) {
      if (p.type === 'SOLID' && p.boundVariables?.color) stats.boundPaints++;
      if (p.type.startsWith('GRADIENT')) stats.gradients++;
      if (p.type === 'IMAGE') stats.images++;
    }
    stats.textRuns += node.text?.runs.length ?? 0;
    if (node.isMask) stats.masks++;
    if (node.type === 'BOOLEAN_OPERATION') {
      stats.booleans++;
      if (parent?.type === 'BOOLEAN_OPERATION') stats.nestedBooleans++;
    }
    if (node.rotation) stats.rotated++;
    if (node.flipX || node.flipY) stats.flipped++;
    if (node.effects.length) stats.effects++;
    if (node.fillStyleId || node.textStyleId || node.effectStyleId || node.gridStyleId) stats.styled++;
  }
  stats.instancesWithOverrides = overridden.size;
  for (const variable of Object.values(doc.variables)) for (const value of Object.values(variable.valuesByMode)) if (typeof value === 'object' && 'type' in value && value.type === 'VARIABLE_ALIAS') stats.aliases++;
  return stats;
}

// ── Patches: one person's edit as a real transaction ───────────────────────────────────────────

const CONTEXT = {measurer: testMeasurer};
const isCopy = (node: SceneNode | undefined) => node?.mainId !== undefined;
type Pools = {hot: NodeId[]; own: NodeId[]};
type EditState = {tx: Transaction; r: Rng; pools: Pools; fresh: (kind: string) => string};

/** A layer to edit: from the hot set both sides share now and then (overlap), otherwise from this side's own half. */
function target(state: EditState, filter: (node: SceneNode) => boolean = () => true): SceneNode | undefined {
  const {tx, r, pools} = state;
  for (const pool of chance(r, 0.4) ? [pools.hot, pools.own] : [pools.own, pools.hot]) {
    for (let tries = 0; tries < 8 && pool.length; tries++) {
      const node = tx.get(pick(r, pool));
      if (node && node.type !== 'PAGE' && filter(node)) return node;
    }
  }
  return undefined;
}
/** Containers a new layer may go into: not instances or their copies, not variant sets, groups or booleans. */
const holderOk = (node: SceneNode) => !!node.children && !isCopy(node) && node.type !== 'INSTANCE' && node.type !== 'COMPONENT_SET' && node.type !== 'GROUP' && node.type !== 'BOOLEAN_OPERATION' && node.type !== 'PAGE';
const removable = (tx: Transaction, node: SceneNode) => {
  if (node.children || isCopy(node) || node.type === 'PAGE') return false;
  const parent = tx.get(node.parentId!);
  return !!parent && !isCopy(parent) && parent.type !== 'INSTANCE' && ((parent.type !== 'GROUP' && parent.type !== 'BOOLEAN_OPERATION') || parent.children!.length > 1);
};

type Edit = (state: EditState) => void;
const EDITS: [Edit, number][] = [
  // Fields.
  [s => {
    const {tx, r} = s;
    const node = target(s);
    if (node) tx.update(node.id, {x: r2(node.x + int(r, 60) - 30), y: r2(node.y + int(r, 40) - 20)});
  }, 3],
  [s => {
    const {tx, r} = s;
    const node = target(s, n => !isCopy(n));
    if (node) tx.update(node.id, {name: words(r, 2), opacity: pick(r, [0.25, 0.5, 1])});
  }, 2],
  [s => {
    const {tx, r} = s;
    const node = target(s, n => !isCopy(n));
    if (!node) return;
    const styles = Object.values(tx.doc.styles).filter(style => style.type === 'FILL');
    const style = styles.length && chance(r, 0.3) ? pick(r, styles) : undefined;
    tx.update(node.id, {fills: style ? style.paints!.map(p => ({...p})) : [solid({r: r2(r()), g: r2(r()), b: r2(r())})], fillStyleId: style?.id});
  }, 2],
  [s => {
    const {tx, r} = s;
    const node = target(s, n => !isCopy(n));
    if (node) tx.update(node.id, {rotation: int(r, 360) - 180, flipY: chance(r, 0.3) ? true : undefined});
  }, 1],
  [s => {
    const {tx, r} = s;
    const node = target(s, n => !isCopy(n));
    if (node) tx.update(node.id, {constraints: {...node.constraints, [pick(r, ['horizontal', 'vertical'])]: pick(r, ['MIN', 'MAX', 'CENTER', 'STRETCH', 'SCALE'])}});
  }, 1],
  [s => {
    const {tx, r} = s;
    const node = target(s, n => n.type === 'FRAME' && !isCopy(n));
    if (node) tx.update(node.id, {autoLayout: {...(node.autoLayout ?? defaultAutoLayout('HORIZONTAL')), [pick(r, ['itemSpacing', 'paddingLeft', 'paddingTop'])]: int(r, 24)}});
  }, 1],
  [s => {
    const {tx, r} = s;
    const node = target(s, n => !isCopy(n));
    if (node) tx.update(node.id, {pluginData: {...(node.pluginData ?? {}), [pick(r, ['k1', 'k2', 'k3'])]: words(r, 1)}});
  }, 1],
  [s => {
    const {tx, r} = s;
    const node = target(s, n => !isCopy(n));
    const floats = Object.values(tx.doc.variables).filter(v => v.type === 'FLOAT' && v.name.startsWith('Opacity'));
    if (node && floats.length) tx.update(node.id, {boundVariables: {...(node.boundVariables ?? {}), opacity: {type: 'VARIABLE_ALIAS', id: pick(r, floats).id}}});
  }, 1],
  [s => {
    const {tx, r} = s;
    const node = target(s, n => !isCopy(n));
    if (!node) return;
    const list = [...(node.annotations ?? [])].filter(entry => entry.id !== 'e1');
    if (chance(r, 0.7)) list.push({id: 'e1', label: words(r, 2)});
    tx.update(node.id, {annotations: list.length ? list : undefined});
  }, 1],
  // Overrides on instance copies, recorded as the editor records them.
  [s => {
    const {tx, r} = s;
    const node = target(s, n => isCopy(n));
    if (!node) return;
    const partial: Partial<SceneNode> = node.type === 'TEXT' && node.text && chance(r, 0.6) ? {text: insertText(node.text, 0, node.text.characters.length, words(r, 2))} : chance(r, 0.5) ? {fills: [solid({r: r2(r()), g: 0.5, b: 0.5})]} : {opacity: pick(r, [0.3, 0.6])};
    tx.update(node.id, withOverrideTracking(tx.doc, node.id, partial));
  }, 2],
  // Text.
  [s => {
    const {tx, r} = s;
    const node = target(s, n => n.type === 'TEXT' && !!n.text && !isCopy(n) && !n.boundVariables?.characters);
    if (!node) return;
    const t = node.text!, length = t.characters.length;
    const start = int(r, length + 1);
    tx.update(node.id, {text: insertText(t, start, Math.min(length, start + int(r, 3)), chance(r, 0.2) ? '' : words(r, 1))});
  }, 2],
  [s => {
    const {tx, r} = s;
    const node = target(s, n => n.type === 'TEXT' && !!n.text && !isCopy(n) && n.text.characters.length > 1);
    if (!node) return;
    const length = node.text!.characters.length, start = int(r, length - 1);
    tx.update(node.id, {text: applyStyleToRange(node.text!, start, start + 1 + int(r, length - start - 1), {fontSize: pick(r, [12, 18, 24])})});
  }, 1],
  // Structure: creates under existing parents, leaf removes, moves, reorders.
  [s => {
    const {tx, r, fresh} = s;
    const parent = target(s, holderOk) ?? tx.get(pick(r, tx.doc.pages))!;
    const type = pick(r, ['RECTANGLE', 'ELLIPSE', 'TEXT', 'STAR', 'LINE'] as const);
    const node = createNode(type, {id: fresh('n'), x: int(r, 300), y: int(r, 300), width: 10 + int(r, 90), height: type === 'LINE' ? 0 : 10 + int(r, 90), ...(type === 'TEXT' ? {text: defaultTextProps(words(r, 2))} : {})});
    tx.create(node, parent.id, chance(r, 0.5) ? int(r, (parent.children?.length ?? 0) + 1) : undefined);
  }, 2],
  [s => {
    const {tx, r} = s;
    const node = target(s, n => removable(tx, n));
    if (node) tx.remove(node.id);
  }, 2],
  [s => {
    const {tx, r} = s;
    const node = target(s, n => removable(tx, n));
    const parent = target(s, holderOk);
    if (node && parent && parent.id !== node.parentId) tx.move(node.id, parent.id, undefined, {keepWorld: chance(r, 0.8)});
  }, 1],
  [s => {
    const {tx, r} = s;
    const node = target(s, n => !isCopy(n) && !!n.parentId && !isCopy(tx.get(n.parentId)) && tx.get(n.parentId)?.type !== 'INSTANCE');
    if (node) tx.reorder(node.id, int(r, tx.get(node.parentId!)!.children!.length));
  }, 2],
  // Pages.
  [({tx, r}) => {
    const pages = [...tx.doc.pages];
    for (let i = pages.length - 1; i > 0; i--) {
      const j = int(r, i + 1);
      [pages[i], pages[j]] = [pages[j], pages[i]];
    }
    tx.setPages(pages);
  }, 1],
  [({tx, r, fresh}) => tx.addPage(createNode('PAGE', {id: fresh('p'), name: words(r, 1)}), int(r, tx.doc.pages.length + 1)), 0.3],
  // Tables.
  [({tx, r, fresh}) => {
    const fills = Object.values(tx.doc.styles).filter(style => style.type === 'FILL');
    const edit = fills.length && chance(r, 0.6) ? pick(r, fills) : undefined;
    tx.setStyle({id: edit?.id ?? fresh('s'), type: 'FILL', name: edit ? `${edit.name} ${int(r, 9)}` : `New/${words(r, 1)}`, description: chance(r, 0.5) ? '' : 'Changed', paints: [solid({r: r2(r()), g: 0, b: 0})]});
  }, 1],
  [({tx, r, fresh}) => tx.setImage(fresh('img'), {url: `/uploads/${fresh('file')}.png`, width: 10 + int(r, 500), height: 10 + int(r, 500)}), 0.3],
  [({tx, r, fresh}) => {
    const list = Object.values(tx.doc.variables).filter(v => v.type === 'FLOAT' && !Object.values(v.valuesByMode).some(value => typeof value === 'object'));
    const collections = Object.values(tx.doc.variableCollections);
    if (list.length && chance(r, 0.7)) {
      const variable = pick(r, list);
      const collection = tx.doc.variableCollections[variable.collectionId];
      tx.setVariable({...variable, valuesByMode: {...variable.valuesByMode, [pick(r, collection.modes).modeId]: int(r, 100)}});
    } else if (collections.length) {
      const collection = pick(r, collections);
      tx.setVariable({id: fresh('v'), name: `New ${int(r, 1000)}`, collectionId: collection.id, type: 'FLOAT', valuesByMode: Object.fromEntries(collection.modes.map(mode => [mode.modeId, int(r, 50)])), description: ''});
    }
  }, 1],
  [s => {
    const {tx, r} = s;
    const node = target(s, n => n.type === 'FRAME' && !isCopy(n));
    const collections = Object.values(tx.doc.variableCollections);
    if (node && collections.length) {
      const collection = pick(r, collections);
      tx.setVariableModes(node.id, chance(r, 0.2) ? null : {[collection.id]: pick(r, collection.modes).modeId});
    }
  }, 1],
];

const ownIds = (doc: DesignDocument) => Object.keys(doc.nodes).filter(id => doc.nodes[id].type !== 'PAGE');

function edit(base: DesignDocument, r: Rng, pools: Pools, fresh: (kind: string) => string, steps: number): {doc: DesignDocument; patch: DocumentPatch} {
  const tx = beginTransaction(base);
  const state: EditState = {tx, r, pools, fresh};
  for (let i = 0; i < steps; i++) {
    try {
      weighted(r, EDITS)(state);
    } catch (error) {
      if ((error as Error).name !== 'TransactionError') throw error;
    }
  }
  const result = tx.commit(CONTEXT);
  return {doc: result.doc, patch: result.patch};
}

const freshIds = (tag: string) => {
  let n = 0;
  return (kind: string) => `${tag}-${kind}${(++n).toString(36)}`;
};

/** One person's edit of `doc` (a few operations in one committed transaction), deterministic by seed. */
export function fuzzPatch(doc: DesignDocument, seed = 1, options: {steps?: number} = {}): DocumentPatch {
  return fuzzEdit(doc, seed, options).patch;
}
export function fuzzEdit(doc: DesignDocument, seed = 1, options: {steps?: number} = {}): {doc: DesignDocument; patch: DocumentPatch} {
  const r = mulberry32(seed ^ 0x51ed270b);
  const ids = ownIds(doc);
  return edit(doc, r, {hot: [], own: ids}, freshIds(`e${(seed >>> 0).toString(36)}`), options.steps ?? 1 + int(r, 6));
}

/** Two concurrent patches of the same base: a shared hot set of nodes both may touch, and disjoint halves. */
export function fuzzPatchPair(doc: DesignDocument, seed = 1, options: {steps?: number} = {}): {a: DocumentPatch; b: DocumentPatch; docA: DesignDocument; docB: DesignDocument} {
  const r = mulberry32(seed ^ 0x2545f491);
  const ids = ownIds(doc);
  const hot = Array.from({length: Math.min(ids.length, 3 + int(r, 5))}, () => pick(r, ids));
  const half = (parity: number) => ids.filter((_, i) => i % 2 === parity);
  const steps = () => options.steps ?? 2 + int(r, 6);
  const tag = (seed >>> 0).toString(36);
  const a = edit(doc, mulberry32(seed * 2 + 1), {hot, own: half(0)}, freshIds(`a${tag}`), steps());
  const b = edit(doc, mulberry32(seed * 2 + 2), {hot, own: half(1)}, freshIds(`b${tag}`), steps());
  return {a: a.patch, b: b.patch, docA: a.doc, docB: b.doc};
}

/** L2a's `randomEdit(base, rng)`. */
export function randomEdit(base: DesignDocument, rng: Rng): {doc: DesignDocument; patch: DocumentPatch} {
  return fuzzEdit(base, Math.floor(rng() * 4294967296));
}
/** L2a's `patchPair(base, rng)`: `{theirs, ours}`, each `{doc, patch}` against `base`. */
export function patchPair(base: DesignDocument, rng: Rng) {
  const pair = fuzzPatchPair(base, Math.floor(rng() * 4294967296));
  return {theirs: {doc: pair.docA, patch: pair.a}, ours: {doc: pair.docB, patch: pair.b}};
}

/** `count` edits in a row from `doc` (the shadow document's run of commits): each step's patch is against the previous doc. */
export function* fuzzCommits(doc: DesignDocument, count: number, seed = 1): Generator<{doc: DesignDocument; patch: DocumentPatch; step: number}> {
  let current = doc;
  for (let step = 0; step < count; step++) {
    const next = fuzzEdit(current, seed * 1_000_003 + step);
    current = next.doc;
    yield {...next, step};
  }
}
