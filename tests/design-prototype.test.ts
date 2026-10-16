import {test} from 'node:test';
import assert from 'node:assert/strict';
import {createDocument, createNode, solid} from '../shared/design/defaults';
import {createInstance} from '../shared/design/components';
import type {Action, DesignDocument, NodeId, NodeType, Reaction, SceneNode} from '../shared/design/types';
import {
  actionIssue, changeDestinations, changeTarget, closeOverlays, connectionsOf, cubicBezier, defaultReaction, deviceScreen, easingCss, easingPath,
  evaluateEasing, flowFrames, flowOf, flowStartingPoints, goBack, hotspotsAt, hotspotsOf, interpolateNode, isSafeUrl, isTopLevelFrame, layerKeys,
  lerpAngle, makeAction, makeTransition, makeTrigger, matchLayers, maxScroll, navigateTo, newOverlayFrames, overlayOrigin, placedMatrix, playTarget, reactionIssues,
  reverseTransition, sameSubtree, scrollShift, scrollToTargets, sessionStep, smartAnimatePlan, SPRING_EASINGS, springDuration, springValue,
  startSession, topLevelFrames, transitionDuration, withFlowAdded, withFlowRemoved, withFlowRenamed, withScroll, type MorphNode, type SessionState,
} from '../shared/design/prototype';

// Prototyping, pure: easing, reactions, flows, scrolling, hotspots, the session's overlay stack and
// history, and smart animate's matching and interpolation.

function add(doc: DesignDocument, type: NodeType, props: Partial<SceneNode> & {id: NodeId; parentId: NodeId}): DesignDocument {
  const node = createNode(type, props);
  const parent = doc.nodes[props.parentId];
  return {...doc, nodes: {...doc.nodes, [node.id]: node, [parent.id]: {...parent, children: [...(parent.children ?? []), node.id]}}};
}
const update = (doc: DesignDocument, id: NodeId, partial: Partial<SceneNode>): DesignDocument => ({...doc, nodes: {...doc.nodes, [id]: {...doc.nodes[id], ...partial}}});
const navigate = (destinationId: NodeId, transition: Extract<Action, {type: 'NODE'}>['transition'] = {type: 'INSTANT'}): Action => ({type: 'NODE', navigation: 'NAVIGATE', destinationId, transition});
const click = (...actions: Action[]): Reaction => ({trigger: {type: 'ON_CLICK'}, actions});
const close = (a: number, b: number, digits = 3) => assert.ok(Math.abs(a - b) < 10 ** -digits, `${a} ≈ ${b}`);

/** A login flow: "Login" (button → "Code"), "Code" (scrolling list, back), "Done"; a dialog to open as an overlay. */
function loginDoc(): DesignDocument {
  let doc = createDocument('page');
  doc = add(doc, 'FRAME', {id: 'login', parentId: 'page', name: 'Login', x: 0, y: 0, width: 390, height: 844});
  doc = add(doc, 'FRAME', {id: 'code', parentId: 'page', name: 'Code', x: 500, y: 0, width: 390, height: 844});
  doc = add(doc, 'FRAME', {id: 'done', parentId: 'page', name: 'Done', x: 1000, y: 0, width: 390, height: 844});
  doc = add(doc, 'FRAME', {id: 'dialog', parentId: 'page', name: 'Dialog', x: 0, y: 1000, width: 300, height: 200, overlayPositionType: 'CENTER'});
  doc = add(doc, 'RECTANGLE', {id: 'button', parentId: 'login', name: 'Button', x: 24, y: 700, width: 342, height: 48, cornerRadius: 12, fills: [solid({r: 0, g: 0.4, b: 1})]});
  doc = add(doc, 'TEXT', {id: 'title', parentId: 'login', name: 'Heading', x: 24, y: 80, width: 200, height: 30});
  doc = add(doc, 'RECTANGLE', {id: 'help', parentId: 'login', name: 'Help', x: 24, y: 780, width: 100, height: 30});
  doc = add(doc, 'RECTANGLE', {id: 'button2', parentId: 'code', name: 'Button', x: 24, y: 400, width: 342, height: 56, cornerRadius: 28, fills: [solid({r: 0.1, g: 0.8, b: 0.3})]});
  doc = add(doc, 'TEXT', {id: 'title2', parentId: 'code', name: 'Heading', x: 24, y: 80, width: 200, height: 30});
  doc = add(doc, 'FRAME', {id: 'list', parentId: 'code', name: 'List', x: 0, y: 500, width: 390, height: 200, overflowDirection: 'VERTICAL'});
  doc = add(doc, 'RECTANGLE', {id: 'row1', parentId: 'list', name: 'Row', x: 0, y: 0, width: 390, height: 120});
  doc = add(doc, 'RECTANGLE', {id: 'row2', parentId: 'list', name: 'Row', x: 0, y: 140, width: 390, height: 120});
  doc = add(doc, 'RECTANGLE', {id: 'row3', parentId: 'list', name: 'Row', x: 0, y: 280, width: 390, height: 120});
  doc = add(doc, 'RECTANGLE', {id: 'back', parentId: 'code', name: 'Back', x: 16, y: 16, width: 40, height: 40});
  doc = update(doc, 'button', {reactions: [click(navigate('code', {type: 'SMART_ANIMATE', duration: 0.3, easing: 'EASE_OUT'}))]});
  doc = update(doc, 'help', {reactions: [click({type: 'NODE', navigation: 'OVERLAY', destinationId: 'dialog', transition: {type: 'MOVE_IN', direction: 'TOP', duration: 0.3, easing: 'EASE_OUT'}})]});
  doc = update(doc, 'button2', {reactions: [click(navigate('done'))]});
  doc = update(doc, 'back', {reactions: [click({type: 'BACK'})]});
  doc = update(doc, 'row3', {reactions: [click({type: 'NODE', navigation: 'SCROLL_TO', destinationId: 'row3', transition: {type: 'INSTANT'}})]});
  doc = update(doc, 'page', {flowStartingPoints: [{nodeId: 'login', name: 'Sign in to the app'}]});
  return doc;
}

