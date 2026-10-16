import test from 'node:test';
import assert from 'node:assert/strict';
import {createDocument, createNode, defaultTextProps} from '../shared/design/defaults';
import {applyPatch, type DocumentPatch} from '../shared/design/patch';
import {documentTarget, mergeChange, mergeList, same, textEdit} from '../shared/design/merge';
import {checkPatchedDocument, validateDocument} from '../shared/design/schema';
import {worldBox} from '../shared/design/geometry';
import {insertText} from '../shared/design/text-edit';
import type {DesignDocument, NodeId, SceneNode} from '../shared/design/types';

// Co-editing merge rules (shared/design/merge.ts, docs/design-tool.md "Co-editing"): a change made on an
// older version lands on the newer one field by field, structure by parent pointers, text by disjoint edits.

const PAGE = 'page1';

/** A page with frames F (x 100) and G (x 400), F holding rectangles a and b, G holding c. */
function base(): DesignDocument {
  let doc = createDocument(PAGE);
  const add = (node: SceneNode) => {
    const parent = doc.nodes[node.parentId!];
    doc = {...doc, nodes: {...doc.nodes, [node.id]: node, [parent.id]: {...parent, children: [...(parent.children ?? []), node.id]}}};
  };
  add(createNode('FRAME', {id: 'F', parentId: PAGE, x: 100, y: 100, width: 300, height: 300}));
  add(createNode('FRAME', {id: 'G', parentId: PAGE, x: 600, y: 100, width: 300, height: 300}));
  add(createNode('RECTANGLE', {id: 'a', parentId: 'F', x: 10, y: 10, width: 50, height: 50}));
  add(createNode('RECTANGLE', {id: 'b', parentId: 'F', x: 70, y: 10, width: 50, height: 50}));
  add(createNode('RECTANGLE', {id: 'c', parentId: 'G', x: 10, y: 10, width: 50, height: 50}));
  assert.ok(validateDocument(doc).ok);
  return doc;
}

/** One person's edit of `doc`: the patch and the before copies of its entries. */
function edit(doc: DesignDocument, change: (nodes: Record<NodeId, SceneNode | null>) => void): {patch: DocumentPatch; before: DocumentPatch; after: DesignDocument} {
  const nodes: Record<NodeId, SceneNode | null> = {};
  change(nodes);
  const patch: DocumentPatch = {nodes};
  const before: DocumentPatch = {nodes: Object.fromEntries(Object.keys(nodes).map(id => [id, doc.nodes[id] ?? null]))};
  return {patch, before, after: applyPatch(doc, patch)};
}
const node = (doc: DesignDocument, id: string) => doc.nodes[id];
const set = (doc: DesignDocument, id: string, partial: Partial<SceneNode>) => ({...doc.nodes[id], ...partial});

/** The server's step: `change` lands on `current`; the result passes the same checks the server runs. */
function land(current: DesignDocument, change: {patch: DocumentPatch; before: DocumentPatch}): DesignDocument {
  const merged = mergeChange(documentTarget(current), change.patch, change.before);
  const next = applyPatch(current, merged.patch);
  const checked = checkPatchedDocument(current, next, merged.patch);
  assert.ok(checked.ok, !checked.ok ? `${checked.error} at ${checked.path}` : '');
  const full = validateDocument(JSON.parse(JSON.stringify(next)));
  assert.ok(full.ok, !full.ok ? `${full.error} at ${full.path}` : '');
  return next;
}

test('with nothing changed since its copy, a change lands exactly as made', () => {
  const doc = base();
  const change = edit(doc, nodes => {
    nodes.a = set(doc, 'a', {x: 33, fills: []});
    nodes.F = set(doc, 'F', {children: ['b', 'a']});
  });
  const merged = mergeChange(documentTarget(doc), change.patch, change.before);
  assert.deepEqual(applyPatch(doc, merged.patch), change.after);
  assert.equal(merged.adjusted, false);
});

test('fields: what each side changed is kept, the same field goes to the later writer', () => {
  const doc = base();
  const theirs = edit(doc, nodes => void (nodes.a = set(doc, 'a', {x: 20, name: 'Theirs'})));
  const ours = edit(doc, nodes => void (nodes.a = set(doc, 'a', {y: 99, name: 'Ours'})));
  const result = land(land(doc, theirs), ours);
  assert.equal(node(result, 'a').x, 20);
  assert.equal(node(result, 'a').y, 99);
  assert.equal(node(result, 'a').name, 'Ours');
});

