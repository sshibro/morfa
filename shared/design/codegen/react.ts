import type {DesignDocument, ImageRef, NodeId} from '../types';
import type {TextMeasurer} from '../text-layout';
import {PRODUCT_NAME} from '../product';
import {defaultAssetPath, type Decl, type DeclContext} from './css';
import {DEFAULT_FORMAT, formatValue, type CodeFormat} from './format';
import {mergeVariants, type UChild, type UEl, type UPiece} from './merge';
import {componentModel, optionLiteral, propComment, propType, stateApi, type ComponentModel, type InteractiveState, type PropDef} from './model';
import {NameRegistry, componentName, memberName, pluralName, singularName, slugName} from './names';
import {headingLevels} from './semantics';
import {restSpace, type Space} from './space';
import {elementStyle, optionIds, type Cond, type ElementStyle} from './style-rules';
import {inlineSvg, isVectorGraphic, svgChildrenJsx, svgKey, type InlineSvg} from './svg';
import {tailwindClasses, type TailwindOptions} from './tailwind';
import {collectTokens, suggestTokens, tailwindTheme, tokensCss, tokensTs, type TokenTable} from './tokens';
import {ASSET_MARK, SVG_ID_PREFIX, assetMark, buildElement, componentRoot, type Attr, type BuildHost, type BuildScope, type El, type FieldRole, type Piece} from './tree';
import {presenceCondition, switchExpression} from './variant-logic';
import {fontFamilyCss, guessFallback, num} from './values';
import {VUE_RESERVED, exprIdents, isSlotValue, jsxUsageToVue, sfc, slotTemplates, svgChildrenVue, vueAttr, vueExpr, vueText, vueUsageSnippet} from './vue';

// Design → React (docs/design-tool.md §Design to code), written the way a front-end team writes it:
// - Components are typed function components over their native element's props (`ComponentPropsWithRef<'button'>`,
//   forwarded with `{...props}`, so `onClick`, `aria-*`, `ref` and `disabled` just work). A button's one label is its
//   `children`, a field's text is its `placeholder`, and a show/hide toggle merged with its text or icon makes it optional.
// - Variants are props; interaction states are not: hover, pressed, focus and disabled variants become `:hover`,
//   `:active`, `:focus-visible` and `:disabled` rules of the looks they belong to.
// - Styling is CSS Modules (variant props as data attributes on the root, `[data-size='small'] .label`), Tailwind CSS 4
//   (utilities, variant maps, `hover:`/`group-hover:`) or inline styles. Identical rules share one class; class names
//   come from what layers are for, never from the text they show.
// - Frames that are not components become screens; siblings that repeat one structure become a typed data array and
//   a `.map()`; texts follow the screen's heading outline. Vectors are icon components in src/icons, pictures assets.
// The output is deterministic: the same document always gives the same files.
//
// The same pipeline writes Vue 3 (`toVue`): one single-file component per component and screen, `<script setup lang="ts">`
// with typed props, the label and instance swaps as slots, attributes falling through to the root as Vue does, and the
// three stylings as `<style module>`, Tailwind classes or style objects.

export type Styling = 'css-modules' | 'tailwind' | 'inline';
export type Framework = 'react' | 'vue';

export type ReactOptions = {
  styling?: Styling;
  /** Text measurement for vectors exported as SVG (only text-free vectors are; a rough default is fine). */
  measurer?: TextMeasurer;
  fontFallback?: (family: string) => string | undefined;
  /** Write tokens.css/tokens.ts when the code uses a token ('used', default) or whenever the file has tokens. */
  tokens?: 'used' | 'always';
  /** Units and colour format of the values (the "Code" tab's settings). */
  format?: CodeFormat;
  /** A raw colour equal to a colour token's value is written as that token (Figma's "suggested variables"; default on). */
  suggestTokens?: boolean;
  /** React function components (default) or Vue single-file components (`toVue`). */
  framework?: Framework;
};

export type GeneratedFile = {path: string; contents: string};
export type AssetFile = {path: string; ref: ImageRef; url: string};

export type PropInfo = {
  name: string;
  type: string;
  defaultValue: string | null;
  original: string;
  kind: string;
  comment: string;
  /** The usage must give it (a text prop). */
  required: boolean;
  /** One of the element's own props (`children`, `disabled`, `placeholder`), declared by React's types. */
  native: boolean;
  /** A variant prop's options as code writes them (`'small'`, `40`, `true`); the designer's name of each in `labels`. */
  options?: string[];
  labels?: string[];
};
export type ComponentInfo = {
  name: string;
  nodeId: NodeId;
  kind: 'component' | 'screen';
  /** Files of this component, the .tsx first. */
  files: string[];
  props: PropInfo[];
  /** For an instance selected as a root: how it is used. */
  usage?: string;
  /** JSX of the component in each of its looks (the project's component page). */
  examples?: string[];
  /** The element whose props the component takes. */
  element?: string;
  /** Interaction states the component draws as CSS (hover, active, focus, disabled). */
  states?: InteractiveState[];
  /** Each state's selector on the root as the stylesheet writes it (`:disabled` on a button, `[aria-disabled='true']` on a
   *  div, `:focus-within` on a field). */
  stateSelectors?: Partial<Record<InteractiveState, string>>;
};

export type ReactResult = {
  files: GeneratedFile[];
  assets: AssetFile[];
  /** Every component and screen written, roots first. */
  components: ComponentInfo[];
  /** The roots, in the order asked. */
  entries: ComponentInfo[];
  tokens: TokenTable;
  warnings: string[];
};

/** Names the generated code itself uses at the top of files. */
const RESERVED = ['React', 'Fragment', 'App', 'StrictMode', 'ReactNode', 'SVGProps', 'CSSProperties', 'ComponentPropsWithRef', 'ComponentType', 'styles', 'cx', 'tokens', 'screens', 'createRoot', 'useState', 'useId', 'props'];

const CX_FILE = 'src/lib/cx.ts';
const CX_SOURCE = `/** Joins class names, leaving out the empty ones. */
export function cx(...names: (string | false | null | undefined)[]): string {
  return names.filter(Boolean).join(' ');
}
`;

/** Roots for code: a page means its top-level layers; a variant means its set. */
export function expandRoots(doc: DesignDocument, ids: readonly NodeId[]): NodeId[] {
  const out: NodeId[] = [];
  const push = (id: NodeId) => {
    if (!out.includes(id)) out.push(id);
  };
  for (const id of ids) {
    const node = doc.nodes[id];
    if (!node) continue;
    if (node.type === 'PAGE') {
      for (const child of node.children ?? []) if (doc.nodes[child]?.visible !== false && doc.nodes[child]?.type !== 'SLICE') push(child);
    } else if (node.type === 'COMPONENT') push(componentRoot(doc, id) ?? id);
    else if (node.type !== 'SLICE') push(id);
  }
  return out;
}

/** Icon components shared by the whole output: one file per picture. */
class Icons {
  private readonly byKey = new Map<string, {name: string; path: string; svg: InlineSvg}>();
  private readonly names: NameRegistry;
  constructor(private readonly components: NameRegistry, private readonly framework: Framework = 'react') {
    this.names = new NameRegistry(framework === 'vue' ? [...RESERVED, ...VUE_RESERVED] : RESERVED);
  }

  /** The icon component drawing `svg` (named after the layer, or its parent when the layer's name is generic). */
  get(svg: InlineSvg, hint: string): string {
    const key = svgKey(svg);
    let icon = this.byKey.get(key);
    if (!icon) {
      const base = componentName(hint, 'Vector');
      const wanted = /(Icon|Svg|Logo)$/.test(base) ? base : base + 'Icon';
      let name = this.names.claim(wanted);
      while (this.components.has(name)) name = this.names.claim(wanted);
      this.components.reserve(name);
      icon = {name, path: `src/icons/${name}.${this.framework === 'vue' ? 'vue' : 'tsx'}`, svg};
      this.byKey.set(key, icon);
    }
    return icon.name;
  }

  files(): GeneratedFile[] {
    return [...this.byKey.values()].map(icon => {
      const prefix = icon.name.replace(/([a-z0-9])([A-Z])/g, '$1-$2').toLowerCase();
      const {svg} = icon;
      if (this.framework === 'vue') {
        // Attributes a usage gives (a class, a size, aria-hidden="false") fall through to the <svg>, as in any component.
        const lines = [
          '<template>',
          `  <svg width="${num(svg.box.width, 3)}" height="${num(svg.box.height, 3)}" viewBox="${svg.viewBox}" fill="none" overflow="visible" aria-hidden="true">`,
          ...svgChildrenVue(svg.root, '    ').map(line => line.split(`${SVG_ID_PREFIX}-`).join(`${prefix}-`)),
          '  </svg>',
          '</template>',
        ];
        return {path: icon.path, contents: lines.join('\n') + '\n'};
      }
      const lines = [
        "import type {SVGProps} from 'react';",
        '',
        `export function ${icon.name}(props: SVGProps<SVGSVGElement>) {`,
        '  return (',
        `    <svg width="${num(svg.box.width, 3)}" height="${num(svg.box.height, 3)}" viewBox="${svg.viewBox}" fill="none" overflow="visible" aria-hidden="true" {...props}>`,
        ...svgChildrenJsx(svg.root, '      ').map(line => line.split(`${SVG_ID_PREFIX}-`).join(`${prefix}-`)),
        '    </svg>',
        '  );',
        '}',
      ];
      return {path: icon.path, contents: lines.join('\n') + '\n'};
    });
  }
}

/** The same output as Vue 3 single-file components (`src/components/Button.vue`, `src/screens/Home.vue`, `src/icons/*.vue`). */
export function toVue(doc: DesignDocument, rootIds: readonly NodeId[], options: Omit<ReactOptions, 'framework'> = {}): ReactResult {
  return toReact(doc, rootIds, {...options, framework: 'vue'});
}

