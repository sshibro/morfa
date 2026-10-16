// What the MCP tools say about a document (docs/mcp-server.md §Tools): pure functions of a DesignDocument, no database, so tests run
// them on fixtures. The code comes from the "Code" tab's own writers (shared/design/codegen), so an assistant gets what dev mode shows.
import {
  cssColor,
  formatDeclarations,
  nodeToCss,
  toReact,
  collectTokens,
  tokensCss,
  type GeneratedFile,
} from '../../shared/design/codegen';
import {tailwindTheme} from '../../shared/design/codegen/tokens';
import {exportSvg} from '../../shared/design/svg-export';
import {fontFamilies} from '../../shared/fonts';
import type {TextMeasurer} from '../../shared/design/text-layout';
import {
  LIBRARY_PAGE_ID,
  type DesignDocument,
  type NodeId,
  type RGBA,
  type SceneNode,
  type VariableValue,
} from '../../shared/design/types';
import {ToolError} from './errors';

// ── Limits ──────────────────────────────────────────────────────────────────────────────────────────────────────────────────

/** Top-level layers listed per page in an outline. */
export const OUTLINE_LAYERS_PER_PAGE = 200;
/** Layers one layer tree may hold, and how deep it may go. */
export const MAX_TREE_NODES = 600;
export const MAX_TREE_DEPTH = 12;
/** Layers one code request may cover (the "Code" tab's live limit is of the same order). */
export const MAX_CODE_LAYERS = 4000;
/** The most text one answer carries (code files are cut there with a note). */
export const MAX_ANSWER_CHARS = 120_000;

// ── Links and targets ───────────────────────────────────────────────────────────────────────────────────────────────────────

const FILE_ID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;

/**
 * The file and layer a call is about: a Morfa link (`https://app.morfa.example/#design/<file>?node=<layer>`, what "Copy link"
 * gives), or a file id and an optional layer id. A layer id given beside a link wins over the link's.
 */
export function targetOf(input: {link?: string; fileId?: string; nodeId?: string}): {fileId: string; nodeId?: string} {
  let fileId = input.fileId?.trim(),
    nodeId = input.nodeId?.trim() || undefined;
  if (input.link) {
    const parsed = parseLink(input.link);
    if (!parsed)
      throw new ToolError(
        'invalid_input',
        'The link is not a Morfa file link.',
        'Pass a link like https://app.morfa.example/#design/<file id>?node=<layer id>, or fileId.',
      );
    fileId = parsed.fileId;
    nodeId ??= parsed.nodeId;
  }
  if (!fileId || !FILE_ID.test(fileId))
    throw new ToolError(
      'invalid_input',
      'A file is needed.',
      'Pass fileId (from morfa_list_files) or a Morfa link to the file.',
    );
  return {fileId, ...(nodeId ? {nodeId} : {})};
}

export function parseLink(link: string): {fileId: string; nodeId?: string} | undefined {
  let url: URL;
  try {
    url = new URL(link.trim());
  } catch {
    return;
  }
  const match = /^#design\/([^?]+)(?:\?(.*))?$/.exec(url.hash);
  if (!match) return;
  let fileId: string;
  try {
    fileId = decodeURIComponent(match[1]!);
  } catch {
    return;
  }
  if (!FILE_ID.test(fileId)) return;
  const node = new URLSearchParams(match[2] ?? '').get('node') ?? undefined;
  return {fileId, ...(node ? {nodeId: node} : {})};
}

/** The link that opens the file (at a layer) in the editor. */
export const fileLink = (origin: string, fileId: string, nodeId?: string) =>
  `${origin}/#design/${encodeURIComponent(fileId)}${nodeId ? `?node=${encodeURIComponent(nodeId)}` : ''}`;

/** A layer of the document that is drawn somewhere (not a page, not on the hidden library page). */
export function layerOf(doc: DesignDocument, nodeId: string): SceneNode {
  const node = Object.hasOwn(doc.nodes, nodeId) ? doc.nodes[nodeId] : undefined;
  if (!node || node.type === 'PAGE' || pageOf(doc, nodeId) === LIBRARY_PAGE_ID)
    throw new ToolError(
      'not_found',
      'No such layer in this file.',
      'Take layer ids from morfa_get_file or morfa_get_layers, or ask for a link to the layer.',
    );
  return node;
}