test('records merge entry by entry: auto layout spacing and padding from two people', () => {
  let doc = base();
  doc = applyPatch(doc, {nodes: {F: set(doc, 'F', {autoLayout: {...createNode('FRAME', {id: 'x'}).autoLayout!, layoutMode: 'HORIZONTAL'}})}});
  const theirs = edit(doc, nodes => void (nodes.F = set(doc, 'F', {autoLayout: {...node(doc, 'F').autoLayout!, itemSpacing: 24}})));
  const ours = edit(doc, nodes => void (nodes.F = set(doc, 'F', {autoLayout: {...node(doc, 'F').autoLayout!, paddingLeft: 16}})));
  const result = land(land(doc, theirs), ours);
  assert.equal(node(result, 'F').autoLayout!.itemSpacing, 24);
  assert.equal(node(result, 'F').autoLayout!.paddingLeft, 16);
});

test('records merge entry by entry: the gap and column count of a grid, the span and alignment of a grid child, from two people', () => {
  let doc = base();
  const grid = {rowCount: 2, columnCount: 2, rowGap: 0, columnGap: 0, rowSizes: [], columnSizes: [], autoTracks: 'NONE' as const, itemsPositioning: 'ROW_AUTO_FLOW' as const};
  doc = applyPatch(doc, {nodes: {F: set(doc, 'F', {grid}), a: set(doc, 'a', {gridChild: {rowSpan: 1}})}});
  const theirs = edit(doc, nodes => {
    nodes.F = set(doc, 'F', {grid: {...grid, rowGap: 8}});
    nodes.a = set(doc, 'a', {gridChild: {rowSpan: 2}});
  });
  const ours = edit(doc, nodes => {
    nodes.F = set(doc, 'F', {grid: {...grid, columnCount: 3}});
    nodes.a = set(doc, 'a', {gridChild: {rowSpan: 1, horizontalAlign: 'CENTER'}});
  });
  const result = land(land(doc, theirs), ours);
  assert.deepEqual(node(result, 'F').grid, {...grid, rowGap: 8, columnCount: 3});
  assert.deepEqual(node(result, 'a').gridChild, {rowSpan: 2, horizontalAlign: 'CENTER'});
});

test('two people adding layers to one frame both keep theirs', () => {
  const doc = base();
  const theirs = edit(doc, nodes => {
    nodes.t1 = createNode('ELLIPSE', {id: 't1', parentId: 'F'});
    nodes.F = set(doc, 'F', {children: ['a', 'b', 't1']});
  });
  const ours = edit(doc, nodes => {
    nodes.o1 = createNode('RECTANGLE', {id: 'o1', parentId: 'F'});
    nodes.F = set(doc, 'F', {children: ['o1', 'a', 'b']});
  });
  const result = land(land(doc, theirs), ours);
  assert.deepEqual(node(result, 'F').children, ['o1', 'a', 'b', 't1']);
  // And in the other order the same layers land.
  const other = land(land(doc, ours), theirs);
  assert.deepEqual(new Set(node(other, 'F').children), new Set(['o1', 'a', 'b', 't1']));
});

test('a reorder keeps the other side’s new layer in place', () => {
  const doc = base();
  const theirs = edit(doc, nodes => {
    nodes.t1 = createNode('ELLIPSE', {id: 't1', parentId: 'F'});
    nodes.F = set(doc, 'F', {children: ['a', 't1', 'b']});
  });
  const ours = edit(doc, nodes => void (nodes.F = set(doc, 'F', {children: ['b', 'a']})));
  const result = land(land(doc, theirs), ours);
  assert.deepEqual(node(result, 'F').children, ['b', 'a', 't1']);
});