// ── Easing ───────────────────────────────────────────────────────────────────────────────────────

test('bezier easings hit their ends and follow CSS curves', () => {
  for (const easing of ['LINEAR', 'EASE_IN', 'EASE_OUT', 'EASE_IN_AND_OUT', 'EASE_IN_BACK', 'EASE_OUT_BACK'] as const) {
    assert.equal(evaluateEasing(easing, 0), 0);
    assert.equal(evaluateEasing(easing, 1), 1);
  }
  close(evaluateEasing('LINEAR', 0.37), 0.37);
  // CSS `ease-in-out` is symmetric: 0.5 → 0.5.
  close(evaluateEasing('EASE_IN_AND_OUT', 0.5), 0.5);
  // ease-out leads, ease-in lags.
  assert.ok(evaluateEasing('EASE_OUT', 0.25) > 0.25 + 0.1);
  assert.ok(evaluateEasing('EASE_IN', 0.25) < 0.25 - 0.1);
  // Back curves leave 0..1 on their way.
  assert.ok(Math.min(...[0.1, 0.2, 0.3].map(p => evaluateEasing('EASE_IN_BACK', p))) < 0);
  assert.ok(Math.max(...[0.5, 0.6, 0.7, 0.8].map(p => evaluateEasing('EASE_OUT_BACK', p))) > 1);
  // The solver agrees with a known point of cubic-bezier(0.42, 0, 1, 1) (ease-in) at x = 0.5 ≈ 0.3153.
  close(cubicBezier(0.42, 0, 1, 1)(0.5), 0.3153, 3);
  // Monotonic for the plain ones.
  let last = -1;
  for (let i = 0; i <= 100; i++) {
    const value = evaluateEasing('EASE_IN_AND_OUT', i / 100);
    assert.ok(value >= last - 1e-9);
    last = value;
  }
});

test('springs settle at 1, take their own time and overshoot only when underdamped', () => {
  for (const [name, params] of Object.entries(SPRING_EASINGS)) {
    assert.equal(springValue(params!, 0), 0, name);
    close(springValue(params!, 10), 1, 6);
    const seconds = springDuration(params!);
    assert.ok(seconds > 0.2 && seconds < 3, `${name} lasts ${seconds}s`);
    // The last 0.1 % is where the duration ends.
    assert.ok(Math.abs(springValue(params!, seconds + 0.01) - 1) <= 0.001, name);
    assert.equal(evaluateEasing(name as 'GENTLE', 1), 1);
  }
  const peak = (easing: 'BOUNCY' | 'SLOW') => Math.max(...Array.from({length: 200}, (_, i) => evaluateEasing(easing, i / 200)));
  assert.ok(peak('BOUNCY') > 1.2, 'bouncy overshoots a lot');
  assert.ok(peak('SLOW') <= 1 + 1e-9, 'slow is overdamped');
  assert.equal(transitionDuration({type: 'SMART_ANIMATE', duration: 0.3, easing: 'QUICK'}), springDuration(SPRING_EASINGS.QUICK!));
  assert.equal(transitionDuration({type: 'DISSOLVE', duration: 0.45, easing: 'LINEAR'}), 0.45);
  assert.equal(transitionDuration({type: 'INSTANT'}), 0);
  assert.equal(transitionDuration({type: 'DISSOLVE', duration: 999, easing: 'LINEAR'}), 10);
});