export function pageOf(doc: DesignDocument, nodeId: NodeId): NodeId | undefined {
  let node: SceneNode | undefined = doc.nodes[nodeId];
  for (let steps = 0; node && steps < 1000; steps++) {
    if (node.type === 'PAGE') return node.id;
    node = node.parentId ? doc.nodes[node.parentId] : undefined;
  }
}

/** Layers under (and including) the roots, up to `cap` + 1 (enough to say "more"). */
export function countLayers(doc: DesignDocument, roots: readonly NodeId[], cap: number): number {
  let count = 0;
  const stack = [...roots];
  while (stack.length && count <= cap) {
    const node = doc.nodes[stack.pop()!];
    if (!node) continue;
    count++;
    if (node.children) stack.push(...node.children);
  }
  return count;
}

// ── The outline of a file ───────────────────────────────────────────────────────────────────────────────────────────────────

export type OutlineLayer = {id: string; name: string; type: string; width: number; height: number; layers: number};
export type OutlinePage = {id: string; name: string; layers: OutlineLayer[]; more?: number};

const round = (value: number) => Math.round(value * 100) / 100;

/** The file's pages in panel order and each page's top-level layers (frames, sections, components), top of the panel first. */
export function fileOutline(
  doc: DesignDocument,
  pageId?: string,
): {pages: OutlinePage[]; components: number; styles: number; variables: number} {
  const pageIds = pageId ? doc.pages.filter(id => id === pageId) : doc.pages;
  if (pageId && !pageIds.length)
    throw new ToolError('not_found', 'No such page in this file.', 'Take page ids from morfa_get_file without pageId.');
  const pages = pageIds.flatMap(id => {
    const page = doc.nodes[id];
    if (!page) return [];
    // Children are bottom to top; the panel lists the top first.
    const children = [...(page.children ?? [])]
      .reverse()
      .map(child => doc.nodes[child])
      .filter((node): node is SceneNode => !!node);
    const shown = children.slice(0, OUTLINE_LAYERS_PER_PAGE).map(node => ({
      id: node.id,
      name: node.name,
      type: node.type,
      width: round(node.width),
      height: round(node.height),
      layers: countLayers(doc, [node.id], 100_000) - 1,
    }));
    return [
      {
        id,
        name: page.name,
        layers: shown,
        ...(children.length > shown.length ? {more: children.length - shown.length} : {}),
      },
    ];
  });
  const components = Object.values(doc.nodes).filter(
    node => node.type === 'COMPONENT' || node.type === 'COMPONENT_SET',
  ).length;
  return {pages, components, styles: Object.keys(doc.styles).length, variables: Object.keys(doc.variables).length};
}

// ── A layer tree ────────────────────────────────────────────────────────────────────────────────────────────────────────────

export type TreeLayer = {
  id: string;
  name: string;
  type: string;
  x: number;
  y: number;
  width: number;
  height: number;
  hidden?: true;
  text?: string;
  component?: {id: string; name: string; properties?: Record<string, string | boolean>};
  styles?: Record<string, string>;
  css?: string;
  children?: TreeLayer[];
  /** Children not shown (the depth or the size of the answer ran out). */
  more?: number;
};

const fontFallbackOf = (() => {
  let table: Map<string, string> | null = null;
  return (family: string): string | undefined => {
    table ??= new Map(Object.values(fontFamilies).map(font => [font.family, font.fallback] as const));
    return table.get(family);
  };
})();

const TEXT_CHARS = 2000;

/** The layer and what is under it, top of the panel first: geometry, text, component, the styles it uses, and its CSS as dev mode
 *  writes it. `depth` 0 is the layer alone. The tree stops at MAX_TREE_NODES layers and says how many children it left out. */