test('moving the same layer to two places: the later move wins and the layer is listed once', () => {
  const doc = base();
  const theirs = edit(doc, nodes => {
    nodes.a = set(doc, 'a', {parentId: 'G'});
    nodes.F = set(doc, 'F', {children: ['b']});
    nodes.G = set(doc, 'G', {children: ['c', 'a']});
  });
  const ours = edit(doc, nodes => {
    nodes.a = set(doc, 'a', {parentId: PAGE});
    nodes.F = set(doc, 'F', {children: ['b']});
    nodes[PAGE] = set(doc, PAGE, {children: ['F', 'G', 'a']});
  });
  const result = land(land(doc, theirs), ours);
  assert.equal(node(result, 'a').parentId, PAGE);
  assert.deepEqual(node(result, 'G').children, ['c']);
  assert.deepEqual(node(result, PAGE).children, ['F', 'G', 'a']);
});

test('an edit of a layer someone removed is dropped; a removal wins over an edit', () => {
  const doc = base();
  const removeA = edit(doc, nodes => {
    nodes.a = null;
    nodes.F = set(doc, 'F', {children: ['b']});
  });
  const editA = edit(doc, nodes => void (nodes.a = set(doc, 'a', {x: 1})));
  for (const result of [land(land(doc, removeA), editA), land(land(doc, editA), removeA)]) {
    assert.equal(node(result, 'a'), undefined);
    assert.deepEqual(node(result, 'F').children, ['b']);
  }
});

test('a layer added into a frame someone removed moves up and stays where it was on the page (both orders)', () => {
  const doc = base();
  const removeF = edit(doc, nodes => {
    nodes.F = null;
    nodes.a = null;
    nodes.b = null;
    nodes[PAGE] = set(doc, PAGE, {children: ['G']});
  });
  const addInF = edit(doc, nodes => {
    nodes.n = createNode('RECTANGLE', {id: 'n', parentId: 'F', x: 30, y: 40, width: 20, height: 20});
    nodes.F = set(doc, 'F', {children: ['a', 'b', 'n']});
  });
  const placed = worldBox(addInF.after, 'n');
  for (const result of [land(land(doc, removeF), addInF), land(land(doc, addInF), removeF)]) {
    assert.equal(node(result, 'F'), undefined);
    assert.equal(node(result, 'a'), undefined);
    assert.equal(node(result, 'n').parentId, PAGE);
    assert.deepEqual(node(result, PAGE).children, ['G', 'n']);
    assert.deepEqual(worldBox(result, 'n'), placed);
  }
});

test('a layer moved out of a frame before it was removed survives with its subtree', () => {
  let doc = base();
  doc = applyPatch(doc, {nodes: {
    H: createNode('GROUP', {id: 'H', parentId: 'F', children: ['a']}),
    a: set(doc, 'a', {parentId: 'H'}),
    F: set(doc, 'F', {children: ['H', 'b']}),
  }});
  const moveH = edit(doc, nodes => {
    nodes.H = set(doc, 'H', {parentId: 'G'});
    nodes.F = set(doc, 'F', {children: ['b']});
    nodes.G = set(doc, 'G', {children: ['c', 'H']});
  });
  const removeF = edit(doc, nodes => {
    for (const id of ['F', 'H', 'a', 'b']) nodes[id] = null;
    nodes[PAGE] = set(doc, PAGE, {children: ['G']});
  });
  const result = land(land(doc, moveH), removeF);
  assert.equal(node(result, 'H').parentId, 'G');
  assert.equal(node(result, 'a').parentId, 'H');
  assert.equal(node(result, 'F'), undefined);
  assert.deepEqual(node(result, 'G').children, ['c', 'H']);
});

test('concurrent reparenting that would make a cycle: the later move is refused', () => {
  const doc = base();
  const fIntoG = edit(doc, nodes => {
    nodes.F = set(doc, 'F', {parentId: 'G'});
    nodes.G = set(doc, 'G', {children: ['c', 'F']});
    nodes[PAGE] = set(doc, PAGE, {children: ['G']});
  });
  const gIntoF = edit(doc, nodes => {
    nodes.G = set(doc, 'G', {parentId: 'F'});
    nodes.F = set(doc, 'F', {children: ['a', 'b', 'G']});
    nodes[PAGE] = set(doc, PAGE, {children: ['F']});
  });
  const result = land(land(doc, fIntoG), gIntoF);
  assert.equal(node(result, 'F').parentId, 'G');
  assert.equal(node(result, 'G').parentId, PAGE);
  assert.deepEqual(node(result, PAGE).children, ['G']);
  assert.deepEqual(node(result, 'F').children, ['a', 'b']);
  const merged = mergeChange(documentTarget(land(doc, fIntoG)), gIntoF.patch, gIntoF.before);
  assert.equal(merged.adjusted, true);
});