export function toReact(doc: DesignDocument, rootIds: readonly NodeId[], options: ReactOptions = {}): ReactResult {
  const styling = options.styling ?? 'css-modules';
  const framework = options.framework ?? 'react';
  const vue = framework === 'vue';
  const format = options.format ?? DEFAULT_FORMAT;
  const fallback = (family: string) => options.fontFallback?.(family) ?? guessFallback(family);
  const baseTokens = collectTokens(doc, {fontFallback: options.fontFallback});
  const tokens = options.suggestTokens === false ? baseTokens : suggestTokens(baseTokens);
  const names = new NameRegistry(vue ? [...RESERVED, ...VUE_RESERVED] : RESERVED);
  const assets = new Map<ImageRef, AssetFile>();
  const assetNames = new NameRegistry();
  const warnings = new Set<string>();
  const models = new Map<NodeId, ComponentModel>();
  const queue: NodeId[] = [];
  const headings = new Map<NodeId, number>();
  const icons = new Icons(names, framework);
  const css: DeclContext = {doc, tokens, fallback, asset: assetMark, root: false};
  const host: BuildHost = {
    doc,
    css,
    measurer: options.measurer,
    warn: message => warnings.add(message),
    headings,
    component(id) {
      let model = models.get(id);
      if (!model) {
        model = componentModel(doc, id, names);
        models.set(id, model);
        queue.push(id);
      }
      return model;
    },
  };
  const assetFor = (ref: ImageRef): AssetFile => {
    let asset = assets.get(ref);
    if (!asset) {
      const base = defaultAssetPath(doc, ref).replace(/^assets\//, '');
      const dot = base.lastIndexOf('.');
      const file = assetNames.claim(base.slice(0, dot)) + base.slice(dot);
      asset = {path: `src/assets/${file}`, ref, url: doc.images[ref]?.url ?? ''};
      assets.set(ref, asset);
    }
    return asset;
  };

  const files: GeneratedFile[] = [];
  const infos = new Map<NodeId, ComponentInfo>();
  const entries: ComponentInfo[] = [];
  const screens: {id: NodeId; name: string}[] = [];
  const instanceRoots: {id: NodeId; target: NodeId}[] = [];
  let cx = false;

  for (const id of expandRoots(doc, rootIds)) {
    const node = doc.nodes[id];
    // A layer that is only a picture (a logo, an icon drawn on the page) is its icon component, nothing around it.
    if (node.type !== 'COMPONENT' && node.type !== 'COMPONENT_SET' && node.type !== 'INSTANCE' && isVectorGraphic(doc, id)) {
      const svg = inlineSvg(doc, id, {measurer: options.measurer, idPrefix: SVG_ID_PREFIX});
      if (svg) {
        const name = icons.get(svg, node.name);
        infos.set(id, {name, nodeId: id, kind: 'component', files: [`src/icons/${name}.${vue ? 'vue' : 'tsx'}`], props: [], element: 'svg'});
        continue;
      }
    }
    if (node.type === 'COMPONENT_SET' || node.type === 'COMPONENT') host.component(id);
    else if (node.type === 'INSTANCE' && componentRoot(doc, node.componentId)) {
      const target = componentRoot(doc, node.componentId)!;
      host.component(target);
      instanceRoots.push({id, target});
    } else screens.push({id, name: names.claim(componentName(node.name, 'Screen'))});
  }

  const families = new Map<string, string>();
  // Tailwind: the family most texts use is the theme's sans, so no text repeats it.
  const baseFamily = styling === 'tailwind' ? dominantFamily(doc, expandRoots(doc, rootIds), fallback) : null;
  const shared: Shared = {styling, framework, tokens, assetFor, icons, format, families, baseFamily, models, warn: message => warnings.add(message)};

  for (const screen of screens) {
    const node = doc.nodes[screen.id];
    for (const [id, level] of headingLevels(doc, screen.id, true)) headings.set(id, level);
    const scope: BuildScope = {model: null, used: new Set()};
    const tree = buildElement(host, scope, node, 'root', {root: true, inline: false});
    const writer = new ModuleWriter(shared, 'screen', screen.name, null, restSpace(null), host, node.name, screenLike(doc, screen.id));
    const info: ComponentInfo = {name: screen.name, nodeId: screen.id, kind: 'screen', files: writer.paths(), props: []};
    files.push(...writer.write(mergeVariants([tree], {defaultIndex: 0}), scope));
    cx ||= writer.usesCx;
    infos.set(screen.id, info);
  }

  for (let i = 0; i < queue.length; i++) {
    const id = queue[i];
    const model = models.get(id)!;
    const scope: BuildScope = {model, used: new Set()};
    const trees = model.variants.map(variant => {
      const node = doc.nodes[variant.nodeId];
      if (!node) return null;
      for (const [text, level] of headingLevels(doc, variant.nodeId, false)) headings.set(text, level);
      return buildElement(host, scope, node, 'root', {root: true, inline: false});
    });
    const space = restSpace(model);
    const writer = new ModuleWriter(shared, 'component', model.name, model, space, host, doc.nodes[id].name, false);
    // A shared library's component (docs/design-tool.md §Teams) is written from the file's read-only copy like a local one, so the
    // project builds on its own; its header says where it comes from and that it changes in the library's file.
    const remote = doc.nodes[id].remote;
    const note = remote ? `A shared library component (version ${remote.version}): change it in the library file; this is a copy of it.` : undefined;
    files.push(...writer.write(mergeVariants(trees, model), scope, note));
    cx ||= writer.usesCx;
    infos.set(id, {
      name: model.name, nodeId: id, kind: 'component', files: writer.paths(), props: apiProps(host, model, writer.element, framework),
      examples: examplesOf(host, model, space, framework), element: writer.element, states: model.state ? [...model.state.states] : [],
      stateSelectors: Object.fromEntries([...model.state?.states ?? []].map(state => [state, writer.stateSelector(state, false)])),
    });
  }

  for (const id of expandRoots(doc, rootIds)) {
    const node = doc.nodes[id];
    const instance = instanceRoots.find(entry => entry.id === id);
    if (instance) {
      const info = infos.get(instance.target)!;
      const scope: BuildScope = {model: null, used: new Set()};
      const parent = node.parentId ? doc.nodes[node.parentId] : undefined;
      const usage = buildElement(host, scope, {...node, parentId: parent?.type === 'PAGE' ? node.parentId : null}, 'usage', {root: false, inline: false});
      entries.push({...info, usage: usage ? (vue ? vueUsageSnippet(usage, vueHiddenOf(models)) : usageSnippet(usage)) : undefined});
    } else {
      const info = infos.get(node.type === 'COMPONENT' ? componentRoot(doc, id) ?? id : id);
      if (info) entries.push(info);
    }
  }

  files.push(...icons.files());
  if (cx) files.push({path: CX_FILE, contents: CX_SOURCE});
  // Tokens come along when the code uses them (or always, for a project): Tailwind reads them from its theme.
  if (styling === 'tailwind') {
    const theme = tailwindTheme(tokens, families, {format, sans: baseFamily});
    if (theme) files.push({path: 'src/theme.css', contents: theme});
    if (theme && tokens.tokens.length) files.push({path: 'src/tokens.ts', contents: tokensTs(tokens)});
  } else {
    const cssText = tokensCss(tokens, {format});
    if (cssText && (options.tokens === 'always' || files.some(f => f.contents.includes('var(--')))) {
      files.push({path: 'src/tokens.css', contents: cssText});
      files.push({path: 'src/tokens.ts', contents: tokensTs(tokens)});
    }
  }
  const components = [...entries, ...[...infos.values()].filter(info => !entries.some(entry => entry.nodeId === info.nodeId))];
  return {files, assets: [...assets.values()], components, entries, tokens, warnings: [...warnings]};
}

/** The family most of the written texts are set in, as CSS (`'Inter', sans-serif`), or null without text. */
function dominantFamily(doc: DesignDocument, roots: readonly NodeId[], fallback: (family: string) => string): string | null {
  const counts = new Map<string, number>();
  const stack = [...roots];
  for (let visited = 0; stack.length && visited < 20_000; visited++) {
    const node = doc.nodes[stack.pop()!];
    if (!node) continue;
    if (node.text) counts.set(node.text.style.fontFamily, (counts.get(node.text.style.fontFamily) ?? 0) + Math.max(1, node.text.characters.length));
    if (node.type === 'INSTANCE' && node.componentId) stack.push(node.componentId);
    if (node.children) stack.push(...node.children);
  }
  const top = [...counts].sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0]))[0];
  return top ? fontFamilyCss(top[0], fallback(top[0])) : null;
}

/** A top-level frame shaped like a device or a page (square corners, no shadow; a phone's proportions or a desktop's width): its
 *  root fills the viewport instead of keeping the frame's pixels. A card standing on the page is not one. */
function screenLike(doc: DesignDocument, id: NodeId): boolean {
  const node = doc.nodes[id];
  const parent = node?.parentId ? doc.nodes[node.parentId] : undefined;
  if (!node || parent?.type !== 'PAGE' || (node.type !== 'FRAME' && node.type !== 'SECTION')) return false;
  if ((node.cornerRadius ?? 0) > 0 || node.rectangleCornerRadii?.some(radius => radius > 0) || node.effects.some(effect => effect.visible !== false && effect.type === 'DROP_SHADOW')) return false;
  return node.width >= 1024 || (node.width >= 320 && node.height / node.width >= 1.5);
}

// ── The component's API ────────────────────────────────────────────────────────────────────────

/** A JS string literal in single quotes: quotes, backslashes and line breaks escaped. */
const singleQuoted = (text: string) =>
  `'${text.replace(/[\\'\n\r\u2028\u2029]/g, char => (char === '\\' ? '\\\\' : char === "'" ? "\\'" : char === '\n' ? '\\n' : char === '\r' ? '\\r' : char === '\u2028' ? '\\u2028' : '\\u2029'))}'`;

const NATIVE_DISABLED = new Set(['button', 'input', 'select', 'textarea', 'fieldset']);

/** The props of a component as its users see them, the native ones it relies on included. */
function apiProps(host: BuildHost, model: ComponentModel, element: string, framework: Framework = 'react'): PropInfo[] {
  const out = reactApiProps(host, model, element);
  if (framework !== 'vue') return out;
  // Vue: the label is the default slot and an instance swap a named slot (its default template markup, its show/hide
  // boolean a prop of its own when it has a default).
  return out.flatMap(prop => {
    if (prop.kind !== 'slot' && !(prop.native && prop.name === 'children')) return [prop];
    const slot = {...prop, name: prop.kind === 'slot' ? prop.name : 'default', type: 'slot', defaultValue: prop.defaultValue && jsxUsageToVue(prop.defaultValue)};
    const toggle = prop.kind === 'slot' ? vueToggle(model, prop.name) : null;
    return toggle ? [slot, infoOf(host, toggle)] : [slot];
  });
}

function reactApiProps(host: BuildHost, model: ComponentModel, element: string): PropInfo[] {
  const out: PropInfo[] = [];
  const state = model.state ? model.variantProps[model.state.prop] : null;
  for (const prop of model.props) {
    if (prop === state) {
      const api = stateApi(model);
      if (api.prop) out.push(infoOf(host, api.prop));
      if (api.disabled) out.push({name: 'disabled', type: 'boolean', defaultValue: 'false', original: `${prop.original}: ${prop.options.find(o => model.state!.of.get(o.id) === 'disabled')?.value ?? ''}`, kind: 'disabled', comment: '', required: false, native: NATIVE_DISABLED.has(element)});
      continue;
    }
    if (prop.kind === 'boolean' && prop.mergedInto) continue;
    out.push(infoOf(host, prop));
  }
  return out;
}

function infoOf(host: BuildHost, prop: PropDef): PropInfo {
  const native = prop.native ?? null;
  return {
    name: prop.jsName, type: propType(prop), defaultValue: defaultExpression(host, prop), original: prop.original, kind: prop.kind, comment: propComment(prop),
    required: prop.kind === 'text' && !prop.optional && !native, native: !!native,
    ...(prop.kind === 'variant' ? {options: prop.options.map(option => optionLiteral(prop, option.id)), labels: prop.options.map(option => option.value)} : {}),
  };
}

/** The default in the destructuring: variant and boolean defaults, a slot's default component; texts have none (the
 *  usage gives them). */
function defaultExpression(host: BuildHost, prop: PropDef): string | null {
  if (prop.kind === 'slot') {
    const target = prop.defaultComponent ? componentRoot(host.doc, prop.defaultComponent) : null;
    return target ? usageOf(host, host.component(target), prop.defaultComponent!) : null;
  }
  if (prop.kind === 'text' || prop.defaultRaw === null) return null;
  if (typeof prop.defaultRaw === 'boolean') return String(prop.defaultRaw);
  return prop.kind === 'variant' ? optionLiteral(prop, String(prop.defaultRaw)) : singleQuoted(String(prop.defaultRaw));
}

/** `<Badge label="New" />`: a component as used with the variant of `nodeId` and its default texts. */
function usageOf(host: BuildHost, model: ComponentModel, nodeId: NodeId, framework: Framework = 'react'): string {
  const node = host.doc.nodes[nodeId];
  if (!node) return `<${model.name} />`;
  const scope: BuildScope = {model: null, used: new Set()};
  // The variant's own layers stand in for an instance's copies: its label and its own texts are what the usage passes.
  const el = buildElement(host, scope, {...node, type: 'INSTANCE', componentId: nodeId, componentProperties: {}, parentId: null}, 'default', {root: false, inline: false});
  return el ? (framework === 'vue' ? vueUsageSnippet(el, (component, slot) => (component === model.name ? vueToggle(model, slot)?.jsName : undefined)) : usageSnippet(el)) : `<${model.name} />`;
}

/** The component in each of its looks: `<Button size="small">Buy</Button>`, and disabled when it has that state. */
function examplesOf(host: BuildHost, model: ComponentModel, space: Space, framework: Framework = 'react'): string[] {
  const out = space.source.map(v => usageOf(host, model, model.variants[v].nodeId, framework));
  if (model.state?.states.has('disabled')) {
    const first = out[space.defaultIndex] ?? `<${model.name} />`;
    out.push(first.replace(new RegExp(`^<${model.name}`), `<${model.name} disabled`));
  }
  return [...new Set(out)];
}