test('the curve preview and CSS form', () => {
  const path = easingPath('EASE_OUT_BACK', 100, 40);
  assert.match(path.d, /^M0 \d/);
  assert.ok(path.oneY > 0, 'room above 1 for the overshoot');
  assert.equal(easingPath('LINEAR', 100, 40).zeroY, 40);
  assert.equal(easingCss('EASE_OUT'), 'cubic-bezier(0, 0, 0.58, 1)');
  assert.match(easingCss('BOUNCY'), /^linear\(0, .*, 1\)$/);
});

// ── Transitions, triggers, actions ───────────────────────────────────────────────────────────────

test('transitions keep their timing when the type changes and reverse for "Back"', () => {
  const dissolve = {type: 'DISSOLVE' as const, duration: 0.5, easing: 'GENTLE' as const};
  assert.deepEqual(makeTransition('PUSH', dissolve), {type: 'PUSH', direction: 'LEFT', duration: 0.5, easing: 'GENTLE'});
  assert.deepEqual(makeTransition('INSTANT', dissolve), {type: 'INSTANT'});
  assert.deepEqual(makeTransition('SMART_ANIMATE'), {type: 'SMART_ANIMATE', duration: 0.3, easing: 'EASE_OUT'});
  assert.deepEqual(reverseTransition({type: 'MOVE_IN', direction: 'LEFT', duration: 0.3, easing: 'LINEAR'}), {type: 'MOVE_OUT', direction: 'RIGHT', duration: 0.3, easing: 'LINEAR'});
  assert.deepEqual(reverseTransition({type: 'PUSH', direction: 'TOP', duration: 0.3, easing: 'LINEAR'}), {type: 'PUSH', direction: 'BOTTOM', duration: 0.3, easing: 'LINEAR'});
  assert.deepEqual(reverseTransition({type: 'SLIDE_OUT', direction: 'BOTTOM', duration: 0.3, easing: 'LINEAR'}), {type: 'SLIDE_IN', direction: 'TOP', duration: 0.3, easing: 'LINEAR'});
  assert.deepEqual(makeTrigger('AFTER_TIMEOUT'), {type: 'AFTER_TIMEOUT', timeout: 0.8});
  assert.deepEqual(makeTrigger('ON_KEY_DOWN', {type: 'ON_KEY_DOWN', keyCode: 'KeyA'}), {type: 'ON_KEY_DOWN', keyCode: 'KeyA'});
  assert.deepEqual(makeTrigger('ON_HOVER', {type: 'AFTER_TIMEOUT', timeout: 2}), {type: 'ON_HOVER'});
});

test('actions are made only when they can be stored and played', () => {
  const doc = loginDoc();
  // A new interaction is "On click → Navigate to …" with an instant transition.
  assert.deepEqual(defaultReaction('code'), {trigger: {type: 'ON_CLICK'}, actions: [{type: 'NODE', navigation: 'NAVIGATE', destinationId: 'code', transition: {type: 'INSTANT'}}]});
  assert.deepEqual(defaultReaction(null).actions, []);
  const smart = navigate('code', {type: 'SMART_ANIMATE', duration: 0.4, easing: 'GENTLE'});
  // Switching kind keeps the destination and the timing where they fit.
  assert.deepEqual(makeAction(doc, 'button', 'OVERLAY', smart), {type: 'NODE', navigation: 'OVERLAY', destinationId: 'code', transition: {type: 'SMART_ANIMATE', duration: 0.4, easing: 'GENTLE'}});
  // A frame elsewhere is no scroll target: the action stays a draft.
  assert.equal(makeAction(doc, 'button', 'SCROLL_TO', smart), null);
  assert.equal(makeAction(doc, 'button', 'NAVIGATE', null), null);
  assert.deepEqual(makeAction(doc, 'button', 'BACK', smart), {type: 'BACK'});
  // A link needs a valid address before it is stored.
  assert.equal(makeAction(doc, 'button', 'URL', null), null);
  assert.deepEqual(makeAction(doc, 'button', 'URL', {type: 'URL', url: 'https://foo.test', openInNewTab: false}), {type: 'URL', url: 'https://foo.test', openInNewTab: false});
  // CHANGE_TO keeps only transitions it can play.
  const pushed = makeAction(doc, 'row3', 'SCROLL_TO', {type: 'NODE', navigation: 'NAVIGATE', destinationId: 'row1', transition: {type: 'PUSH', direction: 'LEFT', duration: 0.2, easing: 'LINEAR'}});
  assert.deepEqual(pushed, {type: 'NODE', navigation: 'SCROLL_TO', destinationId: 'row1', transition: {type: 'SMART_ANIMATE', duration: 0.2, easing: 'LINEAR'}});
});