test('a move into a frame someone removed is refused: the layer stays where it is', () => {
  const doc = base();
  const removeG = edit(doc, nodes => {
    nodes.G = null;
    nodes.c = null;
    nodes[PAGE] = set(doc, PAGE, {children: ['F']});
  });
  const aIntoG = edit(doc, nodes => {
    nodes.a = set(doc, 'a', {parentId: 'G'});
    nodes.F = set(doc, 'F', {children: ['b']});
    nodes.G = set(doc, 'G', {children: ['c', 'a']});
  });
  const result = land(land(doc, removeG), aIntoG);
  assert.equal(node(result, 'a').parentId, 'F');
  assert.deepEqual(node(result, 'F').children, ['a', 'b']);
});

test('a group left without layers goes; instance copies never leave their instance', () => {
  let doc = base();
  doc = applyPatch(doc, {nodes: {
    H: createNode('GROUP', {id: 'H', parentId: 'F', children: ['a']}),
    a: set(doc, 'a', {parentId: 'H'}),
    F: set(doc, 'F', {children: ['H', 'b']}),
  }});
  const removeA = edit(doc, nodes => {
    nodes.a = null;
    nodes.H = set(doc, 'H', {children: ['a']}); // a stale copy that still lists it: the rule removes the group
  });
  const theirsMoveA = edit(doc, nodes => {
    nodes.a = set(doc, 'a', {parentId: 'G'});
    nodes.H = set(doc, 'H', {children: []});
    nodes.G = set(doc, 'G', {children: ['c', 'a']});
  });
  // Theirs moved a out (and would leave H empty: theirs' own normalization would remove H; here the merge does).
  const result = land(doc, {patch: {nodes: {...theirsMoveA.patch.nodes!}}, before: theirsMoveA.before});
  assert.equal(node(result, 'H'), undefined);
  assert.deepEqual(node(result, 'F').children, ['b']);
  void removeA;
});

test('text: edits in different places of one text both land; overlapping ones go to the later writer', () => {
  let doc = base();
  const text = defaultTextProps('Cheers all. Any news?');
  doc = applyPatch(doc, {nodes: {T: createNode('TEXT', {id: 'T', parentId: PAGE, text}), [PAGE]: set(doc, PAGE, {children: ['F', 'G', 'T']})}});
  const withText = (characters: (t: typeof text) => typeof text) => edit(doc, nodes => void (nodes.T = set(doc, 'T', {text: characters(node(doc, 'T').text!)})));
  const theirs = withText(t => insertText(t, 0, 6, 'Greetings'));
  const ours = withText(t => insertText(t, 21, 21, ' Great!'));
  const result = land(land(doc, theirs), ours);
  assert.equal(node(result, 'T').text!.characters, 'Greetings all. Any news? Great!');
  const overlap = withText(t => insertText(t, 2, 8, 'XYZ'));
  const later = land(land(doc, theirs), overlap);
  assert.equal(later.nodes.T.text!.characters, 'ChXYZll. Any news?');
  // Both typing at one place: theirs first, then ours.
  const a = withText(t => insertText(t, 6, 6, ' A')), b = withText(t => insertText(t, 6, 6, ' B'));
  assert.equal(land(land(doc, a), b).nodes.T.text!.characters, 'Cheers A B all. Any news?');
  // A save sent again after its answer was lost (the network dropped once the server had it): the same typing lands once,
  // also when what was typed since rides along. It landed twice: "Gr Great!".
  const typed = withText(t => insertText(t, 21, 21, ' Gr'));
  assert.equal(land(land(doc, typed), typed).nodes.T.text!.characters, 'Cheers all. Any news? Gr');
  const more = withText(t => insertText(t, 21, 21, ' Great!'));
  assert.equal(land(land(doc, typed), more).nodes.T.text!.characters, 'Cheers all. Any news? Great!');
  const cut = withText(t => insertText(t, 6, 10, ''));
  assert.equal(land(land(doc, cut), cut).nodes.T.text!.characters, 'Cheers. Any news?');
});