export function layerTree(
  doc: DesignDocument,
  rootId: string,
  options: {depth: number; css: boolean},
): {tree: TreeLayer; shown: number; truncated: boolean} {
  layerOf(doc, rootId);
  let shown = 0,
    truncated = false;
  const styleName = (id: string | undefined) => (id && doc.styles[id] ? doc.styles[id].name : undefined);
  const visit = (id: NodeId, depth: number): TreeLayer | undefined => {
    const node = doc.nodes[id];
    if (!node) return;
    shown++;
    const styles: Record<string, string> = {};
    for (const [kind, styleId] of [
      ['fill', node.fillStyleId],
      ['stroke', node.strokeStyleId],
      ['effect', node.effectStyleId],
      ['text', node.textStyleId],
    ] as const) {
      const name = styleName(styleId);
      if (name) styles[kind] = name;
    }
    const main = node.componentId ? doc.nodes[node.componentId] : undefined;
    let css: string | undefined;
    if (options.css) {
      try {
        css = formatDeclarations(nodeToCss(doc, id, {fontFallback: fontFallbackOf}), {titles: false}) || undefined;
      } catch {
        css = undefined;
      }
    }
    const layer: TreeLayer = {
      id: node.id,
      name: node.name,
      type: node.type,
      x: round(node.x),
      y: round(node.y),
      width: round(node.width),
      height: round(node.height),
      ...(node.visible === false ? {hidden: true as const} : {}),
      ...(node.text ? {text: node.text.characters.slice(0, TEXT_CHARS)} : {}),
      ...(node.type === 'INSTANCE' && node.componentId
        ? {
            component: {
              id: node.componentId,
              name: main?.name ?? '',
              ...(node.componentProperties ? {properties: node.componentProperties} : {}),
            },
          }
        : {}),
      ...(Object.keys(styles).length ? {styles} : {}),
      ...(css ? {css} : {}),
    };
    const children = [...(node.children ?? [])].reverse();
    if (!children.length) return layer;
    if (depth >= options.depth) return {...layer, more: children.length};
    const out: TreeLayer[] = [];
    for (const child of children) {
      if (shown >= MAX_TREE_NODES) {
        truncated = true;
        break;
      }
      const visited = visit(child, depth + 1);
      if (visited) out.push(visited);
    }
    return {...layer, children: out, ...(out.length < children.length ? {more: children.length - out.length} : {})};
  };
  return {tree: visit(rootId, 0)!, shown, truncated};
}

// ── Code ────────────────────────────────────────────────────────────────────────────────────────────────────────────────────

export const CODE_FORMATS = ['react', 'react-tailwind', 'react-inline', 'css', 'svg', 'tokens'] as const;
export type CodeFormatName = (typeof CODE_FORMATS)[number];

/** Rough widths when the server's text shaper is not built: half an em per character, as the codegen's own fallback. */
export const ROUGH_MEASURER: TextMeasurer = {
  width: (text, font) => text.length * font.size * 0.55,
  metrics: font => ({ascent: font.size * 0.8, descent: font.size * 0.2}),
};

/** The code of a layer in one of the "Code" tab's languages: React with CSS Modules, Tailwind or inline styles, plain CSS, SVG, or the
 *  file's design tokens (CSS variables, a Tailwind theme and a TypeScript table). Picture paths are where the files would go in a
 *  project (`assets/…`); the pictures themselves are not sent. */
export function codeFor(
  doc: DesignDocument,
  nodeId: string | undefined,
  format: CodeFormatName,
  measurer: TextMeasurer = ROUGH_MEASURER,
): {files: GeneratedFile[]; warnings: string[]; assets: string[]} {
  if (format === 'tokens') {
    const tokens = collectTokens(doc, {fontFallback: fontFallbackOf});
    const css = tokensCss(tokens);
    return {
      files: css
        ? [
            {path: 'src/tokens.css', contents: css},
            {path: 'src/theme.css', contents: tailwindTheme(tokens, new Map())},
          ]
        : [],
      warnings: css ? [] : ['This file has no styles or variables.'],
      assets: [],
    };
  }
  if (!nodeId)
    throw new ToolError(
      'invalid_input',
      'A layer is needed for this format.',
      'Pass nodeId (a frame or component from morfa_get_file), or a link to the layer.',
    );
  const node = layerOf(doc, nodeId);
  if (countLayers(doc, [nodeId], MAX_CODE_LAYERS) > MAX_CODE_LAYERS)
    throw new ToolError(
      'too_large',
      `This layer holds more than ${MAX_CODE_LAYERS} layers.`,
      'Ask for the code of a smaller frame inside it (see morfa_get_layers).',
    );
  if (format === 'css') {
    const css = formatDeclarations(nodeToCss(doc, nodeId, {fontFallback: fontFallbackOf}), {titles: false});
    return {
      files: [
        {
          path: 'style.css',
          contents: `/* ${node.name.replace(/\*\//g, '* /')} */\n.layer {\n${css.replace(/^/gm, '  ')}\n}\n`,
        },
      ],
      warnings: [],
      assets: [],
    };
  }
  if (format === 'svg') {
    // Pictures are left out (grey), as the file's pictures are not sent.
    return {files: [{path: 'layer.svg', contents: exportSvg(doc, [nodeId], {measurer})}], warnings: [], assets: []};
  }
  const styling = format === 'react-tailwind' ? 'tailwind' : format === 'react-inline' ? 'inline' : 'css-modules';
  const result = toReact(doc, [nodeId], {styling, measurer, fontFallback: fontFallbackOf});
  const entry = result.entries[0];
  const first = new Set(entry?.files ?? []);
  const files = [...result.files].sort((a, b) => Number(first.has(b.path)) - Number(first.has(a.path)));
  return {files, warnings: result.warnings, assets: result.assets.map(asset => asset.path)};
}