test('links: http(s) and mailto only', () => {
  assert.ok(isSafeUrl('https://example.com/a?b=1'));
  assert.ok(isSafeUrl('http://example.com'));
  assert.ok(isSafeUrl('mailto:hello@example.com'));
  for (const bad of ['javascript:alert(1)', 'data:text/html,hi', 'ftp://x', '//example.com', 'example.com', '', 'https://', 'https://x/' + 'a'.repeat(3000)]) assert.equal(isSafeUrl(bad), false, bad);
});

test('reaction validation names what keeps a reaction from playing', () => {
  let doc = loginDoc();
  doc = {...doc, pages: [...doc.pages, 'p2'], nodes: {...doc.nodes, p2: createNode('PAGE', {id: 'p2'})}};
  doc = add(doc, 'FRAME', {id: 'far', parentId: 'p2', name: 'Far away'});
  const issues = (reaction: Reaction, source = 'button') => reactionIssues(doc, source, reaction).map(issue => issue.code);
  assert.deepEqual(issues(click(navigate('code'))), []);
  assert.deepEqual(issues(click()), ['no_action']);
  assert.deepEqual(issues(click(navigate('missing'))), ['missing_destination']);
  assert.deepEqual(issues(click(navigate('row1'))), ['not_top_level']);
  assert.deepEqual(issues(click(navigate('far'))), ['other_page']);
  assert.deepEqual(issues(click({type: 'NODE', navigation: 'SCROLL_TO', destinationId: 'row1', transition: {type: 'INSTANT'}})), ['scroll_outside']);
  assert.deepEqual(issues(click({type: 'NODE', navigation: 'SCROLL_TO', destinationId: 'row1', transition: {type: 'INSTANT'}}), 'back'), []);
  assert.deepEqual(issues(click({type: 'URL', url: 'javascript:void 0', openInNewTab: true})), ['unsafe_url']);
  assert.deepEqual(issues({trigger: {type: 'AFTER_TIMEOUT', timeout: -1}, actions: [{type: 'BACK'}]}), ['bad_timeout']);
  assert.deepEqual(issues({trigger: {type: 'ON_KEY_DOWN', keyCode: ''}, actions: [{type: 'BACK'}]}), ['bad_key']);
  assert.deepEqual(issues(click({type: 'NODE', navigation: 'CHANGE_TO', destinationId: 'code', transition: {type: 'INSTANT'}})), ['not_variant']);
  assert.equal(reactionIssues(doc, 'button', click(navigate('missing')))[0].message, 'The destination layer no longer exists.');
  assert.deepEqual(connectionsOf(doc.nodes.help), [{sourceId: 'help', reactionIndex: 0, actionIndex: 0, destinationId: 'dialog', kind: 'OVERLAY'}]);
});

// ── Frames and flows ─────────────────────────────────────────────────────────────────────────────

test('top-level frames, flows and what ▶ presents', () => {
  let doc = loginDoc();
  doc = add(doc, 'SECTION', {id: 'section', parentId: 'page', name: 'Section'});
  doc = add(doc, 'FRAME', {id: 'inSection', parentId: 'section', name: 'In section'});
  assert.ok(isTopLevelFrame(doc, 'inSection'));
  assert.ok(!isTopLevelFrame(doc, 'list'));
  assert.deepEqual(topLevelFrames(doc, 'page'), ['inSection', 'dialog', 'done', 'code', 'login']);
  assert.deepEqual(flowStartingPoints(doc, 'page'), [{nodeId: 'login', name: 'Sign in to the app'}]);
  // Flows: "Flow N", never twice for one frame, never for a layer inside a frame.
  const added = withFlowAdded(doc, 'page', 'code');
  assert.deepEqual(added.at(-1), {nodeId: 'code', name: 'Flow 1'});
  assert.equal(withFlowAdded(update(doc, 'page', {flowStartingPoints: added}), 'page', 'code'), added);
  assert.equal(withFlowAdded(doc, 'page', 'row1'), doc.nodes.page.flowStartingPoints);
  assert.deepEqual(withFlowRenamed(added, 'code', '  Payment  ').at(-1), {nodeId: 'code', name: 'Payment'});
  assert.deepEqual(withFlowRenamed(added, 'code', '   ').at(-1)?.name, 'Flow 1');
  assert.deepEqual(withFlowRemoved(added, 'code'), doc.nodes.page.flowStartingPoints);
  // A deleted start drops out of the list the panel and player read.
  assert.deepEqual(flowStartingPoints(update(doc, 'page', {flowStartingPoints: [{nodeId: 'gone', name: 'x'}, ...added]}), 'page').map(p => p.nodeId), ['login', 'code']);
  // The order ←/→ walk: breadth first along "Navigate to".
  assert.deepEqual(flowFrames(doc, 'login'), ['login', 'code', 'done']);
  assert.equal(flowOf(doc, 'done')?.name, 'Sign in to the app');
  assert.equal(flowOf(doc, 'dialog'), null);
  assert.equal(playTarget(doc, 'page', ['row2']), 'code');
  assert.equal(playTarget(doc, 'page', []), 'login');
  assert.equal(playTarget(update(doc, 'page', {flowStartingPoints: []}), 'page', []), 'inSection');
});