test('text: other text fields merge one by one with the content', () => {
  let doc = base();
  doc = applyPatch(doc, {nodes: {T: createNode('TEXT', {id: 'T', parentId: PAGE, text: defaultTextProps('abc')}), [PAGE]: set(doc, PAGE, {children: ['F', 'G', 'T']})}});
  const t = node(doc, 'T').text!;
  const theirs = edit(doc, nodes => void (nodes.T = set(doc, 'T', {text: {...t, textAlignHorizontal: 'CENTER'}})));
  const ours = edit(doc, nodes => void (nodes.T = set(doc, 'T', {text: insertText(t, 3, 3, 'd')})));
  const result = land(land(doc, theirs), ours);
  assert.equal(result.nodes.T.text!.characters, 'abcd');
  assert.equal(result.nodes.T.text!.textAlignHorizontal, 'CENTER');
});

test('pages: two new pages both stay; the last page is never removed', () => {
  let doc = base();
  const page2 = createNode('PAGE', {id: 'p2', name: 'Page 2', parentId: null, children: []});
  doc = applyPatch(doc, {nodes: {p2: page2}, pages: [PAGE, 'p2']});
  const addA: DocumentPatch = {nodes: {pa: createNode('PAGE', {id: 'pa', parentId: null, children: []})}, pages: [PAGE, 'p2', 'pa']};
  const addB: DocumentPatch = {nodes: {pb: createNode('PAGE', {id: 'pb', parentId: null, children: []})}, pages: [PAGE, 'pb', 'p2']};
  const before = (patch: DocumentPatch): DocumentPatch => ({nodes: Object.fromEntries(Object.keys(patch.nodes!).map(id => [id, null])), pages: [PAGE, 'p2']});
  const both = land(land(doc, {patch: addA, before: before(addA)}), {patch: addB, before: before(addB)});
  assert.deepEqual(both.pages, [PAGE, 'pb', 'p2', 'pa']);
  // Each removes the page the other keeps: one stays.
  const removePage = (doc: DesignDocument, id: string, keep: string) => {
    const nodes: Record<string, SceneNode | null> = {};
    const queue = [id];
    while (queue.length) {
      const at = queue.pop()!;
      nodes[at] = null;
      queue.push(...(doc.nodes[at].children ?? []));
    }
    return {patch: {nodes, pages: [keep]} as DocumentPatch, before: {nodes: Object.fromEntries(Object.keys(nodes).map(k => [k, doc.nodes[k]])), pages: doc.pages}};
  };
  const result = land(land(doc, removePage(doc, PAGE, 'p2')), removePage(doc, 'p2', PAGE));
  assert.equal(result.pages.length, 1);
});

test('variables: values of different modes and new variables in one collection merge', () => {
  let doc = base();
  doc = {...doc,
    variableCollections: {k: {id: 'k', name: 'Colors', modes: [{modeId: 'm1', name: 'Light'}, {modeId: 'm2', name: 'Dark'}], defaultModeId: 'm1', variableIds: ['v1']}},
    variables: {v1: {id: 'v1', name: 'Background', collectionId: 'k', type: 'FLOAT', valuesByMode: {m1: 1, m2: 2}, description: ''}},
  };
  const theirs: DocumentPatch = {variables: {v1: {...doc.variables.v1, valuesByMode: {m1: 10, m2: 2}}, v2: {id: 'v2', name: 'Text', collectionId: 'k', type: 'FLOAT', valuesByMode: {m1: 0, m2: 0}, description: ''}}, variableCollections: {k: {...doc.variableCollections.k, variableIds: ['v1', 'v2']}}};
  const ours: DocumentPatch = {variables: {v1: {...doc.variables.v1, valuesByMode: {m1: 1, m2: 20}}, v3: {id: 'v3', name: 'Border', collectionId: 'k', type: 'FLOAT', valuesByMode: {m1: 0, m2: 0}, description: ''}}, variableCollections: {k: {...doc.variableCollections.k, variableIds: ['v1', 'v3']}}};
  const beforeOf = (patch: DocumentPatch): DocumentPatch => ({variables: Object.fromEntries(Object.keys(patch.variables!).map(id => [id, doc.variables[id] ?? null])), variableCollections: {k: doc.variableCollections.k}});
  const result = land(land(doc, {patch: theirs, before: beforeOf(theirs)}), {patch: ours, before: beforeOf(ours)});
  assert.deepEqual(result.variables.v1.valuesByMode, {m1: 10, m2: 20});
  assert.deepEqual(result.variableCollections.k.variableIds, ['v1', 'v2', 'v3']);
});