/** JSX attribute text, with a leading space. */
function attrJsx(attr: Attr): string {
  if (attr.expr) return attr.value === '' ? ` ${attr.name}` : ` ${attr.name}={${attr.value}}`;
  return /["&{}\n]/.test(attr.value) ? ` ${attr.name}={${JSON.stringify(attr.value)}}` : ` ${attr.name}="${attr.value}"`;
}

/** Text as a JSX child. On a line of its own JSX would trim the edges' spaces, so those keep quotes. */
const jsxText = (text: string, ownLine = false) => (/[{}<>&]/.test(text) || (ownLine && /^\s|\s$/.test(text)) ? `{${JSON.stringify(text)}}` : text);

function usageSnippet(el: El): string {
  const props = el.props.map(attrJsx).join('');
  const children = el.children.map(child => (child.kind === 'el' ? '' : child.kind === 'br' ? '<br />' : child.kind === 'expr' ? `{${child.expr}}` : jsxText(child.text))).join('');
  return children ? `<${el.tag}${props}>${children}</${el.tag}>` : `<${el.tag}${props} />`;
}

// ── Writing one module ─────────────────────────────────────────────────────────────────────────

type Shared = {
  styling: Styling;
  framework: Framework;
  tokens: TokenTable;
  assetFor: (ref: ImageRef) => AssetFile;
  icons: Icons;
  format: CodeFormat;
  /** Families the Tailwind classes use (for the theme's font-family-*), and the one that is the theme's sans. */
  families: Map<string, string>;
  baseFamily: string | null;
  /** The components written, by node (Vue reads another component's declared props). */
  models: ReadonlyMap<NodeId, ComponentModel>;
  warn(message: string): void;
};

/** An element's styles and the class they get. */
type Slot = {style: ElementStyle; base: string; root: boolean; name: string; sig: string; parent: string; tailwind?: TailwindParts};
type TailwindParts = {fixed: string; maps: string[]; ternaries: string[]};

type JEl = {
  kind: 'el';
  tag: string;
  attrs: Attr[];
  slot: Slot | null;
  children: JNode[];
  condition: string | null;
  root: boolean;
  /** `{...props}` goes here. */
  spread: boolean;
  field?: FieldRole;
  /** The tag is an icon or a component, so a repeated item may vary it. */
  icon?: boolean;
  component?: boolean;
  key?: string;
};
type JMap = {kind: 'map'; array: string; item: string; index: boolean; body: JEl};
type JRaw = {kind: 'raw'; lines: string[]; slot: Slot | null};
type JNode = JEl | JMap | JRaw | {kind: 'text'; text: string} | {kind: 'expr'; expr: string} | {kind: 'br'};

/** `plain`: items that differ in one text only are the texts themselves (`const tabs = ['All', 'New'];`). */
type DataArray = {name: string; type: string; fields: {name: string; type: string; optional: boolean}[]; rows: Map<string, string>[]; plain: boolean};

const INDENT = '  ';
/** Past this many characters a line that can break does: a list, an element with its content. */
const MAX_LINE = 120;
const CLASS_MARK = '\u0000class\u0000';
const cap = (s: string) => s.charAt(0).toUpperCase() + s.slice(1);
const camelProp = (prop: string) => prop.replace(/^-webkit-/, 'Webkit-').replace(/-([a-z])/g, (_, c: string) => c.toUpperCase()).replace(/^Webkit([a-z])/, (_, c: string) => 'Webkit' + c.toUpperCase());
const UNITLESS = new Set(['opacity', 'fontWeight', 'zIndex', 'flexGrow', 'flexShrink', 'flex', 'order', 'WebkitLineClamp']);
const kebab = (name: string) => name.replace(/([a-z0-9])([A-Z])/g, '$1-$2').toLowerCase();
const stem = (name: string) => name.replace(/\d+$/, '');
const PHRASING = new Set(['span', 'a', 'p', 'h1', 'h2', 'h3', 'h4', 'h5', 'h6', 'label', 'button', 'li', 'strong', 'em', 'small']);

/** A page-shaped frame's root takes the viewport: its width up to the design's, centred; at least the screen's height. */
function viewportRoot(decls: Decl[]): Decl[] {
  const out: Decl[] = [];
  for (const decl of decls) {
    if (decl.prop === 'width' && /px$/.test(decl.value)) out.push({...decl, value: '100%'}, {...decl, prop: 'max-width', value: decl.value}, {...decl, prop: 'margin-inline', value: 'auto'});
    else if (decl.prop === 'height' && /px$/.test(decl.value)) out.push({...decl, prop: 'min-height', value: '100dvh'});
    else out.push(decl);
  }
  return out;
}

/** A declaration value for a React style object. */
function styleValue(prop: string, value: string): string {
  const key = camelProp(prop);
  const pxMatch = /^(-?\d+(?:\.\d+)?)px$/.exec(value);
  if (pxMatch && key !== 'lineHeight') return pxMatch[1];
  if (value === '0' && key !== 'lineHeight' && !UNITLESS.has(key)) return '0';
  if (UNITLESS.has(key) && /^-?\d+(\.\d+)?$/.test(value)) return value;
  // A font stack quotes its families: double quotes outside read better than escaped single ones.
  return value.includes("'") && !value.includes('"') ? JSON.stringify(value) : singleQuoted(value);
}

/** Element names that are a page's landmarks: a frame called "Header" is a <header>. */
const LANDMARKS: [RegExp, string][] = [[/^(header|topBar|appBar)/, 'header'], [/^footer/, 'footer'], [/^(nav|navbar|tabbar|bottomNav|menu|breadcrumbs|pagination)/, 'nav'], [/^(sidebar|aside)/, 'aside'], [/^(section|hero|promo)/, 'section']];

/** Attributes React's types declare for an element that a design prop is likely to be called. */
const NATIVE_ATTRS: Record<string, readonly string[]> = {
  all: ['title', 'color', 'content', 'hidden', 'id', 'lang', 'dir', 'role', 'slot', 'translate', 'prefix', 'property', 'resource', 'rel', 'rev', 'results', 'security', 'inputMode', 'defaultValue', 'defaultChecked', 'tabIndex', 'draggable', 'accessKey', 'about', 'datatype', 'inlist', 'vocab', 'nonce'],
  button: ['disabled', 'form', 'name', 'type', 'value'],
  input: ['accept', 'alt', 'autoComplete', 'checked', 'disabled', 'form', 'height', 'list', 'max', 'maxLength', 'min', 'minLength', 'multiple', 'name', 'pattern', 'placeholder', 'readOnly', 'required', 'size', 'src', 'step', 'type', 'value', 'width'],
  a: ['download', 'href', 'hrefLang', 'media', 'ping', 'target', 'type', 'referrerPolicy'],
  svg: ['width', 'height', 'fill', 'stroke', 'opacity', 'filter', 'mask', 'display', 'direction', 'cursor', 'mode', 'name', 'type', 'values', 'version', 'x', 'y', 'offset', 'order', 'orientation', 'origin', 'radius', 'rotate', 'scale', 'spacing', 'speed', 'format', 'local', 'path', 'points', 'string', 'end', 'to', 'from', 'by', 'in', 'kind'],
};

/** Attributes written before the class (what the element is), the rest after it. */
const LEADING_ATTRS = new Set(['key', 'type', 'role', 'aria-checked', 'href', 'target', 'rel', 'id', 'htmlFor']);

class ModuleWriter {
  private readonly idents = new NameRegistry(RESERVED, {caseSensitive: true});
  private readonly classes = new NameRegistry([], {caseSensitive: true});
  private readonly componentImports = new Map<string, Set<string>>();
  private readonly typeImports = new Set<string>();
  private readonly assetImports = new Map<ImageRef, string>();
  private readonly iconImports = new Set<string>();
  private readonly slots: Slot[] = [];
  private readonly arrays: DataArray[] = [];
  private readonly shapes = new Shapes();
  private readonly consts: string[] = [];
  private readonly usedProps = new Set<string>();
  /** Rest-space dimensions some rule keys on, and those only a combination does (Tailwind keys single ones on maps). */
  private readonly dataDims = new Set<number>();
  private readonly comboDims = new Set<number>();
  private readonly fieldIds = new Map<NodeId, string>();
  private readonly fieldInputs: {node: JEl; group: NodeId}[] = [];
  private readonly fieldHints = new Map<NodeId, string | null>();
  private readonly ids = new NameRegistry([], {caseSensitive: true});
  private readonly tw: TailwindOptions;
  private groupUsed = false;
  private needsId = false;
  private warnedStates = false;
  usesCx = false;
  /** The element whose props the component takes ('div', 'button', 'input'…). */
  element = 'div';

  constructor(private readonly shared: Shared, private readonly kind: 'component' | 'screen', private readonly name: string, private readonly model: ComponentModel | null,
    private readonly space: Space, private readonly host: BuildHost, private readonly sourceName: string, private readonly screen: boolean) {
    const colorTokens = new Set(shared.tokens.tokens.filter(token => token.kind === 'color' && token.name).map(token => token.name));
    this.tw = {colorTokens, tokens: shared.tokens, format: shared.format, families: shared.families, baseFamily: shared.baseFamily};
  }

  private get dir() {
    return this.kind === 'component' ? 'src/components' : 'src/screens';
  }

  private get vue() {
    return this.shared.framework === 'vue';
  }

  paths(): string[] {
    const base = `${this.dir}/${this.name}`;
    if (this.vue) return [`${base}.vue`];
    return this.shared.styling === 'css-modules' ? [`${base}.tsx`, `${base}.module.css`] : [`${base}.tsx`];
  }

  private get rootKind() {
    return this.model?.rootKind ?? 'plain';
  }

  private get stateDisabled() {
    return !!this.model?.state?.states.has('disabled');
  }

  private get nativeDisabled() {
    return NATIVE_DISABLED.has(this.element) && this.rootKind !== 'field';
  }

  write(tree: UEl | null, scope: BuildScope, note?: string): GeneratedFile[] {
    const {styling} = this.shared;
    for (const prop of this.model?.props ?? []) this.idents.reserve(prop.jsName);
    for (const prop of this.space.variantProps) this.idents.reserve(prop.jsName);
    for (const reserved of ['className', 'style', 'children', 'index', this.name, `${this.name}Props`, 'inputId', 'fallbackId', 'hintId']) this.idents.reserve(reserved);
    if (this.vue) for (const reserved of [...VUE_RESERVED, 'props']) this.idents.reserve(reserved);

    // 1. The JSX, its classes and data: built, repeated items folded, ids wired, classes named.
    const built = tree ? this.build(tree, this.space.variants.map((_, i) => i), true, 'root') : [];
    if (this.space.variants.length === 1) this.repeats(built, 'root');
    this.wireFields();
    for (const name of scope.used) this.usedProps.add(name);
    this.nameClasses();
    // 2. What the styling needs before anything prints: Tailwind's maps and group variants, the inline objects.
    if (styling === 'tailwind') for (const slot of this.slots) slot.tailwind = this.tailwindParts(slot);
    if (styling === 'tailwind' && this.groupUsed) {
      const rootSlot = this.slots.find(slot => slot.root);
      if (rootSlot?.tailwind) rootSlot.tailwind.fixed = [`group/${this.groupName}`, rootSlot.tailwind.fixed].filter(Boolean).join(' ');
    }
    const inline = styling === 'inline' ? this.inlineObjects() : [];
    const css = styling === 'css-modules' ? this.cssModule() : '';
    if (this.vue) return [{path: this.paths()[0], contents: this.vueFile(built, inline, css, note)}];
    // 3. The body, then the signature (it destructures what the body reads), then the file around them.
    const body = built.length ? this.print(built, 2) : [`${INDENT.repeat(2)}null`];
    const {signature, prelude} = this.signature();

    const lines: string[] = [`// "${this.sourceName.replace(/\s+/g, ' ')}" from ${PRODUCT_NAME}.`];
    if (note) lines.push(`// ${note}`);
    const reactValues = this.needsId ? ['useId'] : [];
    const types = [...this.typeImports].sort();
    if (reactValues.length || types.length) lines.push(`import {${[...reactValues, ...types.map(type => `type ${type}`)].join(', ')}} from 'react';`);
    const from = this.kind === 'component' ? './' : '../components/';
    for (const [component, extra] of [...this.componentImports].sort(([a], [b]) => a.localeCompare(b))) lines.push(`import {${[component, ...[...extra].sort().map(type => `type ${type}`)].join(', ')}} from '${from}${component}';`);
    for (const icon of [...this.iconImports].sort()) lines.push(`import {${icon}} from '../icons/${icon}';`);
    for (const [ref, ident] of this.assetImports) lines.push(`import ${ident} from '../assets/${this.shared.assetFor(ref).path.split('/').pop()}';`);
    if (this.usesCx) lines.push(`import {cx} from '../lib/cx';`);
    if (css) lines.push(`import styles from './${this.name}.module.css';`);
    lines.push('');
    if (inline.length) lines.push('const styles = {', ...inline, '} satisfies Record<string, CSSProperties>;', '');
    for (const constant of this.consts) lines.push(constant);
    if (this.consts.length) lines.push('');
    for (const array of this.arrays) lines.push(...this.printArray(array), '');
    lines.push(...signature, ...prelude, `${INDENT}return (`, ...body, `${INDENT});`, '}');

    const out: GeneratedFile[] = [{path: this.paths()[0], contents: lines.join('\n') + '\n'}];
    if (styling === 'css-modules') out.push({path: this.paths()[1], contents: css});
    return out;
  }

  // Building the JSX ────────────────────────────────────────────────────────────────────────

  private at(u: UEl, r: number): El | null {
    return u.per[this.space.source[r]] ?? null;
  }

  private build(u: UEl, domain: number[], root: boolean, parent: string): JNode[] {
    const {space} = this;
    const present = domain.filter(r => this.at(u, r));
    if (!present.length) return [];
    const base = present.includes(space.defaultIndex) ? space.defaultIndex : present[0];
    const el = this.at(u, base)!;
    const presence = presenceCondition(space, domain, new Set(present));
    this.markTest(presence);
    if (el.condition) this.markProp(el.condition);
    const condition = [presence, el.condition].filter(Boolean).join(' && ') || null;
    const style = elementStyle(u, space);
    // Only an interaction state draws it (a focus ring): the stylesheet cannot add elements, so it is left out.
    if (!style) return [];
    if (root && el.role === 'svg' && el.svg) return [this.rootSvg(u, present, base, el, style)];
    if (root && this.screen) style.base = viewportRoot(style.base);
    const slot = style.base.length || style.rules.length || root ? this.slot(style, root ? 'root' : el.classBase || 'item', root, parent) : null;

    if (el.role === 'svg' && el.svg) {
      // Variants that draw different pictures (an icon set): each picture under the test of the variants that draw it.
      const pictures = this.svgGroups(u, present, base);
      return pictures.map(group => {
        const test = pictures.length > 1 ? presenceCondition(space, present, new Set(group.variants)) : null;
        this.markTest(test);
        const icon = this.shared.icons.get(this.at(u, group.variants[0])!.svg!, this.iconHint(el, pictures.length > 1 ? {group: group.variants, all: pictures.map(other => other.variants)} : null));
        this.iconImports.add(icon);
        this.idents.reserve(icon);
        return {kind: 'el', tag: icon, attrs: [], slot, children: [], condition: [condition, test].filter(Boolean).join(' && ') || null, root: false, spread: false, icon: true} satisfies JEl;
      });
    }
    if (el.role === 'component') {
      this.importComponent(el.tag);
      return [{kind: 'el', tag: el.tag, attrs: this.componentProps(u, present, base, el), slot, children: this.children(u, present, slot?.base ?? parent), condition, root: false, spread: false, component: true}];
    }

    const attrs = this.attributes(el);
    let tag = el.tag;
    if (tag === 'div') tag = this.landmark(root ? (this.screen ? 'main' : memberName(this.name)) : slot?.base ?? el.classBase, root) ?? tag;
    if (root) {
      this.element = tag;
      if (this.rootKind === 'switch' || this.rootKind === 'checkbox' || this.rootKind === 'radio') {
        attrs.push({name: 'role', value: this.rootKind, expr: false}, {name: 'aria-checked', value: 'checked', expr: true});
        this.markProp('checked');
      }
    }
    const node: JEl = {kind: 'el', tag, attrs, slot, children: [], condition, root, spread: root && this.kind === 'component' && this.rootKind !== 'field', field: el.field};
    if (el.field) this.fieldAttributes(node, el, condition);
    if (el.field === 'input') {
      node.spread = this.kind === 'component' && this.rootKind === 'field';
      if (node.spread) this.element = 'input';
      return [node];
    }
    node.children = this.children(u, present, slot?.base ?? parent);
    return [node];
  }

  private children(u: UEl, present: number[], parent: string): JNode[] {
    const out: JNode[] = [];
    for (const child of u.children) {
      if (child.kind === 'p') {
        const piece = this.piece(child, present);
        if (piece) out.push(piece);
      } else out.push(...this.build(child, present, false, parent));
    }
    return out;
  }

  private piece(u: UPiece, domain: number[]): JNode | null {
    const {space} = this;
    const present = domain.filter(r => u.per[space.source[r]]);
    if (!present.length) return null;
    const base = present.includes(space.defaultIndex) ? space.defaultIndex : present[0];
    const piece = u.per[space.source[base]]!;
    const presence = presenceCondition(space, domain, new Set(present));
    this.markTest(presence);
    let content: JNode;
    if (piece.kind === 'br') content = {kind: 'br'};
    else {
      // The text of each variant (a prop's value where it is bound): one expression that picks it.
      const valueOf = (r: number) => {
        const p = u.per[space.source[r]];
        return p?.kind === 'text' ? singleQuoted(p.text) : p?.kind === 'expr' ? p.expr : "''";
      };
      const expression = switchExpression(space, present, valueOf, base);
      this.markTest(expression);
      for (const r of present) {
        const p = u.per[space.source[r]];
        if (p?.kind === 'expr') this.markProp(p.expr);
      }
      content = piece.kind === 'text' && expression === singleQuoted(piece.text) ? {kind: 'text', text: piece.text} : {kind: 'expr', expr: expression};
    }
    if (!presence) return content;
    // A template prints `false` as text: a piece some variants leave out is a <template v-if>.
    if (this.vue) return {kind: 'el', tag: 'template', attrs: [], slot: null, children: [content], condition: presence, root: false, spread: false};
    const inner = content.kind === 'br' ? '<br />' : content.kind === 'expr' ? content.expr : content.kind === 'text' ? singleQuoted(content.text) : '';
    return {kind: 'expr', expr: `${presence} && ${inner}`};
  }

  /** An icon is named after its layer, or, when that names only a kind ("Vector", "Icon"), after where it is: its parent, or
   *  the component and the option that shows it (TabSearchIcon). */
  private iconHint(el: El, variants: {group: number[]; all: number[][]} | null): string {
    const generic = (name: string) => /^(Icon|Vector|Svg|Image|Layer|Shape|Group|Frame|Path|Union)\d*$/.test(componentName(name, 'Icon'));
    if (!generic(el.name)) return el.name;
    const {doc} = this.host;
    const node = doc.nodes[el.nodeId];
    const parent = node?.parentId ? doc.nodes[node.parentId] : undefined;
    const option = variants ? this.optionWords(variants.group, variants.all) : '';
    // Inside a variant ("Type=Primary") or a component, the component names it: ButtonIcon, TabSearchIcon.
    if (parent?.type === 'COMPONENT' || parent?.type === 'COMPONENT_SET') {
      const set = parent.parentId && doc.nodes[parent.parentId]?.type === 'COMPONENT_SET' ? doc.nodes[parent.parentId] : parent;
      return `${set.name.includes('=') ? this.name : set.name} ${option} ${el.name}`;
    }
    const owner = parent && parent.type !== 'PAGE' && !parent.name.includes('=') && !generic(parent.name) ? parent.name : this.name;
    return `${owner} ${option} ${el.name}`;
  }

  /** The options that set a picture's variants apart from the others' ("Search" for the search tab's icon). */
  private optionWords(group: number[], all: number[][]): string {
    const words: string[] = [];
    this.space.variantProps.forEach((prop, d) => {
      const own = new Set(group.map(r => this.space.variants[r].options[d]));
      const varies = all.some(other => other !== group && other.some(r => !own.has(this.space.variants[r].options[d])));
      if (own.size === 1 && varies) {
        const option = [...own][0];
        words.push(prop.kind === 'variantBool' ? (option === 'true' ? prop.jsName : `not ${prop.jsName}`) : option);
      }
    });
    return words.join(' ');
  }

  private landmark(base: string, root: boolean): string | null {
    if (root && this.screen) return 'main';
    for (const [pattern, tag] of LANDMARKS) if (pattern.test(base)) return tag;
    return null;
  }

  private slot(style: ElementStyle, base: string, root: boolean, parent: string): Slot {
    const slot: Slot = {style, base, root, name: '', sig: JSON.stringify(style), parent};
    this.slots.push(slot);
    for (const rule of style.rules) {
      for (const [d] of rule.cond.dims) this.dataDims.add(d);
      if (rule.cond.dims.length > 1 || rule.cond.pseudo) for (const [d] of rule.cond.dims) this.comboDims.add(d);
    }
    return slot;
  }

  private importComponent(name: string, type?: string) {
    let extra = this.componentImports.get(name);
    if (!extra) this.componentImports.set(name, extra = new Set());
    if (type) extra.add(type);
    this.idents.reserve(name);
  }

  private attributes(el: El): Attr[] {
    return el.attrs.map(attr => {
      if (attr.expr && ASSET_MARK.test(attr.value)) {
        ASSET_MARK.lastIndex = 0;
        return {name: attr.name, value: this.assetIdent(attr.value.replace(ASSET_MARK, '$1')), expr: true};
      }
      return attr;
    });
  }

  /** The id wiring of a text field: label → input (htmlFor), hint ← input (aria-describedby), an error look → aria-invalid. */
  private fieldAttributes(node: JEl, el: El, condition: string | null) {
    const own = this.kind === 'component' && this.rootKind === 'field';
    // A component's field is one field in every variant (each variant has its own layers, so its own ids).
    const group = own ? '' : el.fieldGroup ?? '';
    const id = own ? {value: 'inputId', expr: true} : {value: this.fieldId(group), expr: false};
    if (own) this.needsId = true;
    if (el.field === 'label') node.attrs.push({name: 'htmlFor', ...id});
    else if (el.field === 'hint') {
      node.attrs.push({name: 'id', ...(own ? {value: 'hintId', expr: true} : {value: `${id.value}-hint`, expr: false})});
      this.fieldHints.set(group, condition);
    } else if (el.field === 'input') {
      node.tag = 'input';
      node.attrs.push({name: 'id', ...id});
      if (el.text) node.attrs.push({name: 'placeholder', value: el.text, expr: false});
      const invalid = this.space.variantProps.find(prop => prop.kind === 'variantBool' && /^(error|invalid|isError|isInvalid|hasError)$/.test(prop.jsName));
      if (invalid && own) {
        node.attrs.push({name: 'aria-invalid', value: `${invalid.jsName} || undefined`, expr: true});
        this.markProp(invalid.jsName);
      }
      this.fieldInputs.push({node, group});
    }
  }

  private fieldId(group: NodeId): string {
    let id = this.fieldIds.get(group);
    if (!id) {
      id = this.ids.claim(slugName(this.host.doc.nodes[group]?.name ?? 'field', 'field'));
      this.fieldIds.set(group, id);
    }
    return id;
  }

  /** Inputs point at their hint once the whole tree is known (the hint comes after the input). */
  private wireFields() {
    const own = this.kind === 'component' && this.rootKind === 'field';
    for (const {node, group} of this.fieldInputs) {
      if (!this.fieldHints.has(group)) continue;
      const condition = this.fieldHints.get(group)!;
      const hintId = own ? 'hintId' : `'${this.fieldId(group)}-hint'`;
      node.attrs.push(condition ? {name: 'aria-describedby', value: `${condition} ? ${hintId} : undefined`, expr: true} : own ? {name: 'aria-describedby', value: 'hintId', expr: true} : {name: 'aria-describedby', value: `${this.fieldId(group)}-hint`, expr: false});
      if (condition) this.markTest(condition);
    }
  }

  /** Component props, per variant. */
  private componentProps(u: UEl, present: number[], base: number, el: El): Attr[] {
    const out: Attr[] = [];
    const names: string[] = [];
    for (const r of present) for (const prop of this.at(u, r)!.props) if (!names.includes(prop.name)) names.push(prop.name);
    for (const name of names) {
      const valueOf = (r: number): string => {
        const prop = this.at(u, r)?.props.find(p => p.name === name);
        if (!prop) return 'undefined';
        if (prop.expr) return prop.value === '' ? 'true' : prop.value;
        return singleQuoted(prop.value);
      };
      const expression = switchExpression(this.space, present, valueOf, base);
      this.markTest(expression);
      const own = el.props.find(p => p.name === name);
      if (own && expression === valueOf(base)) out.push(own);
      else if (expression !== 'undefined') out.push({name, value: expression, expr: true});
    }
    for (const attr of out) if (attr.expr) for (const match of attr.value.matchAll(/<([A-Z][A-Za-z0-9_]*)/g)) this.importComponent(match[1]);
    return out;
  }

  private assetIdent(ref: ImageRef): string {
    let ident = this.assetImports.get(ref);
    if (!ident) {
      const file = this.shared.assetFor(ref).path.split('/').pop()!.replace(/\.[a-z0-9]+$/i, '');
      ident = this.idents.claim(memberName(file, 'image') + 'Src');
      this.assetImports.set(ref, ident);
    }
    return ident;
  }

  private markProp(name: string) {
    this.usedProps.add(name);
  }

  private markTest(test: string | null) {
    if (!test) return;
    for (const prop of [...this.space.variantProps, ...(this.model?.props ?? [])]) if (new RegExp(`\\b${prop.jsName}\\b`).test(test)) this.markProp(prop.jsName);
  }

  // SVG ──────────────────────────────────────────────────────────────────────────────────────

  /** The pictures an SVG element draws across the variants in `present`, the base variant's first, with the variants that draw each. */
  private svgGroups(u: UEl, present: number[], base: number): {variants: number[]}[] {
    const keyOf = (r: number) => {
      const el = this.at(u, r);
      return el?.role === 'svg' && el.svg ? svgKey(el.svg) : null;
    };
    const baseKey = keyOf(base);
    const groups = new Map<string | null, number[]>([[baseKey, []]]);
    for (const r of [base, ...present.filter(v => v !== base)]) {
      const key = keyOf(r) ?? baseKey;
      const list = groups.get(key);
      if (list) list.push(r);
      else groups.set(key, [r]);
    }
    return [...groups.values()].map(variants => ({variants}));
  }

  /** A component whose root is a picture: one <svg>, its size and view box switched by the variant props, and each
   *  picture's content under the test of the variants that draw it. */
  private rootSvg(u: UEl, present: number[], base: number, el: El, style: ElementStyle): JRaw {
    this.element = 'svg';
    const groups = this.svgGroups(u, present, base);
    const svgOf = (r: number) => {
      const own = this.at(u, r);
      return own?.role === 'svg' && own.svg ? own.svg : el.svg!;
    };
    const attribute = (name: string, valueOf: (r: number) => string) => {
      const expression = switchExpression(this.space, present, r => JSON.stringify(valueOf(r)), base);
      this.markTest(expression);
      return expression === JSON.stringify(valueOf(base)) ? ` ${name}=${expression}` : ` ${name}={${expression}}`;
    };
    const slot = this.slot(style, 'root', true, 'root');
    if (this.vue) return this.vueRootSvg(groups, present, base, el, svgOf, slot);
    const size = attribute('width', r => num(svgOf(r).box.width, 3)) + attribute('height', r => num(svgOf(r).box.height, 3)) + attribute('viewBox', r => svgOf(r).viewBox);
    const prefix = kebab(this.name);
    const open = `<svg${size} fill="none" overflow="visible" aria-hidden="true"${CLASS_MARK} {...props}>`;
    const lines: string[] = [open];
    if (groups.length === 1) lines.push(...svgChildrenJsx(el.svg!.root, INDENT).map(line => line.split(`${SVG_ID_PREFIX}-`).join(`${prefix}-`)));
    else groups.forEach((group, index) => {
      const test = presenceCondition(this.space, present, new Set(group.variants));
      this.markTest(test);
      // Ids of each picture's definitions stay apart, so two variants on one page never paint with each other's. One element
      // needs no fragment around it.
      const root = svgOf(group.variants[0]).root;
      const single = root.children.length === 1;
      const content = svgChildrenJsx(root, INDENT.repeat(single ? 2 : 3)).map(line => line.split(`${SVG_ID_PREFIX}-`).join(`${prefix}${index ? `-v${index + 1}` : ''}-`));
      if (single) lines.push(`${INDENT}{${test ?? 'true'} && (`, ...content, `${INDENT})}`);
      else lines.push(`${INDENT}{${test ?? 'true'} && (`, `${INDENT.repeat(2)}<>`, ...content, `${INDENT.repeat(2)}</>`, `${INDENT})}`);
    });
    lines.push('</svg>');
    return {kind: 'raw', lines, slot};
  }

  // Repeated siblings ─────────────────────────────────────────────────────────────────────────

  /** Runs of three or more siblings with one structure that differ only in texts, pictures, icons or a component's
   *  props become a typed data array and a `.map()`. */
  private repeats(nodes: JNode[], parent: string) {
    for (const node of nodes) {
      if (node.kind !== 'el') continue;
      const own = node.slot?.base ?? parent;
      this.repeats(node.children, own);
      node.children = this.collapse(node.children, own);
    }
  }

  private collapse(children: JNode[], parent: string): JNode[] {
    const out: JNode[] = [];
    for (let i = 0; i < children.length;) {
      const first = children[i];
      if (first.kind !== 'el' || first.condition) {
        out.push(first);
        i++;
        continue;
      }
      const shape = this.shapes.of(first);
      let j = i + 1;
      while (j < children.length && children[j].kind === 'el' && !(children[j] as JEl).condition && this.shapes.of(children[j]) === shape) j++;
      const run = children.slice(i, j) as JEl[];
      const mapped = run.length >= 3 ? this.mapRun(run, parent) : null;
      if (mapped) out.push(mapped);
      else out.push(...run);
      i = j;
    }
    return out;
  }

  private mapRun(run: JEl[], parent: string): JMap | null {
    const lists = run.map(el => slotsOf(el, this.vue ? name => this.declaredProps(name) : null));
    // The varying parts line up by their place in the item (a prop one item leaves out is that item's undefined).
    const keys: string[] = [];
    for (const list of lists) for (const slot of list) if (!keys.includes(slot.key)) keys.push(slot.key);
    const at = (list: ItemSlot[], key: string) => list.find(slot => slot.key === key);
    const varying = keys.filter(key => lists.some(list => at(list, key)?.value !== at(lists[0], key)?.value));
    if (!varying.length) return null;
    // Only a component's props may be left out; a missing text or picture means another structure.
    if (varying.some(key => !key.includes(':prop:') && lists.some(list => !at(list, key)))) return null;
    // A Vue template passes an instance swap as a slot, not as data.
    if (this.vue && varying.some(key => lists.some(list => at(list, key)?.slot))) return null;
    const firstBase = run[0].slot?.base ?? (run[0].component ? memberName(run[0].tag) : '');
    const sameName = !!firstBase && run.every(el => stem(el.slot?.base ?? (el.component ? memberName(el.tag) : '')) === stem(firstBase)) && !/^(item|box|row|stack|text|title|shape|group)$/.test(stem(firstBase));
    const arrayName = this.idents.claim(sameName ? pluralName(stem(firstBase)) : parent && parent !== 'root' ? (/s$/.test(parent) ? parent : `${parent}Items`) : 'items');
    const item = this.idents.claim(singularName(arrayName));
    const fieldNames = new NameRegistry(['key'], {caseSensitive: true});
    const fieldOf = new Map<string, string>();
    const fields: DataArray['fields'] = [];
    for (const key of varying) {
      const sample = lists.map(list => at(list, key)).find(Boolean)!;
      const name = fieldNames.claim(sample.field);
      fieldOf.set(key, name);
      fields.push({name, type: sample.type, optional: lists.some(list => !at(list, key))});
      for (const type of sample.typeImports) this.typeImports.add(type);
      if (sample.propsOf) this.importComponent(sample.propsOf, `${sample.propsOf}Props`);
    }
    // `Stat` for a stat; `ButtonItem` where the component already is `Button`.
    const typeName = this.idents.claim(this.idents.has(cap(item)) ? `${cap(item)}Item` : cap(item));
    if (this.vue) this.idents.reserve(typeName);
    const rows = lists.map(list => {
      const row = new Map<string, string>();
      for (const key of varying) {
        const slot = at(list, key);
        if (slot) row.set(fieldOf.get(key)!, slot.literal);
      }
      return row;
    });
    const plain = fields.length === 1 && fields[0].type === 'string' && !fields[0].optional;
    this.arrays.push({name: arrayName, type: typeName, fields, rows, plain});
    // The key: a text that differs in every item, else the position.
    const unique = fields.find(field => field.type === 'string' && !field.optional && new Set(rows.map(row => row.get(field.name))).size === rows.length);
    const body = bindSlots(run[0], key => (fieldOf.has(key) ? (plain ? item : `${item}.${fieldOf.get(key)}`) : null), varying);
    body.key = unique ? (plain ? item : `${item}.${unique.name}`) : 'index';
    if (body.slot) renameSlots(body, body.slot.base, item);
    for (const el of run.slice(1)) dropSlots(el, this.slots);
    return {kind: 'map', array: arrayName, item, index: !unique, body};
  }

  private printArray(array: DataArray): string[] {
    if (array.plain) {
      const values = array.rows.map(row => row.get(array.fields[0].name)!);
      const line = `const ${array.name} = [${values.join(', ')}];`;
      return line.length <= MAX_LINE ? [line] : [`const ${array.name} = [`, ...values.map(value => `${INDENT}${value},`), '];'];
    }
    const lines = [`type ${array.type} = {${array.fields.map(field => `${field.name}${field.optional ? '?' : ''}: ${field.type}`).join('; ')}};`, '', `const ${array.name}: ${array.type}[] = [`];
    for (const row of array.rows) lines.push(`${INDENT}{${[...row].map(([key, value]) => `${key}: ${value}`).join(', ')}},`);
    lines.push('];');
    return lines;
  }

  // Classes ────────────────────────────────────────────────────────────────────────────────────

  /** Every element with styles gets a class; elements whose rules are the same and whose names agree (`button`,
   *  `button2`) or that are siblings share one. */
  private nameClasses() {
    const groups: Slot[][] = [];
    for (const slot of this.slots) {
      const group = slot.root ? undefined : groups.find(([first]) => first.sig === slot.sig && !first.root && (stem(first.base) === stem(slot.base) || first.parent === slot.parent));
      if (group) group.push(slot);
      else groups.push([slot]);
    }
    for (const group of groups) {
      // Siblings named apart ("Notifications", "Privacy") that look alike are items of their parent.
      const stems = new Set(group.map(slot => stem(slot.base)));
      const parent = group[0].parent;
      const name = this.classes.claim(stems.size === 1 ? group[0].base : parent && parent !== 'root' ? `${singularName(parent).replace(/Item$/, '')}Item` : 'item');
      for (const slot of group) slot.name = name;
    }
  }

  // Signature ─────────────────────────────────────────────────────────────────────────────────

  private signature(): {signature: string[]; prelude: string[]} {
    const model = this.model;
    const {styling} = this.shared;
    if (!model) return {signature: [`export function ${this.name}() {`], prelude: []};
    const element = this.element;
    const own = ownProps(model, false);
    const api = stateApi(model);
    if (own.some(entry => propType(entry.prop).includes('ReactNode'))) this.typeImports.add('ReactNode');
    // The element's own props, less the ones a design prop of the same name replaces.
    const nativeNames = new Set([...NATIVE_ATTRS.all, ...(NATIVE_ATTRS[element] ?? [])]);
    const clashes = own.map(entry => entry.prop.jsName).filter(name => nativeNames.has(name) && name !== 'checked');
    const extraDisabled = api.disabled && !NATIVE_DISABLED.has(element);
    let base = element === 'svg' ? 'SVGProps<SVGSVGElement>' : `ComponentPropsWithRef<'${element}'>`;
    this.typeImports.add(element === 'svg' ? 'SVGProps' : 'ComponentPropsWithRef');
    if (clashes.length) base = `Omit<${base}, ${clashes.map(name => `'${name}'`).join(' | ')}>`;
    const fields: string[] = [];
    for (const entry of own) fields.push(`${INDENT}/** ${propComment(entry.prop)} */`, `${INDENT}${entry.prop.jsName}${entry.optional ? '?' : ''}: ${propType(entry.prop)};`);
    if (extraDisabled) fields.push(`${INDENT}/** Disabled: \`aria-disabled\` and the look of the disabled state. */`, `${INDENT}disabled?: boolean;`);
    const signature = fields.length ? [`export type ${this.name}Props = ${base} & {`, ...fields, '};', ''] : [`export type ${this.name}Props = ${base};`, ''];

    // The destructuring: every own prop (so none reaches the DOM), defaults where the design has them.
    const params: string[] = [];
    for (const entry of own) {
      const fallback = defaultExpression(this.host, entry.prop);
      for (const match of (fallback ?? '').matchAll(/<([A-Z][A-Za-z0-9_]*)/g)) this.importComponent(match[1]);
      params.push(fallback === null ? entry.prop.jsName : `${entry.prop.jsName} = ${fallback}`);
    }
    if (extraDisabled || (styling === 'inline' && api.disabled && this.usedProps.has('disabled'))) params.push('disabled');
    if (model.props.some(prop => prop.native === 'children') && this.usedProps.has('children')) params.push('children');
    params.push(styling === 'inline' ? 'style' : 'className');
    const prelude: string[] = [];
    if (this.needsId) {
      params.push('id');
      prelude.push(`${INDENT}const fallbackId = useId();`, `${INDENT}const inputId = id ?? fallbackId;`);
      if ([...this.fieldHints.keys()].length) prelude.push(`${INDENT}const hintId = \`\${inputId}-hint\`;`);
    }
    params.push('...props');
    signature.push(`export function ${this.name}({${params.join(', ')}}: ${this.name}Props) {`);
    return {signature, prelude};
  }

  // Printing JSX ─────────────────────────────────────────────────────────────────────────────

  private print(nodes: JNode[], depth: number): string[] {
    return nodes.flatMap(node => this.printNode(node, depth, true));
  }

  private printNode(node: JNode, depth: number, ownLine: boolean): string[] {
    const pad = INDENT.repeat(depth);
    switch (node.kind) {
      case 'text': return [`${pad}${jsxText(node.text, ownLine)}`];
      case 'expr': return [`${pad}{${node.expr}}`];
      case 'br': return [`${pad}<br />`];
      case 'raw': {
        const classAttr = this.classAttr(node.slot, true);
        return node.lines.map(line => pad + line.replace(CLASS_MARK, classAttr));
      }
      case 'map': return [`${pad}{${node.array}.map(${node.index ? `(${node.item}, index)` : node.item} => (`, ...this.printElement(node.body, depth + 1), `${pad}))}`];
      case 'el': return this.printElement(node, depth);
    }
  }

  private printElement(el: JEl, depth: number): string[] {
    const pad = INDENT.repeat(depth);
    const open = this.openTag(el);
    const empty = el.tag === 'input' || el.tag === 'img' || !el.children.length;
    const inline = !empty && this.oneLine(el) ? this.inlineLine(el, pad, open) : null;
    let lines: string[];
    if (empty) lines = [`${pad}${open} />`];
    else if (inline !== null) lines = [inline];
    else {
      lines = [`${pad}${open}>`];
      for (const child of el.children) lines.push(...this.printNode(child, depth + 1, true));
      lines.push(`${pad}</${el.tag}>`);
    }
    if (!el.condition) return lines;
    if (lines.length === 1) return [`${pad}{${el.condition} && ${lines[0].trim()}}`];
    return [`${pad}{${el.condition} && (`, ...lines.map(line => INDENT + line), `${pad})}`];
  }

  /** The element on one line with its content (inline content is written as it is: the spaces around a link are part of
   *  the text), or null when that line would be long and a block's children read better one per line. */
  private inlineLine(el: JEl, pad: string, open: string): string | null {
    const inner = el.children.map(child => this.printNode(child, 0, false).join('')).join('');
    const line = `${pad}${open}>${inner}</${el.tag}>`;
    return line.length <= MAX_LINE || PHRASING.has(el.tag) ? line : null;
  }

  private inlineEl(el: JEl): boolean {
    return (el.tag === 'span' || el.tag === 'a') && !el.condition && el.children.every(child => child.kind === 'text' || child.kind === 'expr' || child.kind === 'br');
  }

  /** Text and inline elements stay on the element's line inside phrasing content (a paragraph, a label, a button) or as a lone
   *  child; a block holding several elements lists them one per line. */
  private oneLine(el: JEl): boolean {
    const inline = el.children.every(child => child.kind === 'text' || child.kind === 'expr' || child.kind === 'br' || (child.kind === 'el' && this.inlineEl(child)));
    if (!inline) return false;
    const elements = el.children.filter(child => child.kind === 'el').length;
    return elements <= 1 || PHRASING.has(el.tag);
  }

  private openTag(el: JEl): string {
    const parts: string[] = [];
    if (el.key) parts.push(` key={${el.key}}`);
    const leading = el.component ? [] : el.attrs.filter(attr => LEADING_ATTRS.has(attr.name));
    const trailing = el.component ? el.attrs : el.attrs.filter(attr => !LEADING_ATTRS.has(attr.name));
    parts.push(...leading.map(attrJsx));
    if (el.component) parts.push(...trailing.map(attrJsx));
    parts.push(this.classAttr(el.slot, el.root && !!this.model, el));
    if (!el.component) parts.push(...trailing.map(attrJsx));
    if (el.root && this.model) parts.push(...this.rootData());
    // Inline styles read `disabled` to pick the disabled look, so it is destructured: a field hands it back to its input.
    if (el.spread && el.field === 'input' && this.shared.styling === 'inline' && this.stateDisabled) {
      parts.push(' disabled={disabled}');
      this.markProp('disabled');
    }
    if (el.spread) parts.push(' {...props}');
    return `<${el.tag}${parts.join('')}`;
  }

  /** The variant props the stylesheet keys on, as attributes of the root. */
  private rootData(): string[] {
    return this.rootDataAttrs().map(attrJsx);
  }

  private rootDataAttrs(): Attr[] {
    const model = this.model!;
    const out: Attr[] = [];
    const {styling} = this.shared;
    if (styling !== 'inline') {
      for (const d of [...(styling === 'tailwind' ? this.comboDims : this.dataDims)].sort((a, b) => a - b)) {
        const prop = this.space.variantProps[d];
        if (this.isChecked(d)) continue;
        this.markProp(prop.jsName);
        out.push({name: `data-${kebab(prop.jsName)}`, value: prop.kind === 'variantBool' ? `${prop.jsName} || undefined` : prop.jsName, expr: true});
      }
    }
    if (stateApi(model).disabled && !NATIVE_DISABLED.has(this.element) && this.rootKind !== 'field') out.push({name: 'aria-disabled', value: 'disabled || undefined', expr: true});
    if (stateApi(model).disabled && this.shared.styling === 'inline' && NATIVE_DISABLED.has(this.element) && this.usedProps.has('disabled')) out.push({name: 'disabled', value: 'disabled', expr: true});
    return out;
  }

  // Styles per styling ───────────────────────────────────────────────────────────────────────

  private classAttr(slot: Slot | null, root: boolean, el?: JEl): string {
    const {styling} = this.shared;
    // A field's root takes className; its input takes the rest of the props.
    const own = root && (!el || !el.field);
    if (styling === 'inline') return this.inlineAttr(slot, own);
    if (styling === 'tailwind') return this.tailwindAttr(slot, own);
    if (!slot) return own ? ' className={className}' : '';
    if (!own) return ` className={styles.${slot.name}}`;
    this.usesCx = true;
    return ` className={cx(styles.${slot.name}, className)}`;
  }

  // CSS Modules ──

  private cssModule(): string {
    const blocks: string[] = [];
    const rootName = this.slots.find(slot => slot.root)?.name ?? 'root';
    const seen = new Set<string>();
    for (const slot of this.slots) {
      if (seen.has(slot.name)) continue;
      seen.add(slot.name);
      if (slot.style.base.length) blocks.push(this.cssBlock([`.${slot.name}`], slot.style.base));
      // Rules next to each other that say the same thing are one rule with a list of selectors (checked and mixed draw one box).
      const rules: {selectors: string[]; decls: Decl[]; body: string}[] = [];
      for (const rule of slot.style.rules) {
        const selector = this.selector(rule.cond, slot, rootName);
        const body = rule.decls.map(decl => `${decl.prop}: ${this.cssValue(decl)}`).join(';');
        const last = rules[rules.length - 1];
        if (last && last.body === body) last.selectors.push(selector);
        else rules.push({selectors: [selector], decls: rule.decls, body});
      }
      for (const rule of rules) blocks.push(this.cssBlock(rule.selectors, rule.decls));
    }
    return blocks.length ? blocks.join('\n\n') + '\n' : '';
  }

  private cssBlock(selectors: readonly string[], decls: Decl[]): string {
    return [`${selectors.join(',\n')} {`, ...decls.map(decl => `${INDENT}${decl.prop}: ${this.cssValue(decl)};`), '}'].join('\n');
  }

  private cssValue(decl: Decl): string {
    const value = decl.value.replace(ASSET_MARK, (_, ref: string) => `'../assets/${this.shared.assetFor(ref).path.split('/').pop()}'`);
    return formatValue(decl.prop, value, this.shared.format);
  }

  private selector(cond: Cond, slot: Slot, rootName: string): string {
    const rootPart = `.${rootName}${cond.dims.map(([d, option]) => this.attrSelector(d, option)).join('')}${cond.state ? this.stateSelector(cond.state) : ''}`;
    const pseudo = cond.pseudo ?? '';
    if (slot.root) return rootPart + pseudo;
    if (!cond.dims.length && !cond.state) return `.${slot.name}${pseudo}`;
    return `${rootPart} .${slot.name}${pseudo}`;
  }

  private attrSelector(d: number, option: string): string {
    const prop = this.space.variantProps[d];
    if (this.isChecked(d)) return `[aria-checked='${option}']`;
    if (prop.kind === 'variantBool') return option === 'true' ? `[data-${kebab(prop.jsName)}]` : `:not([data-${kebab(prop.jsName)}])`;
    return `[data-${kebab(prop.jsName)}='${option}']`;
  }

  /** The root's selector of a state; `guarded`: hover and press leave a disabled look alone. */
  stateSelector(state: InteractiveState, guarded = true): string {
    const field = this.rootKind === 'field';
    const enabled = !this.stateDisabled || !guarded ? '' : this.nativeDisabled ? ':not(:disabled)' : field ? ':not(:has(input:disabled))' : ":not([aria-disabled='true'])";
    switch (state) {
      case 'hover': return `:hover${enabled}`;
      case 'active': return `:active${enabled}`;
      case 'focus': return field ? ':focus-within' : ':focus-visible';
      case 'disabled': return this.nativeDisabled ? ':disabled' : field ? ':has(input:disabled)' : "[aria-disabled='true']";
    }
  }

  // Tailwind ──

  private tailwindAttr(slot: Slot | null, own: boolean): string {
    const parts: string[] = [];
    const tw = slot?.tailwind;
    if (tw?.fixed) parts.push(singleQuoted(tw.fixed));
    if (tw) parts.push(...tw.ternaries, ...tw.maps);
    if (own) parts.push('className');
    if (!parts.length) return '';
    if (parts.length === 1 && tw?.fixed && parts[0] === singleQuoted(tw.fixed)) return /["\\]/.test(tw.fixed) ? ` className={${parts[0]}}` : ` className="${tw.fixed}"`;
    if (parts.length === 1) return ` className={${parts[0]}}`;
    this.usesCx = true;
    return ` className={cx(${parts.join(', ')})}`;
  }

  private tailwindParts(slot: Slot): TailwindParts {
    const {style} = slot;
    // A variant prop keys one map (a switch's checked state reads aria-checked instead: aria-checked:, group-aria-checked:).
    const mapped = (cond: Cond) => cond.dims.length === 1 && !cond.pseudo && !this.isChecked(cond.dims[0][0]);
    // A property a variant prop changes is written in every option of its map, the default's included, and never also in the
    // base: two utilities of one property on an element win by their order in Tailwind's stylesheet, not in the class list
    // (`bg-brand-500 bg-brand-50` is brand-500).
    const moved = new Map<number, Set<string>>();
    for (const rule of style.rules) {
      if (!mapped(rule.cond) || rule.cond.state) continue;
      const d = rule.cond.dims[0][0];
      let props = moved.get(d);
      if (!props) moved.set(d, props = new Set());
      for (const decl of rule.decls) props.add(decl.prop);
    }
    const movedProps = new Set([...moved.values()].flatMap(props => [...props]));
    const baseDecls = style.base.filter(decl => !decl.reset);
    const fixed: string[] = [];
    const base = tailwindClasses(baseDecls.filter(decl => !movedProps.has(decl.prop)), this.tw);
    if (base) fixed.push(base);
    const byDim = new Map<number, Map<string, string[]>>();
    for (const [d, props] of moved) {
      const options = new Map<string, string[]>();
      for (const option of optionIds(this.space, d)) {
        const own = style.rules.find(rule => mapped(rule.cond) && !rule.cond.state && rule.cond.dims[0][0] === d && rule.cond.dims[0][1] === option)?.decls ?? [];
        const classes = tailwindClasses([...baseDecls.filter(decl => props.has(decl.prop) && !own.some(mine => mine.prop === decl.prop)), ...own], this.tw);
        options.set(option, classes ? classes.split(' ') : []);
      }
      byDim.set(d, options);
    }
    for (const rule of style.rules) {
      if (mapped(rule.cond) && !rule.cond.state) continue;
      const classes = tailwindClasses(rule.decls, this.tw);
      if (!classes) continue;
      const state = rule.cond.state ? this.tailwindState(rule.cond.state, slot.root) : '';
      if (mapped(rule.cond)) {
        // A state of one option's look: in that option's entry, behind its state's variant.
        const [d, option] = rule.cond.dims[0];
        let options = byDim.get(d);
        if (!options) byDim.set(d, options = new Map());
        options.set(option, [...(options.get(option) ?? []), ...classes.split(' ').map(name => state + name)]);
        continue;
      }
      const prefix = rule.cond.dims.map(([d, option]) => this.tailwindDim(d, option, slot.root)).join('') + state + (rule.cond.pseudo ? 'placeholder:' : '');
      fixed.push(classes.split(' ').map(name => prefix + name).join(' '));
    }
    const maps: string[] = [];
    const ternaries: string[] = [];
    for (const [d, options] of byDim) {
      const prop = this.space.variantProps[d];
      this.markProp(prop.jsName);
      if (prop.kind === 'variantBool') {
        const yes = (options.get('true') ?? []).join(' '), no = (options.get('false') ?? []).join(' ');
        ternaries.push(yes && no ? `${prop.jsName} ? ${singleQuoted(yes)} : ${singleQuoted(no)}` : yes ? `${prop.jsName} && ${singleQuoted(yes)}` : `!${prop.jsName} && ${singleQuoted(no)}`);
        continue;
      }
      const name = this.idents.claim(slot.base + cap(prop.jsName));
      const entries = optionIds(this.space, d).map(option => `${/^[A-Za-z_$][\w$]*$|^\d+$/.test(option) ? option : singleQuoted(option)}: ${singleQuoted((options.get(option) ?? []).join(' '))}`);
      this.consts.push(`const ${name} = {${entries.join(', ')}};`);
      maps.push(`${name}[${prop.jsName}]`);
    }
    return {fixed: fixed.join(' '), maps, ternaries};
  }

  private isChecked(d: number): boolean {
    return this.space.variantProps[d].jsName === 'checked' && this.model?.checked !== null && this.model?.checked !== undefined;
  }

  /** The root's group, named after the component (`group/button`): a component inside another reacts to its own root only. */
  private get groupName(): string {
    return kebab(this.name);
  }

  /** A variant of the element itself (`hover:`), or of the component's root for an element inside it (`group-hover/button:`). */
  private tailwindVariant(variant: string, root: boolean): string {
    if (root) return `${variant}:`;
    this.groupUsed = true;
    return `group-${variant}/${this.groupName}:`;
  }

  private tailwindDim(d: number, option: string, root: boolean): string {
    const prop = this.space.variantProps[d];
    if (this.isChecked(d)) return this.tailwindVariant(option === 'true' ? 'aria-checked' : `aria-[checked=${option}]`, root);
    if (prop.kind === 'variantBool') return this.tailwindVariant(option === 'true' ? `data-${kebab(prop.jsName)}` : `not-data-${kebab(prop.jsName)}`, root);
    return this.tailwindVariant(`data-[${kebab(prop.jsName)}=${option}]`, root);
  }

  /** As the CSS Modules selectors (stateSelector): hover and press never paint over a disabled look. */
  private tailwindState(state: InteractiveState, root: boolean): string {
    const field = this.rootKind === 'field';
    const enabled = !this.stateDisabled ? '' : this.tailwindVariant(this.nativeDisabled ? 'enabled' : field ? 'not-has-[input:disabled]' : 'not-aria-disabled', root);
    switch (state) {
      case 'hover': return enabled + this.tailwindVariant('hover', root);
      case 'active': return enabled + this.tailwindVariant('active', root);
      case 'focus': return this.tailwindVariant(field ? 'focus-within' : 'focus-visible', root);
      case 'disabled': return this.tailwindVariant(this.nativeDisabled ? 'disabled' : field ? 'has-[input:disabled]' : 'aria-disabled', root);
    }
  }

  // Inline styles ──

  private inlineRules(slot: Slot) {
    return slot.style.rules.map((rule, index) => ({rule, index})).filter(({rule}) => {
      if (rule.cond.pseudo || (rule.cond.state && rule.cond.state !== 'disabled')) {
        this.warnStates();
        return false;
      }
      return true;
    });
  }

  private inlineAttr(slot: Slot | null, own: boolean): string {
    if (!slot) return own ? ' style={style}' : '';
    const modifiers = this.inlineRules(slot).map(({rule, index}) => {
      const tests = rule.cond.dims.map(([d, option]) => this.dimTest(d, option));
      if (rule.cond.state === 'disabled') {
        tests.push('disabled');
        this.markProp('disabled');
      }
      return `...(${tests.join(' && ')} ? styles.${slot.name}${this.inlineSuffix(rule.cond, index)} : undefined)`;
    });
    if (!modifiers.length && !own) return ` style={styles.${slot.name}}`;
    return ` style={{${[`...styles.${slot.name}`, ...modifiers, ...(own ? ['...style'] : [])].join(', ')}}}`;
  }

  private inlineSuffix(cond: Cond, index: number): string {
    const dims = cond.dims.map(([d, option]) => {
      const prop = this.space.variantProps[d];
      // A numeric option ("0.5", "-1") is part of a name here: `rootStep0_5`, `rootStepMinus1`.
      return prop.kind === 'variantBool' ? (option === 'true' ? cap(prop.jsName) : `Not${cap(prop.jsName)}`) : cap(prop.jsName) + cap(option.replace(/^-/, 'Minus').replace(/[^A-Za-z0-9]/g, '_'));
    }).join('');
    return (dims || (cond.state ? '' : String(index))) + (cond.state === 'disabled' ? 'Disabled' : '');
  }

  private inlineObjects(): string[] {
    const out: string[] = [];
    const seen = new Set<string>();
    for (const slot of this.slots) {
      if (seen.has(slot.name)) continue;
      seen.add(slot.name);
      out.push(`${INDENT}${slot.name}: {${slot.style.base.map(decl => this.inlineDecl(decl)).join(', ')}},`);
      for (const {rule, index} of this.inlineRules(slot)) out.push(`${INDENT}${slot.name}${this.inlineSuffix(rule.cond, index)}: {${rule.decls.map(decl => this.inlineDecl(decl)).join(', ')}},`);
    }
    if (out.length) this.typeImports.add('CSSProperties');
    return out;
  }

  private inlineDecl(decl: Decl): string {
    const value = formatValue(decl.prop, decl.value, this.shared.format);
    if (ASSET_MARK.test(value)) {
      ASSET_MARK.lastIndex = 0;
      return `${camelProp(decl.prop)}: \`${value.replace(/`/g, '\\`').replace(ASSET_MARK, (_, ref: string) => '${' + this.assetIdent(ref) + '}')}\``;
    }
    return `${camelProp(decl.prop)}: ${this.vue ? vueStyleValue(decl.prop, value) : styleValue(decl.prop, value)}`;
  }

  private warnStates() {
    if (this.warnedStates) return;
    this.warnedStates = true;
    this.shared.warn(`"${this.sourceName}": inline styles cannot do :hover, :focus and ::placeholder, so these states were not carried over. They are available in CSS Modules and Tailwind.`);
  }

  private dimTest(d: number, option: string): string {
    const prop = this.space.variantProps[d];
    this.markProp(prop.jsName);
    if (prop.kind === 'variantBool') return option === 'true' ? prop.jsName : `!${prop.jsName}`;
    return `${prop.jsName} === ${optionLiteral(prop, option)}`;
  }

  // Vue ──────────────────────────────────────────────────────────────────────────────────────

  /** A field component hands its class and style to its box and every other attribute to its input (`inheritAttrs: false`). */
  private get vueField() {
    return this.kind === 'component' && this.rootKind === 'field';
  }

  /** The props a template reads as slots: the label (`default`) and instance swaps, with their fallback markup. */
  private vueSlotsCache: Map<string, {name: string; fallback: string}> | null = null;
  private get vueSlots(): Map<string, {name: string; fallback: string}> {
    if (this.vueSlotsCache) return this.vueSlotsCache;
    const out = new Map<string, {name: string; fallback: string}>();
    for (const prop of this.model?.props ?? []) {
      if (prop.kind === 'slot') {
        const fallback = defaultExpression(this.host, prop);
        for (const match of (fallback ?? '').matchAll(/<([A-Z][A-Za-z0-9_]*)/g)) this.importComponent(match[1]);
        out.set(prop.jsName, {name: prop.jsName, fallback: fallback ? jsxUsageToVue(fallback) : ''});
      } else if (prop.native === 'children') {
        out.set(prop.jsName, {name: 'default', fallback: typeof prop.defaultRaw === 'string' ? vueText(prop.defaultRaw) : ''});
      }
    }
    return (this.vueSlotsCache = out);
  }

  private readonly vueRename = (name: string) => {
    const slot = this.vueSlots.get(name);
    if (!slot) return undefined;
    const toggle = this.model && slot.name !== 'default' ? vueToggle(this.model, slot.name) : null;
    return toggle ? toggle.jsName : `$slots.${slot.name}`;
  };

  /** A usage's hidden swap (`icon={null}`) as the used component's toggle, `:showIcon="false"`. */
  private readonly vueHidden = (component: string, slot: string) => {
    for (const model of this.shared.models.values()) if (model.name === component) return vueToggle(model, slot)?.jsName;
    return undefined;
  };

  private vExpr(expr: string, attr = true): string {
    return vueExpr(expr, {attr, rename: this.vueRename});
  }

  /** Another component's declared props (a data array types a value of one as `ButtonProps['size']`). */
  private declaredProps(component: string): ReadonlySet<string> | null {
    for (const model of this.shared.models.values()) if (model.name === component) return new Set(ownProps(model, true).map(entry => entry.prop.jsName));
    return null;
  }

  private vueFile(built: JNode[], inline: string[], css: string, note?: string): string {
    // The template first: the script declares what it reads.
    const template = built.length ? this.vPrint(built, 1) : [];
    const {script, props, prelude, values} = this.vueScript();
    const imports: string[] = [];
    const types = [...this.typeImports].sort();
    if (values.length || types.length) imports.push(`import {${[...values.sort(), ...types.map(type => `type ${type}`)].join(', ')}} from 'vue';`);
    const from = this.kind === 'component' ? './' : '../components/';
    for (const [component, extra] of [...this.componentImports].sort(([a], [b]) => a.localeCompare(b))) {
      imports.push(`import ${component}${extra.size ? `, {${[...extra].sort().map(type => `type ${type}`).join(', ')}}` : ''} from '${from}${component}.vue';`);
    }
    for (const icon of [...this.iconImports].sort()) imports.push(`import ${icon} from '../icons/${icon}.vue';`);
    for (const [ref, ident] of this.assetImports) imports.push(`import ${ident} from '../assets/${this.shared.assetFor(ref).path.split('/').pop()}';`);
    const groups: string[][] = [imports, props];
    if (inline.length) groups.push(['const styles = {', ...inline, '} satisfies Record<string, CSSProperties>;']);
    groups.push(this.consts, ...this.arrays.map(array => this.printArray(array)), prelude);
    const setup = groups.filter(group => group.length).flatMap((group, index) => (index ? ['', ...group] : group));
    const comment = [`"${this.sourceName.replace(/\s+/g, ' ')}" from ${PRODUCT_NAME}.`, ...(note ? [note] : [])];
    return sfc({comment, script, setup, template, style: css});
  }

  /** The props type (exported from a plain <script>, so other files and data arrays can name it), defineProps with the
   *  design's defaults, and what a field needs: its attributes split between box and input, and its ids. */
  private vueScript(): {script: string[]; props: string[]; prelude: string[]; values: string[]} {
    const model = this.model;
    if (!model) return {script: [], props: [], prelude: [], values: []};
    const {styling} = this.shared;
    const own = ownProps(model, true);
    const api = stateApi(model);
    const fields: string[] = [];
    const defaults: string[] = [];
    for (const entry of own) {
      fields.push(`${INDENT}/** ${propComment(entry.prop)} */`, `${INDENT}${entry.prop.jsName}${entry.optional ? '?' : ''}: ${propType(entry.prop)};`);
      const fallback = defaultExpression(this.host, entry.prop);
      if (fallback !== null) defaults.push(`${entry.prop.jsName}: ${fallback}`);
    }
    // `disabled` is a prop when the template reads it (a div's aria-disabled, inline styles); otherwise a button's falls through.
    if ((api.disabled && !NATIVE_DISABLED.has(this.element)) || (styling === 'inline' && api.disabled && this.usedProps.has('disabled'))) {
      fields.push(`${INDENT}/** Disabled: the look of the disabled state${NATIVE_DISABLED.has(this.element) ? '' : ' and `aria-disabled`'}. */`, `${INDENT}disabled?: boolean;`);
      defaults.push('disabled: false');
    }
    if (this.needsId) fields.push(`${INDENT}/** Id of the field; without it, its own from useId(). */`, `${INDENT}id?: string;`);
    const values = new Set<string>();
    const props: string[] = [];
    const prelude: string[] = [];
    if (this.vueField) props.push('defineOptions({inheritAttrs: false});');
    if (fields.length) {
      const call = defaults.length ? `withDefaults(defineProps<${this.name}Props>(), {${defaults.join(', ')}})` : `defineProps<${this.name}Props>()`;
      props.push(this.needsId ? `const props = ${call};` : `${call};`);
    }
    if (this.vueField) {
      values.add('computed').add('useAttrs');
      prelude.push('const attrs = useAttrs();', 'const inputAttrs = computed(() => {', `${INDENT}const {class: _class, style: _style, ...rest} = attrs;`, `${INDENT}return rest;`, '});');
    }
    if (this.needsId) {
      values.add('computed').add('useId');
      prelude.push('const fallbackId = useId();', 'const inputId = computed(() => props.id ?? fallbackId);');
      if ([...this.fieldHints.keys()].length) prelude.push('const hintId = computed(() => `${inputId.value}-hint`);');
    }
    const script = fields.length ? [`export type ${this.name}Props = {`, ...fields, '};'] : [];
    return {script, props, prelude, values: [...values]};
  }

  private vPrint(nodes: JNode[], depth: number): string[] {
    return nodes.flatMap(node => this.vPrintNode(node, depth, true));
  }

  private vPrintNode(node: JNode, depth: number, ownLine: boolean): string[] {
    const pad = INDENT.repeat(depth);
    switch (node.kind) {
      case 'text': return [`${pad}${vueText(node.text, ownLine)}`];
      case 'expr': return [`${pad}${this.vContent(node.expr)}`];
      case 'br': return [`${pad}<br />`];
      case 'raw': {
        const classAttr = this.vClassAttr(node.slot, true);
        return node.lines.map(line => pad + line.replace(CLASS_MARK, classAttr));
      }
      case 'map': return this.vPrintElement(node.body, depth, node);
      case 'el': return this.vPrintElement(node, depth);
    }
  }

  /** An expression child: a slot where it is the label or a swap, else an interpolation. */
  private vContent(expr: string): string {
    const slots = this.vueSlots;
    const own = slots.get(expr.trim()) ?? [...exprIdents(expr)].map(name => slots.get(name)).find(Boolean);
    if (own) {
      const name = own.name === 'default' ? '' : ` name="${own.name}"`;
      return own.fallback ? `<slot${name}>${own.fallback}</slot>` : `<slot${name} />`;
    }
    return `{{ ${this.vExpr(expr, false)} }}`;
  }

  private vPrintElement(el: JEl, depth: number, loop?: JMap): string[] {
    const pad = INDENT.repeat(depth);
    // A repeated item's icon read from its data: <component :is="item.icon">.
    const dynamic = !!el.icon && !/^[A-Z][A-Za-z0-9_]*$/.test(el.tag);
    const tag = dynamic ? 'component' : el.tag;
    const open = this.vOpenTag(el, dynamic, loop);
    const slots = el.component ? slotTemplates(el.attrs) : [];
    if (tag === 'input' || tag === 'img' || tag === 'br' || (!el.children.length && !slots.length)) return [`${pad}${open} />`];
    if (!slots.length && this.oneLine(el)) {
      const line = `${pad}${open}>${el.children.map(child => this.vPrintNode(child, 0, false).join('')).join('')}</${tag}>`;
      // A text on lines of its own would gain the spaces the template condenses its line breaks to.
      if (line.length <= MAX_LINE || PHRASING.has(tag) || el.children.every(child => child.kind !== 'el')) return [line];
    }
    // Text and inline elements next to each other stay on one line: line breaks between them would be spaces.
    const lines: string[] = [];
    let run: JNode[] = [];
    const flush = () => {
      if (run.length === 1 && run[0].kind === 'el') lines.push(...this.vPrintNode(run[0], depth + 1, true));
      else if (run.length) lines.push(`${pad}${INDENT}${run.map(child => this.vPrintNode(child, 0, false).join('')).join('')}`);
      run = [];
    };
    for (const child of el.children) {
      if (child.kind === 'text' || child.kind === 'expr' || child.kind === 'br' || (child.kind === 'el' && this.inlineEl(child))) run.push(child);
      else {
        flush();
        lines.push(...this.vPrintNode(child, depth + 1, true));
      }
    }
    flush();
    return [`${pad}${open}>`, ...slots.map(slot => `${pad}${INDENT}${slot}`), ...lines, `${pad}</${tag}>`];
  }

  private vOpenTag(el: JEl, dynamic: boolean, loop?: JMap): string {
    const parts: string[] = [];
    if (loop) parts.push(` v-for="${loop.index ? `(${loop.item}, index)` : loop.item} in ${loop.array}"`);
    if (el.condition) parts.push(` v-if="${this.vExpr(el.condition)}"`);
    if (dynamic) parts.push(` :is="${el.tag}"`);
    if (el.key) parts.push(` :key="${this.vExpr(el.key)}"`);
    const attr = (a: Attr) => vueAttr(a, {html: !el.component, rename: this.vueRename});
    const attrs = el.component ? vueProps(el.tag, el.attrs, this.vueHidden) : el.attrs;
    if (!el.component) parts.push(...attrs.filter(a => LEADING_ATTRS.has(a.name)).map(attr));
    else parts.push(...attrs.map(attr));
    parts.push(this.vClassAttr(el.slot, el.root && !!this.model, el));
    if (!el.component) parts.push(...attrs.filter(a => !LEADING_ATTRS.has(a.name)).map(attr));
    if (el.root && this.model) parts.push(...this.rootDataAttrs().map(attr));
    if (el.spread && el.field === 'input') {
      if (this.shared.styling === 'inline' && this.stateDisabled) {
        parts.push(' :disabled="disabled"');
        this.markProp('disabled');
      }
      parts.push(' v-bind="inputAttrs"');
    }
    return `<${dynamic ? 'component' : el.tag}${parts.join('')}`;
  }

  /** The element's class or style binding. Vue merges a usage's class and style into the root by itself; a field's box
   *  takes them from $attrs. */
  private vClassAttr(slot: Slot | null, root: boolean, el?: JEl): string {
    const {styling} = this.shared;
    const field = root && (!el || !el.field) && this.vueField;
    const list = (items: string[]) => (items.length === 1 ? items[0] : `[${items.join(', ')}]`);
    if (styling === 'inline') {
      const items = slot ? [`styles.${slot.name}`, ...this.inlineRules(slot).map(({rule, index}) => {
        const tests = rule.cond.dims.map(([d, option]) => this.dimTest(d, option));
        if (rule.cond.state === 'disabled') {
          tests.push('disabled');
          this.markProp('disabled');
        }
        return `${tests.join(' && ')} ? styles.${slot.name}${this.inlineSuffix(rule.cond, index)} : undefined`;
      })] : [];
      if (field) items.push('$attrs.style');
      return (field ? ' :class="$attrs.class"' : '') + (items.length ? ` :style="${this.vExpr(list(items))}"` : '');
    }
    if (styling === 'tailwind') {
      const tw = slot?.tailwind;
      let fixed = tw?.fixed ?? '';
      const items = [...(tw?.ternaries ?? []), ...(tw?.maps ?? [])];
      if (fixed.includes("'") && fixed.includes('"')) {
        items.unshift(singleQuoted(fixed));
        fixed = '';
      }
      if (field) items.push('$attrs.class');
      return (fixed ? (fixed.includes('"') ? ` class='${fixed}'` : ` class="${fixed}"`) : '') + (items.length ? ` :class="${this.vExpr(list(items))}"` : '') + (field ? ' :style="$attrs.style"' : '');
    }
    const items = [...(slot ? [`$style.${slot.name}`] : []), ...(field ? ['$attrs.class'] : [])];
    return (items.length ? ` :class="${list(items)}"` : '') + (field ? ' :style="$attrs.style"' : '');
  }

  /** As rootSvg, in template syntax: each picture's content in a <template v-if>. */
  private vueRootSvg(groups: {variants: number[]}[], present: number[], base: number, el: El, svgOf: (r: number) => InlineSvg, slot: Slot): JRaw {
    const attribute = (name: string, valueOf: (r: number) => string) => {
      const expression = switchExpression(this.space, present, r => singleQuoted(valueOf(r)), base);
      this.markTest(expression);
      return expression === singleQuoted(valueOf(base)) ? ` ${name}="${valueOf(base)}"` : ` :${name}="${this.vExpr(expression)}"`;
    };
    const size = attribute('width', r => num(svgOf(r).box.width, 3)) + attribute('height', r => num(svgOf(r).box.height, 3)) + attribute('viewBox', r => svgOf(r).viewBox);
    const prefix = kebab(this.name);
    const lines: string[] = [`<svg${size} fill="none" overflow="visible" aria-hidden="true"${CLASS_MARK}>`];
    if (groups.length === 1) lines.push(...svgChildrenVue(el.svg!.root, INDENT).map(line => line.split(`${SVG_ID_PREFIX}-`).join(`${prefix}-`)));
    else groups.forEach((group, index) => {
      const test = presenceCondition(this.space, present, new Set(group.variants));
      this.markTest(test);
      const content = svgChildrenVue(svgOf(group.variants[0]).root, INDENT.repeat(2)).map(line => line.split(`${SVG_ID_PREFIX}-`).join(`${prefix}${index ? `-v${index + 1}` : ''}-`));
      lines.push(`${INDENT}<template v-if="${this.vExpr(test ?? 'true')}">`, ...content, `${INDENT}</template>`);
    });
    lines.push('</svg>');
    return {kind: 'raw', lines, slot};
  }
}

