// "Code" per document change: what the tab recomputes when a co-editor changes a layer somewhere in the
// file, with one screen selected. Until 2026-10-09 every memo of the panel was keyed on the document, so each settled
// change regenerated the selection's code, the token table (never cached with the editor's font fallback) and every
// section, and the notes walked the whole page. Now the panel keeps the document object while nothing in the selection's
// scope changed (src/design/panels/code/scope.ts): such a change costs one pass over the scope. Both are measured here on
// the same remote changes, through the store, with the work the panel does per change; a change inside the selection is
// measured too (the scope is rebuilt and the code regenerated, as before).
//   tsx scripts/bench/code-panel.ts [--changes 40]
import type {DocumentPatch} from '../../shared/design/patch';
import type {DesignDocument, NodeId, SceneNode} from '../../shared/design/types';
import type {TextMeasurer} from '../../shared/design/text-layout';
import {pageAnnotations} from '../../shared/design/annotations';
import {DEFAULT_FORMAT} from '../../shared/design/codegen/format';
import {toReact} from '../../shared/design/codegen/react';
import {collectTokens, suggestTokens} from '../../shared/design/codegen/tokens';
import {pageMeasurements} from '../../shared/design/measurements';
import {topLevelSelection} from '../../shared/design/tree';
import {fontFallback} from '../../src/design/engine/commands/code';
import {createDesignStore} from '../../src/design/engine/store';
import {boxModel, detectAssets, exportAssets, layoutRows, stylesUsed, typographyRows} from '../../src/design/panels/code/inspect';
import {codeScope, scopeHolds, type CodeScope} from '../../src/design/panels/code/scope';
import {heavyPage, productFile, testMeasurer} from '../../tests/helpers/design-big-files';

const arg = (name: string, fallback: number) => {
  const at = process.argv.indexOf(`--${name}`);
  return at > 0 ? Number(process.argv[at + 1]) : fallback;
};
const CHANGES = arg('changes', 40);
const now = () => performance.now();
const median = (values: number[]) => [...values].sort((a, b) => a - b)[Math.floor(values.length / 2)];

/** What CodePanel computes for a selection when its memos miss (React + CSS Modules, the default language). `fallback` is
 *  the font fallback the token table is built with: a new function per call stands for the table the panel never cached. */
function panelWork(doc: DesignDocument, selection: readonly NodeId[], measurer: TextMeasurer, fallback = fontFallback) {
  const ids = topLevelSelection(doc, selection).filter(id => doc.nodes[id] && doc.nodes[id].type !== 'PAGE');
  toReact(doc, ids, {styling: 'css-modules', measurer, fontFallback: fallback, format: DEFAULT_FORMAT, suggestTokens: true});
  const tokens = suggestTokens(collectTokens(doc, {fontFallback: fallback}));
  const node = ids.length === 1 ? doc.nodes[ids[0]] : undefined;
  if (node) {
    boxModel(doc, node);
    layoutRows(node, DEFAULT_FORMAT);
    typographyRows(node, tokens, DEFAULT_FORMAT);
  }
  stylesUsed(doc, ids, tokens, DEFAULT_FORMAT);
  detectAssets(doc, ids, {measurer});
  exportAssets(doc, ids);
}

/** The notes and measurements of the tab: the old one walked the page and kept the selection's; the new one walks the
 *  selection (DevNotes.tsx). Both read the page's measurements. */
function notesBefore(doc: DesignDocument, pageId: NodeId, ids: readonly NodeId[]) {
  const inside = (id: NodeId) => {
    for (let node: SceneNode | undefined = doc.nodes[id]; node; node = node.parentId ? doc.nodes[node.parentId] : undefined) if (ids.includes(node.id)) return true;
    return false;
  };
  pageAnnotations(doc, pageId).filter(entry => inside(entry.node.id));
  pageMeasurements(doc, pageId);
}
function notesAfter(doc: DesignDocument, pageId: NodeId, ids: readonly NodeId[]) {
  const stack = [...ids];
  let count = 0;
  while (stack.length) {
    const node = doc.nodes[stack.pop()!];
    if (!node) continue;
    count += node.annotations?.length ?? 0;
    if (node.children) stack.push(...node.children);
  }
  pageMeasurements(doc, pageId);
  return count;
}