test('without a before copy an entry is taken whole, as the last writer’s', () => {
  const doc = base();
  const theirs = edit(doc, nodes => void (nodes.a = set(doc, 'a', {x: 20})));
  const ours = {patch: {nodes: {a: set(doc, 'a', {y: 99})}}, before: {}};
  const result = land(land(doc, theirs), ours);
  assert.equal(node(result, 'a').x, 10);
  assert.equal(node(result, 'a').y, 99);
});

test('mergeList: moved ids land before their next kept neighbour', () => {
  const keep = () => true;
  assert.deepEqual(mergeList(['a', 'b', 'c', 'x'], ['a', 'b', 'c'], ['a', 'n1', 'n2', 'b', 'c'], keep), ['a', 'n1', 'n2', 'b', 'c', 'x']);
  assert.deepEqual(mergeList(['a', 'b', 'c'], ['a', 'b', 'c'], ['c', 'a', 'b'], keep), ['c', 'a', 'b']);
  assert.deepEqual(mergeList(['a', 'c'], ['a', 'b', 'c'], ['b', 'a', 'c'], id => id !== 'b'), ['a', 'c']);
  assert.deepEqual(textEdit('abcdef', 'abXYef'), {start: 2, end: 4, inserted: 'XY'});
  assert.ok(same({a: 1, b: undefined}, {a: 1}));
});

test('the merge is deterministic and leaves the target untouched', () => {
  const doc = base();
  const frozen = JSON.stringify(doc);
  const theirs = edit(doc, nodes => {
    nodes.a = set(doc, 'a', {parentId: 'G'});
    nodes.F = set(doc, 'F', {children: ['b']});
    nodes.G = set(doc, 'G', {children: ['c', 'a']});
  });
  const current = land(doc, theirs);
  const ours = edit(doc, nodes => {
    nodes.F = null;
    nodes.a = null;
    nodes.b = null;
    nodes[PAGE] = set(doc, PAGE, {children: ['G']});
  });
  const one = mergeChange(documentTarget(current), ours.patch, ours.before);
  const two = mergeChange(documentTarget(JSON.parse(JSON.stringify(current))), JSON.parse(JSON.stringify(ours.patch)), JSON.parse(JSON.stringify(ours.before)));
  assert.deepEqual(one, two);
  assert.equal(JSON.stringify(doc), frozen);

});

test('the hidden page of library copies is created and merged without ever joining the page list', async () => {
  const {LIBRARY_PAGE_ID} = await import('../shared/design/types');
  const doc = base();
  // Someone else added a page meanwhile; this change brings the first library copy (the hidden page and a remote component).
  const other = edit(doc, nodes => {
    nodes.page2 = {...createNode('PAGE', {id: 'page2', parentId: null}), children: []};
  });
  const moved = applyPatch(other.after, {pages: [PAGE, 'page2']});
  const libraryPage: SceneNode = {...createNode('PAGE', {id: LIBRARY_PAGE_ID, parentId: null}), children: ['r1:btn']};
  const copy: SceneNode = {...createNode('COMPONENT', {id: 'r1:btn', parentId: LIBRARY_PAGE_ID, width: 120, height: 40}), remote: {libraryId: 'lib', key: 'btn', version: 1}};
  const change = edit(doc, nodes => {
    nodes[LIBRARY_PAGE_ID] = libraryPage;
    nodes['r1:btn'] = copy;
  });
  const merged = mergeChange(documentTarget(moved), change.patch, change.before);
  const result = applyPatch(moved, merged.patch);
  assert.deepEqual(result.pages, [PAGE, 'page2'], 'the listed pages only');
  assert.equal(result.nodes[LIBRARY_PAGE_ID]?.type, 'PAGE');
  const checked = checkPatchedDocument(moved, result, merged.patch);
  assert.ok(checked.ok, checked.ok ? '' : checked.error);
});