test('device presets turn with the rotation', () => {
  assert.equal(deviceScreen({type: 'NONE'}), null);
  assert.equal(deviceScreen({type: 'PRESET', presetId: 'nope', rotation: 0}), null);
  const phone = deviceScreen({type: 'PRESET', presetId: 'iphone-16', rotation: 0})!;
  assert.deepEqual([phone.width, phone.height, phone.landscape], [393, 852, false]);
  const turned = deviceScreen({type: 'PRESET', presetId: 'iphone-16', rotation: 90})!;
  assert.deepEqual([turned.width, turned.height, turned.landscape], [852, 393, true]);
});

// ── Scrolling and hotspots ───────────────────────────────────────────────────────────────────────

test('scroll containers, fixed and sticky children, and "Scroll to"', () => {
  const doc = loginDoc();
  const screen = {width: 390, height: 844};
  assert.deepEqual(maxScroll(doc, 'list', {width: 390, height: 200}), {x: 0, y: 200});
  // A top-level frame taller than the screen scrolls down without a setting.
  assert.deepEqual(maxScroll(doc, 'code', {width: 390, height: 600}, true), {x: 0, y: 244});
  assert.deepEqual(maxScroll(doc, 'code', screen, true), {x: 0, y: 0});
  const scroll = {list: {x: 0, y: 100}};
  const m = placedMatrix(doc, 'code', 'row2', scroll)!;
  assert.deepEqual([m[0][2], m[1][2]], [0, 500 + 140 - 100]);
  assert.deepEqual(scrollShift({...doc.nodes.row2, scrollBehavior: 'FIXED'}, {x: 0, y: 100}), {x: 0, y: 0});
  // Sticky: scrolls until it reaches the top, then stays.
  assert.deepEqual(scrollShift({...doc.nodes.row2, scrollBehavior: 'STICKY_SCROLLS'}, {x: 0, y: 100}), {x: 0, y: -100});
  assert.deepEqual(scrollShift({...doc.nodes.row2, scrollBehavior: 'STICKY_SCROLLS'}, {x: 0, y: 190}), {x: 0, y: -140});
  // "Scroll to" puts the layer at the top of its scroll container, within its range.
  assert.deepEqual(scrollToTargets(doc, 'code', 'row2', screen, {}), {list: {x: 0, y: 140}});
  assert.deepEqual(scrollToTargets(doc, 'code', 'row3', screen, {}), {list: {x: 0, y: 200}});
});

test('hotspots: topmost first, scrolled, clipped by their scroll container', () => {
  const doc = loginDoc();
  const screen = {width: 390, height: 844};
  const at = (scroll: Record<string, {x: number; y: number}>, x: number, y: number) => hotspotsAt(hotspotsOf(doc, 'code', scroll, screen), {x, y}).map(h => h.id);
  assert.deepEqual(at({}, 30, 30), ['back']);
  // row3 starts at 780 in the list's content: below the list's 200 px window until scrolled.
  assert.deepEqual(at({}, 50, 690), []);
  assert.deepEqual(at({list: {x: 0, y: 200}}, 50, 600), ['row3']);
  // Out of the list's window it cannot be hit even where its box is.
  assert.deepEqual(at({list: {x: 0, y: 200}}, 50, 720), []);
  const login = hotspotsOf(doc, 'login', {}, screen).map(h => h.id);
  assert.deepEqual(login, ['help', 'button']);
});

// ── Session ──────────────────────────────────────────────────────────────────────────────────────

