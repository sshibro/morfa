import type {BoardShapeKind} from '../../../shared/design/board/types';
import {createConnector, createShape, type BoardBuild, type NewId} from '../../../shared/design/board/create';

// Mermaid flowcharts pasted on a board become a diagram (help.figma.com "Create diagrams and flows with connectors": "Paste
// Mermaid.js syntax onto the board to render diagrams like flowcharts"): a shape per node, a connector per edge, laid out in layers
// along the chart's direction. The part of the syntax read here: `graph`/`flowchart` with TD, TB, BT, LR or RL; nodes `A`, `A[..]`,
// `A(..)`, `A([..])`, `A((..))`, `A{..}`, `A{{..}}`, `A[(..)]`, `A[/../]`, `A[\..\]`, `A>..]`; edges `-->`, `---`, `-.->`, `==>`
// with a label `-->|..|` or `-- .. -->`, chained (`A --> B --> C`) and joined with `&`; `%%` comments. Other diagram kinds
// (sequence, ER, class…) are not read.

export type MermaidNode = {id: string; text: string; shape: BoardShapeKind};
export type MermaidEdge = {from: string; to: string; label?: string; arrow: boolean; dashed: boolean; thick: boolean};
export type MermaidChart = {direction: 'TD' | 'BT' | 'LR' | 'RL'; nodes: MermaidNode[]; edges: MermaidEdge[]};

export const MERMAID_MAX_NODES = 200;
const SHAPE_W = 200, SHAPE_H = 100, GAP_ALONG = 120, GAP_ACROSS = 60;

const NODE_FORMS: {open: string; close: string; shape: BoardShapeKind}[] = [
  {open: '(((', close: ')))', shape: 'ellipse'},
  {open: '((', close: '))', shape: 'ellipse'},
  {open: '([', close: '])', shape: 'rounded'},
  {open: '[(', close: ')]', shape: 'cylinder'},
  {open: '[[', close: ']]', shape: 'square'},
  {open: '{{', close: '}}', shape: 'hexagon'},
  {open: '[/', close: '/]', shape: 'parallelogram'},
  {open: '[\\', close: '\\]', shape: 'parallelogram-left'},
  {open: '[/', close: '\\]', shape: 'trapezoid'},
  {open: '>', close: ']', shape: 'chevron'},
  {open: '[', close: ']', shape: 'square'},
  {open: '(', close: ')', shape: 'rounded'},
  {open: '{', close: '}', shape: 'diamond'},
];

// An id: letters, digits, _ and inner hyphens (a hyphen before another hyphen, a dot or > starts a link).
const ID = /^[A-Za-z0-9_\u0400-\u04FF](?:[\w\u0400-\u04FF]|-(?=[\w\u0400-\u04FF]))*/;
// An edge: its link, then an optional |label|. `-- text -->` is rewritten to `-->|text|` first.
const LINK = /^\s*(<?(?:-{2,}>|-{3,}|-\.+->|-\.+-|={2,}>|={3,}))\s*(?:\|([^|]*)\|)?\s*/;

const unquote = (text: string) => text.trim().replace(/^"(.*)"$/s, '$1').replace(/<br\s*\/?>/gi, '\n').replace(/&quot;/g, '"').replace(/&amp;/g, '&');

/** A node at the start of `source`: its id, text and shape, and what follows; null when none starts there. */
function readNode(source: string): {node: MermaidNode; rest: string} | null {
  const id = ID.exec(source)?.[0];
  if (!id) return null;
  let rest = source.slice(id.length);
  for (const form of NODE_FORMS) {
    if (!rest.startsWith(form.open)) continue;
    const end = rest.indexOf(form.close, form.open.length);
    if (end < 0) continue;
    const text = unquote(rest.slice(form.open.length, end));
    rest = rest.slice(end + form.close.length);
    return {node: {id, text, shape: form.shape}, rest};
  }
  return {node: {id, text: id, shape: 'square'}, rest};
}

/** A group of nodes joined by `&`. */
function readGroup(source: string): {nodes: MermaidNode[]; rest: string} | null {
  const nodes: MermaidNode[] = [];
  let rest = source;
  for (;;) {
    const read = readNode(rest.trimStart());
    if (!read) return nodes.length ? {nodes, rest} : null;
    nodes.push(read.node);
    rest = read.rest;
    const and = /^\s*&\s*/.exec(rest);
    if (!and) return {nodes, rest};
    rest = rest.slice(and[0].length);
  }
}

