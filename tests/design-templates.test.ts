import {test} from 'node:test';
import assert from 'node:assert/strict';
import type {DesignDocument, SceneNode, TextStyle} from '../shared/design/types';
import type {TextMeasurer} from '../shared/design/text-layout';
import {normalizeDocument} from '../shared/design/normalize';
import {validateDocument} from '../shared/design/schema';
import {propertyDefinitionsOf} from '../shared/design/components';
import {variantSetIssues} from '../shared/design/variants';
import {fontFamilies} from '../shared/fonts';
import {DESIGN_TEMPLATES, templateById} from '../shared/design/templates';
import {flowStartingPoints, hotspotsOf, reactionIssues, topLevelFrameOf} from '../shared/design/prototype';
import {toReact} from '../shared/design/codegen/react';

// Starter templates: each builds a document the server accepts, laid out to a fixed point, set only in
// catalogue fonts the template declares, with component structures the editor itself would make.

const measurer: TextMeasurer = {
  width: (text, font) => text.length * font.size * 0.56,
  metrics: font => ({ascent: font.size * 0.8, descent: font.size * 0.2}),
};

let seq = 0;
const ids = () => `t${(seq++).toString(36)}`;
const built = new Map<string, DesignDocument>();
const docOf = (id: string) => {
  if (!built.has(id)) built.set(id, templateById(id)!.build({measurer, newId: ids}));
  return built.get(id)!;
};
const nodesOf = (doc: DesignDocument) => Object.values(doc.nodes);

/** Every family and weight of the catalogue (shared/fonts.ts): variable families span a range. */
function catalogueAllows(family: string, weight: number): boolean {
  const font = Object.values(fontFamilies).find(entry => entry.family === family);
  if (!font) return false;
  if (font.files) return font.files.some(file => String(file.weight).split(/\s+/).map(Number).some((w, i, all) => (all.length > 1 ? weight >= all[0] && weight <= all[1] : w === weight)));
  if (font.variable) return weight >= font.weights[0] && weight <= font.weights[font.weights.length - 1];
  return font.weights.includes(weight);
}

function textStyles(doc: DesignDocument): Partial<TextStyle>[] {
  const out: Partial<TextStyle>[] = [];
  for (const node of nodesOf(doc)) {
    if (!node.text) continue;
    out.push(node.text.style);
    for (const run of node.text.runs) out.push({...node.text.style, ...run.style});
  }
  for (const style of Object.values(doc.styles)) if (style.text) out.push(style.text);
  return out;
}

test('the catalogue lists seven templates with unique ids, names and descriptions', () => {
  assert.deepEqual(DESIGN_TEMPLATES.map(template => template.id), ['blank', 'mobile', 'site', 'presentation', 'social', 'ui-kit', 'marketplace']);
  assert.deepEqual(DESIGN_TEMPLATES.map(template => template.name), ['Blank file', 'Mobile app', 'Website', 'Presentation', 'Social media', 'UI kit', 'Marketplace card']);
  for (const template of DESIGN_TEMPLATES) assert.ok(template.description.length > 5, template.id);
  assert.equal(templateById('nope'), undefined);
});