test('navigation, overlays and "Back" keep a history that plays backwards', () => {
  const doc = loginDoc();
  let state: SessionState = startSession('login');
  // Open the help dialog as an overlay.
  let step = sessionStep(doc, state, {id: 'help', surface: -1}, doc.nodes.help.reactions[0].actions[0]);
  state = step.state;
  assert.deepEqual(state.overlays.map(o => o.frameId), ['dialog']);
  assert.equal(step.effect.kind, 'present');
  // "Back" closes it with the opening motion reversed.
  step = sessionStep(doc, state, {id: 'back', surface: 0}, {type: 'BACK'});
  assert.deepEqual(step.state.overlays, []);
  assert.deepEqual(step.effect, {kind: 'present', from: {screen: state.screen, overlays: state.overlays}, transition: {type: 'MOVE_OUT', direction: 'BOTTOM', duration: 0.3, easing: 'EASE_OUT'}, back: true});
  // Navigating from an overlay closes the stack and records one step.
  step = sessionStep(doc, state, {id: 'title', surface: 0}, navigate('code'));
  assert.equal(step.state.screen.frameId, 'code');
  assert.deepEqual(step.state.overlays, []);
  assert.equal(step.state.history.length, 2);
  state = step.state;
  state = sessionStep(doc, state, {id: 'button2', surface: -1}, navigate('done', {type: 'PUSH', direction: 'LEFT', duration: 0.3, easing: 'LINEAR'})).state;
  assert.equal(state.history.length, 3);
  step = goBack(state);
  assert.equal(step.state.screen.frameId, 'code');
  assert.deepEqual(step.effect.kind === 'present' && step.effect.transition, {type: 'PUSH', direction: 'RIGHT', duration: 0.3, easing: 'LINEAR'});
  step = goBack(goBack(step.state).state);
  assert.equal(step.state.screen.frameId, 'login');
  assert.deepEqual(step.state.overlays, []);
  assert.equal(goBack(step.state).effect.kind, 'none');
});

test('the overlay stack: swap the top, close from inside, close-from-the-screen closes the top', () => {
  let doc = loginDoc();
  doc = add(doc, 'FRAME', {id: 'sheet', parentId: 'page', name: 'Sheet', width: 390, height: 300, overlayPositionType: 'BOTTOM_CENTER'});
  doc = add(doc, 'FRAME', {id: 'menu', parentId: 'page', name: 'Menu', width: 200, height: 160, overlayPositionType: 'MANUAL'});
  const open = (destinationId: NodeId): Action => ({type: 'NODE', navigation: 'OVERLAY', destinationId, transition: {type: 'DISSOLVE', duration: 0.2, easing: 'LINEAR'}});
  let state = startSession('login');
  state = sessionStep(doc, state, {id: 'help', surface: -1}, open('dialog')).state;
  state = sessionStep(doc, state, {id: 'title', surface: 0}, open('sheet')).state;
  assert.deepEqual(state.overlays.map(o => o.frameId), ['dialog', 'sheet']);
  // Swap replaces the overlay the action is in.
  const swapped = sessionStep(doc, state, {id: 'title', surface: 1}, {type: 'NODE', navigation: 'SWAP', destinationId: 'menu', transition: {type: 'INSTANT'}}).state;
  assert.deepEqual(swapped.overlays.map(o => o.frameId), ['dialog', 'menu']);
  // CLOSE in the first overlay closes it and everything above.
  const closed = sessionStep(doc, state, {id: 'title', surface: 0}, {type: 'CLOSE'});
  assert.deepEqual(closed.state.overlays, []);
  // CLOSE from the screen closes only the top one; the dissolve plays backwards (a dissolve).
  const top = sessionStep(doc, state, {id: 'title', surface: -1}, {type: 'CLOSE'});
  assert.deepEqual(top.state.overlays.map(o => o.frameId), ['dialog']);
  assert.deepEqual(top.effect.kind === 'present' && top.effect.transition, {type: 'DISSOLVE', duration: 0.2, easing: 'LINEAR'});
  // …and "Back" after a close does not reopen it.
  assert.deepEqual(goBack(top.state).state.overlays, []);
  assert.equal(closeOverlays(startSession('login')).effect.kind, 'none');
  // MANUAL overlays open next to their trigger (below it by default).
  const manual = sessionStep(doc, startSession('login'), {id: 'help', surface: -1, rect: {x: 24, y: 780, width: 100, height: 30}}, open('menu')).state;
  assert.deepEqual(manual.overlays[0].anchor, {x: 24, y: 810});
  assert.deepEqual(overlayOrigin('MANUAL', {width: 200, height: 160}, {width: 390, height: 844}, manual.overlays[0].anchor), {x: 24, y: 810});
  assert.deepEqual(overlayOrigin('CENTER', {width: 300, height: 200}, {width: 390, height: 844}), {x: 45, y: 322});
  assert.deepEqual(overlayOrigin('BOTTOM_CENTER', {width: 390, height: 300}, {width: 390, height: 844}), {x: 0, y: 544});
  assert.deepEqual(overlayOrigin(undefined, {width: 390, height: 300}, {width: 390, height: 844}).y, 272);
  // Scroll offsets belong to their surface.
  const scrolled = withScroll(manual, 0, {menu: {x: 0, y: 12}});
  assert.deepEqual(scrolled.overlays[0].scroll, {menu: {x: 0, y: 12}});
  assert.equal(withScroll(manual, 4, {}), manual);
});