/** A component's own props as its type declares them: the state's prop for a state dimension, not the booleans merged into
 *  a text or a swap, not the element's own (`children`, `placeholder`); a Vue component's swaps are slots. */
function ownProps(model: ComponentModel, vue: boolean): {prop: PropDef; optional: boolean}[] {
  const own: {prop: PropDef; optional: boolean}[] = [];
  const state = model.state ? model.variantProps[model.state.prop] : null;
  const api = stateApi(model);
  for (const prop of model.props) {
    if (prop === state) {
      if (api.prop) own.push({prop: api.prop, optional: true});
      continue;
    }
    if ((prop.kind === 'boolean' && prop.mergedInto && !(vue && vueToggle(model, prop.mergedInto) === prop)) || prop.native || (vue && prop.kind === 'slot')) continue;
    own.push({prop, optional: prop.kind !== 'text' || !!prop.optional});
  }
  return own;
}

/** The show/hide boolean merged into an optional swap that has a default (React hides it with `icon={null}`): a Vue
 *  slot's fallback cannot be turned off from outside, so the boolean stays a prop (`showIcon`). */
function vueToggle(model: ComponentModel, slotName: string): PropDef | null {
  const slot = model.props.find(prop => prop.kind === 'slot' && prop.jsName === slotName);
  if (!slot?.optional || !slot.defaultComponent) return null;
  return model.props.find(prop => prop.kind === 'boolean' && prop.mergedInto === slotName) ?? null;
}