for (const template of DESIGN_TEMPLATES) {
  test(`«${template.name}» passes the server's schema and invariants`, () => {
    const doc = docOf(template.id);
    const checked = validateDocument(JSON.parse(JSON.stringify(doc)));
    assert.ok(checked.ok, checked.ok ? '' : `${checked.error} at ${checked.path}`);
    assert.ok(doc.pages.length >= 1);
  });

  test(`«${template.name}» is laid out: normalizing it again changes nothing`, () => {
    const doc = docOf(template.id);
    const again = normalizeDocument(doc, new Set(Object.keys(doc.nodes)), {measurer});
    assert.deepEqual(again, doc);
  });

  test(`«${template.name}» sets type only in catalogue fonts it declares`, () => {
    const doc = docOf(template.id);
    const declared = new Map(template.fonts.map(font => [font.family, new Set(font.weights)]));
    for (const style of textStyles(doc)) {
      const family = style.fontFamily!, weight = style.fontWeight!;
      assert.ok(catalogueAllows(family, weight), `${family} ${weight} is not in the catalogue`);
      assert.ok(declared.get(family)?.has(weight), `${template.id}: ${family} ${weight} is used but not declared`);
    }
    for (const [family, weights] of declared) for (const weight of weights) assert.ok(catalogueAllows(family, weight), `${family} ${weight}`);
  });

  test(`«${template.name}» keeps line heights on a 4 px rhythm and styles in step with their nodes`, () => {
    const doc = docOf(template.id);
    for (const style of textStyles(doc)) {
      const line = style.lineHeight;
      assert.ok(line && line.unit === 'PIXELS' && line.value % 4 === 0, `${style.fontFamily} ${style.fontSize}: line ${JSON.stringify(line)}`);
    }
    for (const node of nodesOf(doc)) {
      for (const field of ['fillStyleId', 'strokeStyleId', 'effectStyleId', 'gridStyleId', 'textStyleId'] as const) {
        const id = node[field];
        if (id) assert.ok(doc.styles[id], `${node.name}: ${field} ${id} is missing`);
      }
      if (node.textStyleId && node.text && node.mainId === undefined) assert.deepEqual(node.text.style, doc.styles[node.textStyleId].text, `${node.name} differs from its text style`);
      if (node.effectStyleId && node.mainId === undefined) assert.deepEqual(node.effects, doc.styles[node.effectStyleId].effects, `${node.name} differs from its effect style`);
      for (const paint of [...node.fills, ...node.strokes]) {
        if (paint.type === 'SOLID' && paint.boundVariables?.color) assert.ok(doc.variables[paint.boundVariables.color.id], `${node.name}: unknown variable`);
      }
    }
  });

  test(`«${template.name}» builds components the way the editor does`, () => {
    const doc = docOf(template.id);
    const nodes = doc.nodes;
    for (const node of nodesOf(doc)) {
      if (node.type === 'COMPONENT_SET') {
        assert.deepEqual(variantSetIssues(doc, node.id), [], `${node.name} has variant issues`);
        assert.ok(node.children!.every(id => nodes[id].type === 'COMPONENT'), `${node.name} holds only components`);
        assert.ok(node.children!.length >= 2, `${node.name} has variants`);
      }
      if (node.type === 'COMPONENT') {
        for (let parent = nodes[node.parentId!]; parent; parent = nodes[parent.parentId ?? ''])
          assert.ok(parent.type !== 'COMPONENT' && parent.type !== 'INSTANCE', `${node.name} is nested in a component`);
      }
      if (node.type === 'INSTANCE') {
        const main = nodes[node.componentId!];
        assert.equal(main?.type, 'COMPONENT', `${node.name}: instance of a missing component`);
        const defs = propertyDefinitionsOf(doc, main.id);
        for (const key of Object.keys(node.componentProperties ?? {})) assert.ok(defs[key], `${node.name}: unknown property ${key}`);
      }
      const refs = node.componentPropertyReferences;
      if (refs && node.mainId === undefined) {
        let owner: SceneNode | undefined = nodes[node.parentId!];
        while (owner && owner.type !== 'COMPONENT') owner = nodes[owner.parentId ?? ''];
        assert.ok(owner, `${node.name} is bound outside a component`);
        const defs = propertyDefinitionsOf(doc, owner!.id);
        for (const key of Object.values(refs)) assert.ok(defs[key!], `${node.name}: bound to missing ${key}`);
      }
    }
  });
}