type Case = {name: string; doc: DesignDocument; pageId: NodeId; selected: NodeId; elsewhere: NodeId[]; inside: NodeId[]};

function bench({name, doc, pageId, selected, elsewhere, inside}: Case) {
  const store = createDesignStore({doc, pageId, measurer: testMeasurer, idle: () => () => {}});
  const selection = [selected];
  const move = (id: NodeId, i: number): DocumentPatch => {
    const node = store.getState().doc.nodes[id];
    return {nodes: {[id]: {...node, x: node.x + (i % 2 ? -1 : 1)}}};
  };
  const layers = Object.keys(doc.nodes).length;
  // Warm both paths once (JIT, the caches the editor keeps between changes).
  panelWork(store.getState().doc, selection, testMeasurer);
  let scope: CodeScope | null = codeScope(store.getState().doc, selection);
  const before: number[] = [], after: number[] = [], insideAfter: number[] = [];
  let regenerated = 0;
  for (let i = 0; i < CHANGES; i++) {
    store.applyRemote(() => move(elsewhere[i % elsewhere.length], i));
    const doc = store.getState().doc;
    let t = now();
    panelWork(doc, selection, testMeasurer, family => fontFallback(family));
    notesBefore(doc, pageId, selection);
    before.push(now() - t);
    t = now();
    if (!scope || !scopeHolds(scope, doc)) {
      regenerated++;
      scope = codeScope(doc, selection);
      panelWork(doc, selection, testMeasurer);
    }
    notesAfter(doc, pageId, selection);
    after.push(now() - t);
  }
  for (let i = 0; i < Math.min(CHANGES, 20); i++) {
    store.applyRemote(() => move(inside[i % inside.length], i));
    const doc = store.getState().doc;
    const t = now();
    if (!scope || !scopeHolds(scope, doc)) {
      scope = codeScope(doc, selection);
      panelWork(doc, selection, testMeasurer);
    }
    notesAfter(doc, pageId, selection);
    insideAfter.push(now() - t);
  }
  const scoped = scope?.nodes.size ?? 0;
  console.log(`${name}: ${layers} layers, "${doc.nodes[selected].name}" selected (scope ${scoped} layers)`);
  console.log(`  a change elsewhere   before ${median(before).toFixed(2)} ms, now ${median(after).toFixed(3)} ms (median of ${CHANGES}; regenerated ${regenerated} times)`);
  console.log(`  a change inside      now ${median(insideAfter).toFixed(2)} ms (scope rebuilt and code regenerated)`);
}

const heavy = heavyPage();
const screens = heavy.nodes.page.children!;
const leaves = (doc: DesignDocument, root: NodeId) => {
  const out: NodeId[] = [];
  const stack = [root];
  while (stack.length) {
    const node = doc.nodes[stack.pop()!];
    if (!node) continue;
    if (node.children?.length) stack.push(...node.children);
    else out.push(node.id);
  }
  return out;
};
bench({name: 'heavyPage', doc: heavy, pageId: 'page', selected: screens[0], elsewhere: leaves(heavy, screens[39]).slice(0, 40), inside: leaves(heavy, screens[0]).slice(0, 20)});

const product = productFile();
const productScreens = product.nodes.screens.children!;
bench({name: 'productFile', doc: product, pageId: 'screens', selected: productScreens[0], elsewhere: leaves(product, productScreens[30]).filter(id => !id.includes(';')).slice(0, 40), inside: leaves(product, productScreens[0]).filter(id => !id.includes(';')).slice(0, 20)});