/** A Vue usage's props: swaps are slots (slotTemplates), and a hidden swap is its toggle set to false. */
function vueProps(component: string, attrs: readonly Attr[], hidden: (component: string, slot: string) => string | undefined): Attr[] {
  return attrs.flatMap(attr => {
    if (!isSlotValue(attr)) return [attr];
    const toggle = attr.value === 'null' ? hidden(component, attr.name) : undefined;
    return toggle ? [{name: toggle, value: 'false', expr: true}] : [];
  });
}

const vueHiddenOf = (models: ReadonlyMap<NodeId, ComponentModel>) => (component: string, slot: string) => {
  for (const model of models.values()) if (model.name === component) return vueToggle(model, slot)?.jsName;
  return undefined;
};

/** A declaration value for a Vue style object: lengths keep their unit (Vue writes numbers as they are). */
function vueStyleValue(prop: string, value: string): string {
  if (UNITLESS.has(camelProp(prop)) && /^-?\d+(\.\d+)?$/.test(value)) return value;
  return value.includes("'") && !value.includes('"') ? JSON.stringify(value) : singleQuoted(value);
}

// ── Repeated items ─────────────────────────────────────────────────────────────────────────────

/** A part of an item that may vary: a text, a picture's attribute, an icon, a component's prop. `key` places it in the item. */
type ItemSlot = {key: string; field: string; type: string; value: string; literal: string; typeImports: string[]; propsOf?: string; slot?: boolean};