test('the mobile app: iPhone 16 screens, a «Theme» collection with light and dark modes, the kit on its own page', () => {
  const doc = docOf('mobile');
  const page = (name: string) => doc.nodes[doc.pages.find(id => doc.nodes[id].name === name)!];
  const screens = page('Screens').children!.map(id => doc.nodes[id]);
  assert.deepEqual(screens.map(screen => screen.name), ['Sign in', 'Feed', 'Profile', 'Feed — dark theme']);
  for (const screen of screens) assert.deepEqual([screen.width, screen.height, screen.autoLayout?.layoutMode], [393, 852, 'VERTICAL']);
  const theme = Object.values(doc.variableCollections).find(collection => collection.name === 'Theme')!;
  assert.deepEqual(theme.modes.map(mode => mode.name), ['Light', 'Dark']);
  const dark = screens[3];
  assert.equal(doc.variableModes?.[dark.id]?.[theme.id], theme.modes[1].modeId);
  assert.notDeepEqual(dark.fills, screens[1].fills, 'the dark screen resolves its background in the dark mode');
  const sets = Object.values(doc.nodes).filter(node => node.type === 'COMPONENT_SET').map(node => node.name).sort();
  assert.deepEqual(sets, ['Button', 'Chip', 'Icon', 'Input field', 'Tab']);
  const button = Object.values(doc.nodes).find(node => node.type === 'COMPONENT_SET' && node.name === 'Button')!;
  assert.deepEqual(button.children!.map(id => doc.nodes[id].name), [
    'Type=Primary, State=Default', 'Type=Primary, State=Hover', 'Type=Secondary, State=Default', 'Type=Secondary, State=Hover',
  ]);
  const nav = Object.values(doc.nodes).find(node => node.type === 'COMPONENT' && node.name === 'Bottom navigation')!;
  const tabs = nav.children!.map(id => doc.nodes[id]).filter(node => node.type === 'INSTANCE');
  assert.equal(tabs.length, 4);
  assert.ok(tabs.every(tab => tab.children!.some(id => doc.nodes[id].type === 'INSTANCE')), 'every tab carries an icon instance');
  // Each tab's icon is the tab's "Icon" property (INSTANCE_SWAP), so the tab bar's four icons differ and its React code
  // passes them as props, instead of four home icons and a comment.
  const glyphs = tabs.map(tab => doc.nodes[doc.nodes[tab.children!.find(id => doc.nodes[id].type === 'INSTANCE')!].componentId!].name);
  assert.deepEqual(glyphs, ['Type=Home', 'Type=Search', 'Type=Favorites', 'Type=Profile']);
  const tabSet = Object.values(doc.nodes).find(node => node.type === 'COMPONENT_SET' && node.name === 'Tab')!;
  assert.deepEqual(Object.values(propertyDefinitionsOf(doc, tabSet.id)).map(def => def.type).sort(), ['INSTANCE_SWAP', 'TEXT', 'VARIANT']);
  const code = toReact(doc, [nav.id], {measurer}).files.find(file => file.path === 'src/components/BottomNavigation.tsx')!.contents;
  // The four tabs are one usage over typed data, each with its own icon.
  for (const type of ['search', 'favorites', 'profile']) assert.match(code, new RegExp(`icon: <Icon variant="${type}" />`), code);
  assert.match(code, /\{items\.map\(item => \(\n\s+<Tab key=\{item\.label\} state=\{item\.state\} icon=\{item\.icon\} className=\{styles\.item\}>\{item\.label\}<\/Tab>/, code);
  assert.doesNotMatch(code, /was changed in the design/);
  // The active tab keeps its accent-coloured icon.
  const activeIcon = doc.nodes[tabs[0].children!.find(id => doc.nodes[id].type === 'INSTANCE')!];
  const outline = doc.nodes[activeIcon.children![0]];
  assert.ok(outline.strokes.some(paint => paint.type === 'SOLID' && paint.boundVariables?.color), 'the active icon is drawn in the accent colour');
  const styles = Object.values(doc.styles);
  assert.ok(styles.some(style => style.type === 'TEXT') && styles.some(style => style.type === 'FILL'));
});

test('the site: a 1440 px page on a 12-column grid, every block in auto layout', () => {
  const doc = docOf('site');
  const frame = doc.nodes[doc.nodes[doc.pages[0]].children![0]];
  assert.equal(frame.width, 1440);
  assert.deepEqual(frame.layoutGrids?.map(grid => grid.pattern === 'COLUMNS' && [grid.count, grid.gutterSize, grid.offset]), [[12, 24, 120]]);
  assert.deepEqual(frame.children!.map(id => doc.nodes[id].name), ['Header', 'Hero', 'Customers', 'Features', 'Call to action', 'Footer']);
  for (const id of frame.children!) assert.notEqual(doc.nodes[id].autoLayout?.layoutMode, 'NONE');
});

test('the presentation, the social formats and the UI kit have their sizes and pages', () => {
  const slides = docOf('presentation');
  assert.deepEqual(slides.nodes[slides.pages[0]].children!.map(id => [slides.nodes[id].width, slides.nodes[id].height]), [[1920, 1080], [1920, 1080], [1920, 1080]]);
  const social = docOf('social');
  assert.deepEqual(social.nodes[social.pages[0]].children!.map(id => [social.nodes[id].width, social.nodes[id].height]), [[1080, 1080], [1080, 1920], [1280, 720]]);
  const kit = docOf('ui-kit');
  assert.deepEqual(kit.pages.map(id => kit.nodes[id].name), ['Components', 'Styles']);
  const sets = Object.values(kit.nodes).filter(node => node.type === 'COMPONENT_SET').map(node => node.name).sort();
  assert.deepEqual(sets, ['Avatar', 'Button', 'Checkbox', 'Input field', 'Tag', 'Toggle']);
  const button = Object.values(kit.nodes).find(node => node.type === 'COMPONENT_SET' && node.name === 'Button')!;
  assert.deepEqual(Object.values(button.componentPropertyDefinitions!).map(def => def.type).sort(), ['BOOLEAN', 'TEXT', 'VARIANT', 'VARIANT']);
});

test('a template uses fresh ids from the given source, so two files never share ids', () => {
  let n = 0;
  const first = templateById('presentation')!.build({measurer, newId: () => `a${n++}`});
  const second = templateById('presentation')!.build({measurer});
  const shared = Object.keys(first.nodes).filter(id => second.nodes[id]);
  assert.deepEqual(shared, []);
});

/** Every interaction of the file: the screen it is on, the layer, the trigger and where it leads. */
function routes(doc: DesignDocument): string[] {
  const out: string[] = [];
  for (const node of nodesOf(doc)) {
    for (const reaction of node.reactions) {
      assert.deepEqual(reactionIssues(doc, node.id, reaction), [], `${node.name}: a playable interaction`);
      const key = reaction.trigger.type === 'ON_KEY_DOWN' ? ` ${reaction.trigger.keyCode}` : '';
      for (const action of reaction.actions) {
        if (action.type !== 'NODE') continue;
        const frame = topLevelFrameOf(doc, node.id);
        out.push(`${frame ? doc.nodes[frame].name : '?'}: ${node.name} ${reaction.trigger.type}${key} ${action.navigation} ${doc.nodes[action.destinationId].name}`);
      }
    }
  }
  return out.sort();
}

test('the mobile app is a clickable prototype: sign-in to the feed, tabs and the avatar to the profile, the dark theme switch', () => {
  const doc = docOf('mobile');
  const screens = doc.pages.find(id => doc.nodes[id].name === 'Screens')!;
  assert.deepEqual(flowStartingPoints(doc, screens).map(flow => [doc.nodes[flow.nodeId].name, flow.name]), [['Sign in', 'App sign-in']]);
  assert.deepEqual(doc.nodes[screens].prototypeDevice, {type: 'PRESET', presetId: 'iphone-16', rotation: 0});
  assert.deepEqual(routes(doc), [
    'Feed — dark theme: Avatar ON_CLICK NAVIGATE Profile',
    'Feed — dark theme: Profile ON_CLICK NAVIGATE Profile',
    'Feed: Avatar ON_CLICK NAVIGATE Profile',
    'Feed: Profile ON_CLICK NAVIGATE Profile',
    'Profile: Dark theme ON_CLICK NAVIGATE Feed — dark theme',
    'Profile: Tab ON_CLICK NAVIGATE Feed',
    'Sign in: Button ON_CLICK NAVIGATE Feed',
  ]);
  // The tabs are copies inside tab bar instances: their interactions are overrides, so the bar stays one component.
  const tabs = nodesOf(doc).filter(node => node.reactions.length && node.mainId !== undefined);
  assert.equal(tabs.length, 3);
  for (const tab of tabs) assert.ok(tab.overrides?.includes('reactions'), `${tab.name} keeps its interaction as an override`);
  // "Sign in" is what a click on the sign-in screen reaches.
  const signIn = doc.nodes[screens].children!.find(id => doc.nodes[id].name === 'Sign in')!;
  const spots = hotspotsOf(doc, signIn, {}, {width: 393, height: 852}).map(spot => doc.nodes[spot.id]);
  assert.deepEqual(spots.map(node => node.componentProperties && Object.values(node.componentProperties)), [['Primary', 'Default', 'Sign in']]);
});

test('the presentation plays as a deck and the site scrolls to its sections', () => {
  const slides = docOf('presentation');
  assert.deepEqual(flowStartingPoints(slides, slides.pages[0]).map(flow => [slides.nodes[flow.nodeId].name, flow.name]), [['01 — Title', 'Presentation']]);
  assert.deepEqual(routes(slides), [
    '01 — Title: 01 — Title ON_CLICK NAVIGATE 02 — Findings',
    '01 — Title: 01 — Title ON_KEY_DOWN ArrowRight NAVIGATE 02 — Findings',
    '02 — Findings: 02 — Findings ON_CLICK NAVIGATE 03 — Growth',
    '02 — Findings: 02 — Findings ON_KEY_DOWN ArrowLeft NAVIGATE 01 — Title',
    '02 — Findings: 02 — Findings ON_KEY_DOWN ArrowRight NAVIGATE 03 — Growth',
    '03 — Growth: 03 — Growth ON_KEY_DOWN ArrowLeft NAVIGATE 02 — Findings',
  ]);
  const site = docOf('site');
  assert.deepEqual(flowStartingPoints(site, site.pages[0]).map(flow => flow.name), ['Landing page']);
  assert.deepEqual(site.nodes[site.pages[0]].prototypeDevice, {type: 'PRESET', presetId: 'desktop', rotation: 0});
  assert.deepEqual(routes(site), [
    'Home — 1440: Button — Start for free ON_CLICK SCROLL_TO Call to action',
    'Home — 1440: Button — Try for free ON_CLICK SCROLL_TO Call to action',
    'Home — 1440: Customers ON_CLICK SCROLL_TO Customers',
    'Home — 1440: Features ON_CLICK SCROLL_TO Features',
  ]);
});