test('a frame first opened as an overlay is set to close on a click outside it, as in Figma', () => {
  let doc = loginDoc();
  doc = add(doc, 'FRAME', {id: 'sheet', parentId: 'page', name: 'Sheet', width: 390, height: 300, overlayBackgroundInteraction: 'NONE'});
  const overlay = (navigation: 'OVERLAY' | 'SWAP', destinationId: NodeId): Action => ({type: 'NODE', navigation, destinationId, transition: {type: 'INSTANT'}});
  assert.deepEqual(newOverlayFrames(doc, 'help', click(overlay('OVERLAY', 'dialog'))), ['dialog'], 'never set: it gets the default');
  assert.deepEqual(newOverlayFrames(doc, 'help', click(overlay('SWAP', 'dialog'), overlay('OVERLAY', 'dialog'))), ['dialog'], 'once');
  assert.deepEqual(newOverlayFrames(doc, 'help', click(overlay('OVERLAY', 'sheet'))), [], 'a choice already made stays');
  assert.deepEqual(newOverlayFrames(doc, 'help', click(navigate('code'))), [], 'navigation is not an overlay');
  assert.deepEqual(newOverlayFrames(doc, 'dialog', click(overlay('OVERLAY', 'dialog'))), [], 'not the source itself');
});

test('navigating keeps scroll only when asked, and SCROLL_TO and URL become effects', () => {
  const doc = loginDoc();
  let state = withScroll(startSession('code'), -1, {code: {x: 0, y: 120}, list: {x: 0, y: 40}});
  assert.deepEqual(navigateTo(state, 'done', {type: 'INSTANT'}, {preserveScroll: true}).state.screen.scroll, {done: {x: 0, y: 120}});
  assert.deepEqual(navigateTo(state, 'done').state.screen.scroll, {});
  state = startSession('code');
  assert.deepEqual(sessionStep(doc, state, {id: 'row3', surface: -1}, doc.nodes.row3.reactions[0].actions[0]).effect, {kind: 'scroll', surface: -1, destinationId: 'row3', transition: {type: 'INSTANT'}});
  assert.deepEqual(sessionStep(doc, state, {id: 'row3', surface: -1}, {type: 'URL', url: 'mailto:a@b.ru', openInNewTab: true}).effect, {kind: 'url', url: 'mailto:a@b.ru', newTab: true});
  // An action that cannot play does nothing.
  assert.deepEqual(sessionStep(doc, state, {id: 'row3', surface: -1}, {type: 'URL', url: 'javascript:alert(1)', openInNewTab: true}), {state, effect: {kind: 'none'}});
  assert.equal(sessionStep(doc, state, {id: 'row3', surface: -1}, navigate('row1')).effect.kind, 'none');
});

test('"Change to" swaps the instance of the variant set and remembers the choice', () => {
  let doc = createDocument('page');
  doc = add(doc, 'COMPONENT_SET', {id: 'set', parentId: 'page', name: 'Button', width: 300, height: 100});
  doc = add(doc, 'COMPONENT', {id: 'v1', parentId: 'set', name: 'State=Normal', width: 120, height: 40});
  doc = add(doc, 'COMPONENT', {id: 'v2', parentId: 'set', name: 'State=Hover', x: 150, width: 120, height: 40});
  doc = add(doc, 'RECTANGLE', {id: 'bg1', parentId: 'v1', name: 'Background', width: 120, height: 40, reactions: [{trigger: {type: 'ON_HOVER'}, actions: [{type: 'NODE', navigation: 'CHANGE_TO', destinationId: 'v2', transition: {type: 'SMART_ANIMATE', duration: 0.2, easing: 'EASE_OUT'}}]}]});
  doc = add(doc, 'RECTANGLE', {id: 'bg2', parentId: 'v2', name: 'Background', width: 120, height: 40, fills: [solid({r: 1, g: 0, b: 0})]});
  doc = add(doc, 'FRAME', {id: 'screen', parentId: 'page', name: 'Screen', x: 0, y: 200, width: 390, height: 844});
  doc = createInstance(doc, 'v1', {parentId: 'screen', newId: 'inst', x: 20, y: 20}).doc;
  const copy = doc.nodes.inst.children![0];
  assert.equal(doc.nodes[copy].reactions.length, 1, 'the copy carries the main’s reaction');
  assert.equal(changeTarget(doc, copy, 'v2'), 'inst');
  assert.equal(changeTarget(doc, 'bg1', 'v2'), null, 'the main itself does not change');
  assert.deepEqual(changeDestinations(doc, copy), ['v1', 'v2']);
  assert.equal(actionIssue(doc, copy, doc.nodes[copy].reactions[0].actions[0]), null);
  const step = sessionStep(doc, startSession('screen'), {id: copy, surface: -1}, doc.nodes[copy].reactions[0].actions[0]);
  assert.deepEqual(step.state.variants, {inst: 'v2'});
  assert.deepEqual(step.effect, {kind: 'variant', instanceId: 'inst', from: 'v1', to: 'v2', transition: {type: 'SMART_ANIMATE', duration: 0.2, easing: 'EASE_OUT'}});
  // Navigating away resets variants.
  assert.deepEqual(navigateTo(step.state, 'screen').state.variants, {});
});