/** The structure of nodes with their varying parts left out (texts, pictures, icons and a component's props), as small
 *  numbers: equal numbers, equal structure. A node's number is worked out once, from its children's numbers (its children
 *  are final by then: repeats() folds bottom-up), so a deep tree is not serialised again at every level above it. */
class Shapes {
  private readonly numbers = new Map<string, number>();
  private readonly known = new WeakMap<JNode, number>();

  of(node: JNode): number {
    let number = this.known.get(node);
    if (number === undefined) {
      const key = this.key(node);
      number = this.numbers.get(key);
      if (number === undefined) this.numbers.set(key, number = this.numbers.size);
      this.known.set(node, number);
    }
    return number;
  }

  private key(node: JNode): string {
    switch (node.kind) {
      case 'text': return 'T';
      case 'expr': return `E${node.expr}`;
      case 'br': return 'B';
      case 'raw': return `R${node.lines.join('\n')}`;
      // Items holding a list of their own are not folded again: each keeps its list's data.
      case 'map': return `M${node.array}`;
      case 'el': {
        const attrs = node.component ? [] : node.attrs.filter(attr => !ITEM_ATTRS.has(attr.name)).map(attr => `${attr.name}=${attr.value}`);
        return JSON.stringify([node.icon ? 'ICON' : node.tag, node.slot?.sig ?? '', node.condition, attrs, node.children.map(child => this.of(child))]);
      }
    }
  }
}