/** Files cut to the answer's size, in order; the rest named so the model can ask for a smaller frame. */
export function capFiles(
  files: readonly GeneratedFile[],
  max: number = MAX_ANSWER_CHARS,
): {files: GeneratedFile[]; omitted: string[]} {
  const kept: GeneratedFile[] = [],
    omitted: string[] = [];
  let used = 0;
  for (const file of files) {
    if (used + file.contents.length <= max) {
      kept.push(file);
      used += file.contents.length;
    } else omitted.push(file.path);
  }
  return {files: kept, omitted};
}

// ── Variables and styles ────────────────────────────────────────────────────────────────────────────────────────────────────

const isAlias = (value: VariableValue): value is {type: 'VARIABLE_ALIAS'; id: string} =>
  typeof value === 'object' && value !== null && (value as {type?: string}).type === 'VARIABLE_ALIAS';
const isColor = (value: VariableValue): value is RGBA => typeof value === 'object' && value !== null && 'r' in value;

export function variableValue(doc: DesignDocument, value: VariableValue): string | number | boolean {
  if (isAlias(value)) return `{${doc.variables[value.id]?.name ?? value.id}}`;
  if (isColor(value)) return cssColor(value, value.a ?? 1);
  return value as string | number | boolean;
}

/** The file's variables by collection (each value per mode; an alias as `{name}`) and its styles by type. */
export function variablesAndStyles(doc: DesignDocument) {
  const collections = Object.values(doc.variableCollections).map(collection => ({
    id: collection.id,
    name: collection.name,
    modes: collection.modes.map(mode => mode.name),
    ...(collection.remote ? {fromLibrary: true} : {}),
    variables: collection.variableIds
      .map(id => doc.variables[id])
      .filter(variable => !!variable)
      .map(variable => ({
        id: variable.id,
        name: variable.name,
        type: variable.type,
        ...(variable.description ? {description: variable.description} : {}),
        values: Object.fromEntries(
          collection.modes
            .filter(mode => mode.modeId in variable.valuesByMode)
            .map(mode => [mode.name, variableValue(doc, variable.valuesByMode[mode.modeId]!)]),
        ),
      })),
  }));
  const styles = Object.values(doc.styles).map(style => {
    const value =
      style.type === 'TEXT' && style.text
        ? {
            fontFamily: style.text.fontFamily,
            fontSize: style.text.fontSize,
            fontWeight: style.text.fontWeight,
            lineHeight: style.text.lineHeight,
            letterSpacing: style.text.letterSpacing,
          }
        : style.type === 'FILL' && style.paints
          ? {
              paints: style.paints.map(paint =>
                paint.type === 'SOLID' ? cssColor(paint.color, paint.opacity ?? 1) : paint.type,
              ),
            }
          : style.type === 'EFFECT' && style.effects
            ? {effects: style.effects.map(effect => effect.type)}
            : {};
    return {
      id: style.id,
      name: style.name,
      type: style.type,
      ...(style.description ? {description: style.description} : {}),
      ...value,
    };
  });
  return {collections, styles};
}