/** The flowchart a pasted text describes, or null when it is not one. */
export function parseMermaid(text: string): MermaidChart | null {
  const lines = text.replace(/\r\n?/g, '\n').split(/\n|;/).map(line => line.replace(/%%.*$/, '').trim()).filter(Boolean);
  const header = /^(?:graph|flowchart)(?:\s+(TD|TB|BT|LR|RL))?\s*$/i.exec(lines[0] ?? '');
  if (!header) return null;
  const direction = ((header[1] ?? 'TD').toUpperCase().replace('TB', 'TD')) as MermaidChart['direction'];
  const nodes = new Map<string, MermaidNode>();
  const edges: MermaidEdge[] = [];
  const keep = (node: MermaidNode) => {
    const known = nodes.get(node.id);
    // A later mention with a shape gives the text and shape; a bare id keeps what was said before.
    if (!known || node.text !== node.id || node.shape !== 'square') nodes.set(node.id, known && node.text === node.id && node.shape === 'square' ? known : node);
  };
  for (const raw of lines.slice(1)) {
    if (/^(?:subgraph|end|direction|classDef|class|style|linkStyle|click)\b/.test(raw)) continue;
    // `A -- text --> B` reads as `A -->|text| B`.
    let rest = raw.replace(/(-{2}|={2}|-\.)\s+([^->|=.][^>|]*?)\s+(-{2,}>|={2,}>|\.->|-{3,})/g, (_, _open, label, link) => `${link.startsWith('.') ? '-.' + link : link}|${label}|`);
    let left = readGroup(rest);
    if (!left) continue;
    left.nodes.forEach(keep);
    rest = left.rest;
    for (;;) {
      const link = LINK.exec(rest);
      if (!link) break;
      const right = readGroup(rest.slice(link[0].length));
      if (!right) break;
      right.nodes.forEach(keep);
      const kind = link[1];
      for (const from of left.nodes) {
        for (const to of right.nodes) {
          edges.push({from: from.id, to: to.id, label: link[2] ? unquote(link[2]) : undefined, arrow: kind.endsWith('>'), dashed: kind.includes('.'), thick: kind.includes('=')});
        }
      }
      left = right;
      rest = right.rest;
    }
    if (nodes.size > MERMAID_MAX_NODES) return null;
  }
  return nodes.size ? {direction, nodes: [...nodes.values()], edges} : null;
}

/** Each node's layer: the longest run of edges into it, leaving out the edges that close a loop (found depth-first in the
 *  order the chart names its nodes), so `D -.-> B` back up a chart keeps B where it was. */
export function mermaidLayers(chart: MermaidChart): Map<string, number> {
  const out = new Map<string, MermaidEdge[]>(chart.nodes.map(node => [node.id, []]));
  for (const edge of chart.edges) out.get(edge.from)!.push(edge);
  const back = new Set<MermaidEdge>();
  const state = new Map<string, 'open' | 'done'>();
  const visit = (id: string) => {
    state.set(id, 'open');
    for (const edge of out.get(id)!) {
      const seen = state.get(edge.to);
      if (seen === 'open') back.add(edge);
      else if (!seen) visit(edge.to);
    }
    state.set(id, 'done');
  };
  for (const node of chart.nodes) if (!state.has(node.id)) visit(node.id);
  const forward = chart.edges.filter(edge => !back.has(edge) && edge.from !== edge.to);
  const layer = new Map(chart.nodes.map(node => [node.id, 0]));
  for (let pass = 0; pass < chart.nodes.length; pass++) {
    let changed = false;
    for (const edge of forward) {
      const next = layer.get(edge.from)! + 1;
      if (next > layer.get(edge.to)!) {
        layer.set(edge.to, next);
        changed = true;
      }
    }
    if (!changed) break;
  }
  return layer;
}

/** The chart as board objects centred on `centre`: shapes first, then connectors between them. */
export function mermaidBuilds(newId: NewId, chart: MermaidChart, centre: {x: number; y: number}, fill?: string): BoardBuild[] {
  const layers = mermaidLayers(chart);
  const rows = new Map<number, MermaidNode[]>();
  for (const node of chart.nodes) rows.set(layers.get(node.id)!, [...(rows.get(layers.get(node.id)!) ?? []), node]);
  const depth = Math.max(...rows.keys()) + 1;
  const across = chart.direction === 'LR' || chart.direction === 'RL' ? 'y' : 'x';
  const reverse = chart.direction === 'BT' || chart.direction === 'RL';
  const stepAlong = (across === 'x' ? SHAPE_H : SHAPE_W) + GAP_ALONG, stepAcross = (across === 'x' ? SHAPE_W : SHAPE_H) + GAP_ACROSS;
  const spanAlong = depth * stepAlong - GAP_ALONG;
  const shapes = new Map<string, BoardBuild>();
  for (const [level, row] of rows) {
    const along = (reverse ? depth - 1 - level : level) * stepAlong - spanAlong / 2;
    row.forEach((node, k) => {
      const acrossAt = k * stepAcross - (row.length * stepAcross - GAP_ACROSS) / 2;
      const [dx, dy] = across === 'x' ? [acrossAt, along] : [along, acrossAt];
      shapes.set(node.id, createShape(newId, {x: Math.round(centre.x + dx), y: Math.round(centre.y + dy), shape: node.shape, text: node.text, width: SHAPE_W, height: SHAPE_H, fill}));
    });
  }
  const links = chart.edges.map(edge => createConnector(newId, {
    start: {node: shapes.get(edge.from)!.id, magnet: 'auto'}, end: {node: shapes.get(edge.to)!.id, magnet: 'auto'}, line: 'elbow',
    endMarker: edge.arrow ? 'LINE_ARROW' : 'NONE', dashed: edge.dashed, weight: edge.thick ? 6 : undefined, label: edge.label,
  }));
  return [...shapes.values(), ...links];
}