const ITEM_ATTRS = new Set(['src', 'alt', 'href']);

/** Walks an item's varying parts in one order; `visit` gets each part's key, so the data and the markup agree. */
function walkSlots(node: JEl, visit: {text(key: string, text: string, owner: JEl): void; icon(key: string, el: JEl): void; attr(key: string, attr: Attr, el: JEl): void}) {
  const walk = (n: JNode, path: string, owner: JEl) => {
    if (n.kind === 'text') visit.text(`${path}:text`, n.text, owner);
    if (n.kind !== 'el') return;
    if (n.icon) visit.icon(`${path}:icon`, n);
    for (const attr of n.attrs) if (n.component || ITEM_ATTRS.has(attr.name)) visit.attr(`${path}:${n.component ? 'prop' : 'attr'}:${attr.name}`, attr, n);
    n.children.forEach((child, i) => walk(child, `${path}/${i}`, n));
  };
  walk(node, '', node);
}

/** `declared` (Vue): another component's declared props; a value of one it does not declare (a button's `disabled`, which
 *  falls through) is typed from its literal. */
function slotsOf(node: JEl, declared: ((component: string) => ReadonlySet<string> | null) | null = null): ItemSlot[] {
  const out: ItemSlot[] = [];
  const literalType = (attr: Attr) => (!attr.expr ? 'string' : attr.value === '' || attr.value === 'true' || attr.value === 'false' ? 'boolean' : /^-?\d+(\.\d+)?$/.test(attr.value) ? 'number' : 'string');
  walkSlots(node, {
    text: (key, text, owner) => out.push({key, field: fieldName(owner), type: 'string', value: text, literal: singleQuoted(text), typeImports: []}),
    icon: (key, el) => out.push(declared
      ? {key, field: 'icon', type: 'Component', value: el.tag, literal: el.tag, typeImports: ['Component']}
      : {key, field: 'icon', type: 'ComponentType<SVGProps<SVGSVGElement>>', value: el.tag, literal: el.tag, typeImports: ['ComponentType', 'SVGProps']}),
    attr: (key, attr, el) => {
      const typed = !declared || !!declared(el.tag)?.has(attr.name);
      out.push(el.component
        ? {key, field: attr.name, type: typed ? `${el.tag}Props['${attr.name}']` : literalType(attr), value: `${attr.expr}:${attr.value}`, literal: attr.expr ? (attr.value === '' ? 'true' : attr.value) : singleQuoted(attr.value), typeImports: [], ...(typed ? {propsOf: el.tag} : {}), slot: isSlotValue(attr)}
        : {key, field: attr.name === 'src' ? 'image' : attr.name, type: 'string', value: `${attr.expr}:${attr.value}`, literal: attr.expr ? attr.value : singleQuoted(attr.value), typeImports: []});
    },
  });
  return out;
}