// ── Smart animate ────────────────────────────────────────────────────────────────────────────────

test('layers pair by name path, duplicates in order', () => {
  const doc = loginDoc();
  const keys = layerKeys(doc, 'code');
  assert.equal(keys.get('code'), '');
  assert.equal(keys.get('row1'), '/List/Row');
  assert.equal(keys.get('row2'), '/List/Row#1');
  const match = matchLayers(doc, 'login', doc, 'code');
  assert.equal(match.pairs.get('login'), 'code');
  assert.equal(match.pairs.get('button'), 'button2');
  assert.equal(match.pairs.get('title'), 'title2');
  assert.deepEqual([...match.onlyA].sort(), ['help']);
  assert.deepEqual([...match.onlyB].sort(), ['back', 'list', 'row1', 'row2', 'row3']);
});

test('the plan: same pictures move, changed shapes morph, the rest fades', () => {
  const doc = loginDoc();
  const plan = smartAnimatePlan(doc, 'login', doc, 'code');
  assert.equal(plan.mode, 'morph');
  const byB = new Map<string, MorphNode>(plan.children.map(child => [child.b ?? 'out:' + child.a, child]));
  assert.equal(byB.get('button2')?.mode, 'morph', 'colour, size and radius change');
  assert.equal(byB.get('title2')?.mode, 'same', 'identical text moves as a picture');
  assert.equal(byB.get('list')?.mode, 'in');
  assert.equal(byB.get('out:help')?.mode, 'out');
  // Outgoing layers come first (under), then the destination's paint order.
  assert.equal(plan.children[0].mode, 'out');
  // Different text cross-fades.
  const changed = update(doc, 'title2', {text: {...doc.nodes.title2.text!, characters: 'Code from SMS'}});
  const crossfade = smartAnimatePlan(doc, 'login', changed, 'code').children.find(child => child.b === 'title2');
  assert.equal(crossfade?.mode, 'crossfade');
  assert.ok(sameSubtree(doc, doc.nodes.title, doc, doc.nodes.title2));
  assert.ok(!sameSubtree(doc, doc.nodes.title, changed, changed.nodes.title2));
});

test('interpolation: geometry, the short way round, colours and radii, overshoot in range', () => {
  const doc = loginDoc();
  const a = doc.nodes.button, b = doc.nodes.button2;
  const mid = interpolateNode(a, b, 0.5);
  assert.equal(mid.y, 550);
  assert.equal(mid.height, 52);
  assert.equal(mid.cornerRadius, 20);
  const fill = mid.fills[0];
  assert.ok(fill.type === 'SOLID');
  if (fill.type === 'SOLID') {
    close(fill.color.r, 0.05);
    close(fill.color.g, 0.6);
  }
  assert.equal(interpolateNode(a, b, 1), b);
  close(lerpAngle(350, 10, 0.5), 360);
  close(lerpAngle(10, 350, 0.5), 0);
  const over = interpolateNode({...a, opacity: 0.2}, {...b, opacity: 1, height: 0}, 1.3);
  assert.equal(over.opacity, 1);
  assert.equal(over.height, 0);
  // Per-corner radii interpolate per corner.
  const corners = interpolateNode({...a, rectangleCornerRadii: [0, 0, 0, 0]}, {...b, rectangleCornerRadii: [20, 0, 0, 10]}, 0.5);
  assert.deepEqual(corners.rectangleCornerRadii, [10, 0, 0, 5]);
});