/** A text's field: its element's role (title, label, value…), or `label` for a component's content. */
function fieldName(owner: JEl): string {
  if (owner.component) return 'label';
  const base = owner.slot?.base ?? 'text';
  const words = base.replace(/([a-z0-9])([A-Z])/g, '$1 $2').replace(/([A-Z])([A-Z][a-z])/g, '$1 $2').split(' ');
  const last = words[words.length - 1].toLowerCase();
  return /^(title|subtitle|label|value|text|caption|name|price|date|description|heading)$/.test(last) ? last : base;
}

/** A copy of the first item with its varying parts read from the item variable. */
function bindSlots(node: JEl, fieldAt: (key: string) => string | null, keys: readonly string[]): JEl {
  const copy = (n: JNode, path: string): JNode => {
    if (n.kind === 'text') {
      const field = fieldAt(`${path}:text`);
      return field ? {kind: 'expr', expr: field} : n;
    }
    if (n.kind !== 'el') return n;
    const out: JEl = {...n, attrs: [...n.attrs], children: []};
    if (n.icon) out.tag = fieldAt(`${path}:icon`) ?? n.tag;
    out.attrs = n.attrs.map(attr => {
      if (!n.component && !ITEM_ATTRS.has(attr.name)) return attr;
      const field = fieldAt(`${path}:${n.component ? 'prop' : 'attr'}:${attr.name}`);
      return field ? {name: attr.name, value: field, expr: true} : attr;
    });
    // A prop other items give and this one leaves out is still passed from the data.
    if (n.component) {
      for (const key of keys) {
        const match = key.startsWith(`${path}:prop:`) ? key.slice(`${path}:prop:`.length) : null;
        if (match && !match.includes('/') && !out.attrs.some(attr => attr.name === match)) out.attrs.push({name: match, value: fieldAt(key)!, expr: true});
      }
    }
    out.children = n.children.map((child, i) => copy(child, `${path}/${i}`));
    return out;
  };
  return copy(node, '') as JEl;
}

/** The item's classes are named after the item: the first item's `statey`, `stateyTitle` become `stat`, `statTitle`. */
function renameSlots(node: JEl, from: string, to: string) {
  const visit = (n: JNode) => {
    if (n.kind !== 'el') return;
    if (n.slot && n !== node && n.slot.base.startsWith(from) && n.slot.base !== from) n.slot.base = to + n.slot.base.slice(from.length);
    for (const child of n.children) visit(child);
  };
  visit(node);
  if (node.slot) node.slot.base = to;
}

/** The other items are not written: their classes go. */
function dropSlots(node: JEl, slots: Slot[]) {
  const visit = (n: JNode) => {
    if (n.kind !== 'el') return;
    if (n.slot) {
      const at = slots.indexOf(n.slot);
      if (at >= 0) slots.splice(at, 1);
    }
    for (const child of n.children) visit(child);
  };
  visit(node);
}

export {RESERVED as REACT_RESERVED_NAMES};
