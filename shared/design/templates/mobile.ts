import type {DesignDocument, NodeId, Reaction, Transition} from '../types';
import {docBoard} from './board';
import {ICONS, type IconName} from './icons';
import {linear, TemplateBuilder, type BuildOptions, type ColorToken} from './kit';

// "Mobile app": a reading app on iPhone 16 (393 × 852): sign-in, feed, profile, and the feed
// again in the dark theme. Everything is auto layout; colours are variables of the "Theme" collection
// (Light / Dark), so the dark screen is the same instances with another mode. The "Components" page
// documents the kit: icons, buttons, chips, input fields, the card, tab items, the tab bar, the status bar.
// The screens are a clickable prototype, as Figma's starter files are: ▶ starts at "Sign in", "Sign in" opens the feed,
// the tab bar and the avatar move between the feed and the profile, and "Dark theme" shows the dark feed.

const W = 393;
const H = 852;
const INTER = 'Inter';

const ICON_NAMES: [string, IconName][] = [
  ['Home', 'home'], ['Search', 'search'], ['Favorites', 'heart'], ['Profile', 'user'], ['Notifications', 'bell'],
  ['Messages', 'message'], ['Bookmark', 'bookmark'], ['Share', 'share'], ['Back', 'arrowLeft'], ['Next', 'chevronRight'],
  ['Lock', 'lock'], ['Moon', 'moon'],
];

export function buildMobileApp(options: BuildOptions): DesignDocument {
  const b = new TemplateBuilder(options);
  const screens = b.page('Screens', '#E9EBEF');
  const kit = b.page('Components', '#E9EBEF');

  // ── Tokens ──
  const theme = b.collection('Theme', ['Light', 'Dark']);
  const c = {
    bg: b.colorVariable(theme, 'Background/Primary', ['#FFFFFF', '#0E0F13'], 'Screen background'),
    surface: b.colorVariable(theme, 'Background/Surface', ['#F3F4F6', '#1B1D24'], 'Fields, chips, badges'),
    card: b.colorVariable(theme, 'Background/Card', ['#FFFFFF', '#16181E'], 'Cards and lists'),
    text: b.colorVariable(theme, 'Text/Primary', ['#111318', '#F3F4F6']),
    text2: b.colorVariable(theme, 'Text/Secondary', ['#6B7080', '#9DA2AF']),
    border: b.colorVariable(theme, 'Border', ['#E4E6EB', '#2A2D36']),
    accent: b.colorVariable(theme, 'Accent/Primary', ['#4F46E5', '#7B7FFF'], 'Main actions, active tab'),
    accentHover: b.colorVariable(theme, 'Accent/Hover', ['#4338CA', '#9599FF']),
    accentSoft: b.colorVariable(theme, 'Accent/Background', ['#EEF0FF', '#23254D']),
    onAccent: b.colorVariable(theme, 'Text/On accent', ['#FFFFFF', '#FFFFFF']),
  };
  b.numberVariable(theme, 'Radius/Card', [20, 20]);
  const palette = {
    indigo: b.colorStyle('Palette/Indigo 600', '#4F46E5'),
    indigoSoft: b.colorStyle('Palette/Indigo 50', '#EEF0FF'),
    ink: b.colorStyle('Palette/Graphite 900', '#111318'),
    grey: b.colorStyle('Palette/Graphite 500', '#6B7080'),
    mist: b.colorStyle('Palette/Graphite 100', '#F3F4F6'),
    success: b.colorStyle('Status/Success', '#16A34A'),
    danger: b.colorStyle('Status/Error', '#E5484D'),
  };
  const t = {
    h1: b.textStyle('Heading/H1', {family: INTER, weight: 700, size: 28, line: 36, tracking: -2}),
    h2: b.textStyle('Heading/H2', {family: INTER, weight: 600, size: 22, line: 28, tracking: -1.5}),
    h3: b.textStyle('Heading/H3', {family: INTER, weight: 600, size: 17, line: 24, tracking: -1}),
    body: b.textStyle('Text/Primary', {family: INTER, weight: 400, size: 16, line: 24, tracking: -0.5}),
    small: b.textStyle('Text/Small', {family: INTER, weight: 400, size: 14, line: 20}),
    label: b.textStyle('Text/Label', {family: INTER, weight: 500, size: 14, line: 20}),
    caption: b.textStyle('Caption', {family: INTER, weight: 500, size: 12, line: 16}),
    button: b.textStyle('Button', {family: INTER, weight: 600, size: 16, line: 24, tracking: -0.5}),
  };

  // ── Components page ──
  const board = docBoard(b, kit, {
    title: 'Components',
    lead: 'Kit of the "Feed" app. Colors are variables of the "Theme" collection: switch the frame\'s mode to "Dark" and the screen recolors.',
  });

  // Icons: one set, a variant per glyph, the stroke named "Outline" in every one.
  const iconRow = board.section('Icons', '24 × 24, 2 px stroke. Change the variant in the "Type" property.', {gap: 20});
  const icons = ICON_NAMES.map(([name, glyph]) => {
    const frame = b.frame(iconRow, {name: `Icon/Type=${name}`, w: 24, h: 24, clip: false});
    b.vector(frame, ICONS[glyph], {name: 'Outline', w: 24, h: 24, viewBox: 24, stroke: c.text, strokeWeight: 2, strokeCap: 'ROUND', strokeJoin: 'ROUND', constraints: {horizontal: 'SCALE', vertical: 'SCALE'}});
    return b.component(frame);
  });
  b.normalize();
  const icon = b.variants(icons, 'Interface icons. The stroke color is the "Text/Primary" variable.');
  /** The icon set's variant of a glyph ("Home" → its component), for the tab's "Icon" property. */
  const iconVariant = (name: string) => icons[ICON_NAMES.findIndex(([each]) => each === name)];

  // Buttons
  const buttonRow = board.section('Button', 'Primary is the one main action on a screen, secondary is for the rest. Height 48.');
  const buttons: NodeId[] = [];
  for (const kind of ['Primary', 'Secondary'] as const) {
    for (const state of ['Default', 'Hover'] as const) {
      const primary = kind === 'Primary';
      const fill: ColorToken = primary ? (state === 'Default' ? c.accent : c.accentHover) : (state === 'Default' ? c.card : c.surface);
      const frame = b.frame(buttonRow, {
        name: `Button/Type=${kind}, State=${state}`, layout: 'row', pad: [12, 24], gap: 8, main: 'center', cross: 'center',
        radius: 12, fill, stroke: primary ? null : c.border, strokeWeight: 1, strokeAlign: 'INSIDE',
      });
      b.text(frame, 'Continue', t.button, {name: 'Text', color: primary ? c.onAccent : c.text});
      buttons.push(b.component(frame));
    }
  }
  b.normalize();
  const button = b.variants(buttons, 'Button the full width of the screen or hugging its content.');
  const buttonText = b.property(button, 'Text', 'TEXT', 'Continue');
  for (const variant of b.node(button).children!) b.bind(b.named(variant, 'Text'), 'characters', buttonText);

  // Chips
  const chipRow = board.section('Chip', 'Feed filters. The active chip is dark.');
  const chips = (['Active', 'Default'] as const).map(state => {
    const active = state === 'Active';
    const frame = b.frame(chipRow, {name: `Chip/State=${state}`, layout: 'row', pad: [8, 16], radius: 18, cross: 'center', fill: active ? c.text : c.surface});
    b.text(frame, 'For you', t.label, {name: 'Text', color: active ? c.bg : c.text});
    return b.component(frame);
  });
  b.normalize();
  const chip = b.variants(chips);
  const chipText = b.property(chip, 'Text', 'TEXT', 'For you');
  for (const variant of b.node(chip).children!) b.bind(b.named(variant, 'Text'), 'characters', chipText);

  // Input fields
  const inputRow = board.section('Input field', 'Label above the field, field height 48. Explain the error below the field.');
  const inputs = (['Default', 'Focus', 'Error'] as const).map(state => {
    const frame = b.frame(inputRow, {name: `Input field/State=${state}`, layout: 'col', gap: 8, w: 345});
    b.text(frame, 'Email', t.label, {name: 'Label', color: c.text});
    const field = b.frame(frame, {
      name: 'Field', layout: 'row', w: 'fill', pad: [12, 16], gap: 8, cross: 'center', radius: 12,
      fill: state === 'Focus' ? c.card : c.surface,
      stroke: state === 'Focus' ? c.accent : state === 'Error' ? palette.danger : c.border,
      strokeWeight: state === 'Default' ? 1 : 2, strokeAlign: 'INSIDE',
    });
    b.text(field, 'name@example.com', t.body, {name: 'Value', color: state === 'Default' ? c.text2 : c.text, w: 'fill'});
    b.text(frame, 'Check the address: it has no "@"', t.caption, {name: 'Error', color: palette.danger, visible: state === 'Error'});
    return b.component(frame);
  });
  b.normalize();
  const input = b.variants(inputs);
  const inputLabel = b.property(input, 'Label', 'TEXT', 'Email');
  const inputValue = b.property(input, 'Value', 'TEXT', 'name@example.com');
  for (const variant of b.node(input).children!) {
    b.bind(b.named(variant, 'Label'), 'characters', inputLabel);
    b.bind(b.named(variant, 'Value'), 'characters', inputValue);
  }

  // Card
  const cardRow = board.section('Card', 'Feed article: cover, a heading of up to two lines, author and actions.');
  const card = b.frame(cardRow, {name: 'Card', layout: 'col', w: 345, pad: 12, gap: 12, radius: 20, fill: c.card, stroke: c.border, strokeWeight: 1, strokeAlign: 'INSIDE', clip: true});
  const cover = b.frame(card, {name: 'Cover', layout: 'row', w: 'fill', h: 176, pad: 12, radius: 12, fill: linear([['#6366F1'], ['#A855F7']], 45)});
  const tag = b.frame(cover, {name: 'Tag', layout: 'row', pad: [4, 10], radius: 12, fill: {hex: '#FFFFFF', opacity: 0.92}});
  b.text(tag, 'Design', t.caption, {name: 'Category', color: '#111318'});
  const cardText = b.frame(card, {name: 'Text', layout: 'col', w: 'fill', gap: 4, pad: [0, 4]});
  b.text(cardText, 'How to build a design system in a week', t.h3, {name: 'Heading', color: c.text, w: 'fill'});
  b.text(cardText, '8 min read · Today', t.small, {name: 'Description', color: c.text2, w: 'fill'});
  const cardFoot = b.frame(card, {name: 'Footer', layout: 'row', w: 'fill', gap: 'auto', cross: 'center', pad: [0, 4, 4, 4]});
  const author = b.frame(cardFoot, {name: 'Author', layout: 'row', gap: 8, cross: 'center'});
  b.ellipse(author, {name: 'Avatar', w: 28, h: 28, fill: linear([['#F59E0B'], ['#EF4444']], 45)});
  b.text(author, 'Maria Lopez', t.label, {name: 'Name', color: c.text});
  const actions = b.frame(cardFoot, {name: 'Actions', layout: 'row', gap: 16, cross: 'center'});
  b.normalize();
  b.instance(actions, icon, {name: 'Like', w: 20, h: 20}, {'Type': 'Favorites'});
  b.instance(actions, icon, {name: 'Save', w: 20, h: 20}, {'Type': 'Bookmark'});
  b.component(card, 'Feed article. The texts and the category are instance properties.');
  const cardTitle = b.property(card, 'Heading', 'TEXT', 'How to build a design system in a week');
  const cardMeta = b.property(card, 'Description', 'TEXT', '8 min read · Today');
  const cardAuthor = b.property(card, 'Author', 'TEXT', 'Maria Lopez');
  const cardTag = b.property(card, 'Category', 'TEXT', 'Design');
  b.bind(b.named(card, 'Heading'), 'characters', cardTitle);
  b.bind(b.named(card, 'Description'), 'characters', cardMeta);
  b.bind(b.named(card, 'Name'), 'characters', cardAuthor);
  b.bind(b.named(card, 'Category'), 'characters', cardTag);

  // Tab items and the tab bar
  const tabRow = board.section('Bottom navigation', 'Four tabs. The active tab uses the accent color; the icon is a nested instance of "Icons".');
  const tabs = (['Default', 'Active'] as const).map(state => {
    const frame = b.frame(tabRow, {name: `Tab/State=${state}`, layout: 'col', w: 80, gap: 4, pad: [4, 0], cross: 'center'});
    return frame;
  });
  b.normalize();
  tabs.forEach((frame, i) => {
    const active = i === 1;
    const glyph = b.instance(frame, icon, {name: 'Icon'});
    if (active) b.override(b.named(glyph, 'Outline'), {strokes: [{type: 'SOLID', color: {r: 0x4f / 255, g: 0x46 / 255, b: 0xe5 / 255}, opacity: 1, visible: true, blendMode: 'NORMAL', boundVariables: {color: {type: 'VARIABLE_ALIAS', id: c.accent.variable!}}}]});
    b.text(frame, 'Home', t.caption, {name: 'Label', color: active ? c.accent : c.text2});
    b.component(frame);
  });
  b.normalize();
  const tab = b.variants(tabs);
  const tabLabel = b.property(tab, 'Label', 'TEXT', 'Home');
  // The icon is a property of the tab, as design-system kits expose it: the tab bar picks each tab's icon there, and the
  // React export takes it as a prop (`icon={<Icon type="search" />}`).
  const tabIcon = b.property(tab, 'Icon', 'INSTANCE_SWAP', iconVariant('Home'));
  for (const variant of b.node(tab).children!) {
    b.bind(b.named(variant, 'Label'), 'characters', tabLabel);
    b.bind(b.named(variant, 'Icon'), 'mainComponent', tabIcon);
  }

  const nav = b.frame(tabRow, {name: 'Bottom navigation', layout: 'row', w: W, pad: [6, 8, 26, 8], fill: c.bg, stroke: c.border, strokeWeight: 1, strokeAlign: 'INSIDE', clip: false});
  b.update(nav, {individualStrokeWeights: {top: 1, right: 0, bottom: 0, left: 0}});
  b.normalize();
  const tabNames: [string, string][] = [['Home', 'Home'], ['Search', 'Search'], ['Favorites', 'Favorites'], ['Profile', 'Profile']];
  const items = tabNames.map(([label, glyph], i) => {
    return b.instance(nav, tab, {name: label, w: 'fill'}, {'State': i === 0 ? 'Active' : 'Default', 'Label': label, 'Icon': iconVariant(glyph)});
  });
  b.normalize();
  // The home indicator sits 8 px above the bottom edge, placed once the bar has its height.
  b.rect(nav, {name: 'Indicator', w: 134, h: 5, radius: 3, fill: c.text, absolute: true, x: (W - 134) / 2, y: b.node(nav).height - 8 - 5, constraints: {horizontal: 'CENTER', vertical: 'MAX'}});
  b.component(nav, 'Tab bar with a home indicator. Switch the active tab with the "State" property of the nested tab.');

  // Status bar
  const statusRow = board.section('Status bar', 'iPhone system bar: 54 px at the top of every screen.');
  const status = b.frame(statusRow, {name: 'Status bar', layout: 'row', w: W, h: 54, pad: [0, 28, 0, 40], gap: 'auto', cross: 'center', fill: null});
  b.text(status, '9:41', {family: INTER, weight: 600, size: 17, line: 24, tracking: -2}, {name: 'Time', color: c.text});
  const indicators = b.frame(status, {name: 'Indicators', layout: 'row', gap: 6, cross: 'center'});
  const signal = b.frame(indicators, {name: 'Signal', layout: 'row', gap: 2, cross: 'end', h: 12});
  for (const height of [4, 6, 9, 12]) b.rect(signal, {name: 'Bar', w: 3, h: height, radius: 1, fill: c.text});
  b.vector(indicators, ['M1 4.2a10.6 10.6 0 0 1 14 0', 'M3.4 6.9a7 7 0 0 1 9.2 0', 'M5.8 9.6a3.4 3.4 0 0 1 4.4 0'], {name: 'Wi-Fi', w: 16, h: 12, viewBox: 16, stroke: c.text, strokeWeight: 1.6, strokeCap: 'ROUND'});
  const battery = b.frame(indicators, {name: 'Battery', w: 27.5, h: 12});
  b.rect(battery, {name: 'Body', x: 0, y: 0, w: 25, h: 12, radius: 4, fill: null, stroke: c.text, strokeWeight: 1, strokeAlign: 'INSIDE', opacity: 0.4});
  b.rect(battery, {name: 'Charge', x: 2, y: 2, w: 21, h: 8, radius: 2, fill: c.text});
  b.rect(battery, {name: 'Terminal', x: 26, y: 4, w: 1.5, h: 4, radius: 1, fill: c.text, opacity: 0.4});
  b.component(status);
  b.normalize();

  // ── Screens ──
  const screen = (name: string) => b.frame(screens, {name, w: W, h: H, layout: 'col', fill: c.bg, clip: true});
  const homeIndicator = (parent: NodeId) =>
    b.rect(parent, {name: 'Indicator', w: 134, h: 5, radius: 3, fill: c.text, absolute: true, x: (W - 134) / 2, y: H - 8 - 5, constraints: {horizontal: 'CENTER', vertical: 'MAX'}});
  const iconButton = (parent: NodeId, glyph: string, name: string) => {
    const frame = b.frame(parent, {name, layout: 'row', w: 40, h: 40, radius: 20, main: 'center', cross: 'center', fill: c.surface});
    b.instance(frame, icon, {name: 'Icon', w: 20, h: 20}, {'Type': glyph});
    return frame;
  };
  const avatar = (parent: NodeId, size: number, initials: string, colors: [string, string]) => {
    const frame = b.frame(parent, {name: 'Avatar', layout: 'row', w: size, h: size, radius: size / 2, main: 'center', cross: 'center', fill: linear([[colors[0]], [colors[1]]], 45), clip: true});
    b.text(frame, initials, {family: INTER, weight: 600, size: Math.round(size * 0.36), line: Math.round((size * 0.5) / 4) * 4, tracking: -1}, {name: 'Initials', color: '#FFFFFF'});
    return frame;
  };

  // Sign in
  const signIn = screen('Sign in');
  b.instance(signIn, status, {w: 'fill'});
  const signInBody = b.frame(signIn, {name: 'Content', layout: 'col', w: 'fill', h: 'fill', pad: [24, 24, 40, 24], gap: 40});
  const intro = b.frame(signInBody, {name: 'Greeting', layout: 'col', w: 'fill', gap: 24});
  const logo = b.frame(intro, {name: 'Logo', layout: 'row', w: 56, h: 56, radius: 16, main: 'center', cross: 'center', fill: c.accent});
  b.vector(logo, 'M13 2.5 4.5 13.5H11l-1 8 8.5-11H12Z', {name: 'Mark', w: 28, h: 28, viewBox: 24, fill: '#FFFFFF', stroke: '#FFFFFF', strokeWeight: 1.5, strokeJoin: 'ROUND'});
  const greeting = b.frame(intro, {name: 'Heading', layout: 'col', w: 'fill', gap: 8});
  b.text(greeting, 'Welcome back', t.h1, {color: c.text});
  b.text(greeting, 'Sign in to read collections and save articles on all your devices.', t.body, {color: c.text2, w: 'fill'});
  const form = b.frame(signInBody, {name: 'Form', layout: 'col', w: 'fill', gap: 16});
  b.instance(form, input, {w: 'fill'}, {'Label': 'Email', 'Value': 'anna@studio.example'});
  b.instance(form, input, {w: 'fill'}, {'State': 'Focus', 'Label': 'Password', 'Value': '••••••••••'});
  const forgot = b.frame(form, {name: 'Recovery', layout: 'row', w: 'fill', main: 'end'});
  b.text(forgot, 'Forgot password?', t.label, {color: c.accent});
  b.frame(signInBody, {name: 'Spacer', w: 'fill', h: 'fill'});
  const signInActions = b.frame(signInBody, {name: 'Actions', layout: 'col', w: 'fill', gap: 12});
  const enter = b.instance(signInActions, button, {w: 'fill'}, {'Text': 'Sign in'});
  b.instance(signInActions, button, {w: 'fill'}, {'Type': 'Secondary', 'Text': 'Create account'});
  b.text(signInActions, 'By continuing, you accept the terms of service and the privacy policy.', t.caption, {color: c.text2, w: 'fill', align: 'CENTER'});
  homeIndicator(signIn);

  // Feed (twice: light and dark)
  const feed = (name: string) => {
    const frame = screen(name);
    b.instance(frame, status, {w: 'fill'});
    const header = b.frame(frame, {name: 'Header', layout: 'row', w: 'fill', pad: [8, 24, 16, 24], gap: 'auto', cross: 'center'});
    const titles = b.frame(header, {name: 'Heading', layout: 'col', gap: 2});
    b.text(titles, 'Good morning, Anna', t.small, {color: c.text2});
    b.text(titles, 'Feed', t.h1, {color: c.text});
    const tools = b.frame(header, {name: 'Actions', layout: 'row', gap: 12, cross: 'center'});
    iconButton(tools, 'Notifications', 'Notifications');
    const me = avatar(tools, 40, 'AS', ['#6366F1', '#22D3EE']);
    const filters = b.frame(frame, {name: 'Filters', layout: 'row', w: 'fill', pad: [0, 24], gap: 8, clip: false});
    b.instance(filters, chip, {}, {'State': 'Active', 'Text': 'For you'});
    for (const label of ['Following', 'Popular', 'New']) b.instance(filters, chip, {}, {'State': 'Default', 'Text': label});
    const list = b.frame(frame, {name: 'Articles', layout: 'col', w: 'fill', h: 'fill', pad: [16, 24, 0, 24], gap: 16, clip: true});
    b.instance(list, card, {w: 'fill'});
    const second = b.instance(list, card, {w: 'fill'}, {
      'Heading': 'Typography in interfaces: seven rules', 'Description': '5 min read · Yesterday', 'Author': 'Ethan Brooks', 'Category': 'Typography',
    });
    b.override(b.named(second, 'Cover'), {fills: [linear([['#F97316'], ['#F43F5E']], 45)]});
    b.override(b.named(second, 'Avatar'), {fills: [linear([['#10B981'], ['#0EA5E9']], 45)]});
    const third = b.instance(list, card, {w: 'fill'}, {'Heading': 'The 8 px grid: why you need it', 'Description': '4 min read · 3 days ago', 'Author': 'Oliver Miles', 'Category': 'Basics'});
    b.override(b.named(third, 'Cover'), {fills: [linear([['#14B8A6'], ['#0EA5E9']], 45)]});
    const bar = b.instance(frame, nav, {w: 'fill'});
    return {frame, bar, me};
  };
  const feedLight = feed('Feed');

  // Profile
  const profile = screen('Profile');
  b.instance(profile, status, {w: 'fill'});
  const profileTop = b.frame(profile, {name: 'Header', layout: 'row', w: 'fill', pad: [8, 24, 8, 24], gap: 'auto', cross: 'center'});
  b.text(profileTop, 'Profile', t.h1, {color: c.text});
  iconButton(profileTop, 'Share', 'Share');
  const profileBody = b.frame(profile, {name: 'Content', layout: 'col', w: 'fill', h: 'fill', pad: [16, 24, 24, 24], gap: 24, clip: true});
  const person = b.frame(profileBody, {name: 'User', layout: 'col', w: 'fill', gap: 16, cross: 'center'});
  avatar(person, 96, 'AS', ['#6366F1', '#22D3EE']);
  const who = b.frame(person, {name: 'Name', layout: 'col', gap: 4, cross: 'center'});
  b.text(who, 'Anna Smith', t.h2, {color: c.text, align: 'CENTER'});
  b.text(who, 'Product designer · New York', t.small, {color: c.text2, align: 'CENTER'});
  const stats = b.frame(profileBody, {name: 'Statistics', layout: 'row', w: 'fill', pad: [16, 8], radius: 16, fill: c.surface});
  for (const [value, label] of [['128', 'articles'], ['4.2K', 'readers'], ['312', 'following']]) {
    const stat = b.frame(stats, {name: label, layout: 'col', w: 'fill', gap: 2, cross: 'center'});
    b.text(stat, value, t.h3, {color: c.text, align: 'CENTER'});
    b.text(stat, label, t.caption, {color: c.text2, align: 'CENTER'});
  }
  const profileActions = b.frame(profileBody, {name: 'Actions', layout: 'row', w: 'fill', gap: 12});
  b.instance(profileActions, button, {w: 'fill'}, {'Text': 'Edit'});
  b.instance(profileActions, button, {w: 'fill'}, {'Type': 'Secondary', 'Text': 'Statistics'});
  const settings = b.frame(profileBody, {name: 'Settings', layout: 'col', w: 'fill', radius: 16, fill: c.card, stroke: c.border, strokeWeight: 1, strokeAlign: 'INSIDE', clip: true});
  const rows: [string, string, string | null][] = [['Notifications', 'Notifications', 'On'], ['Privacy', 'Lock', null], ['Dark theme', 'Moon', 'toggle']];
  let darkRow = null as NodeId | null;
  rows.forEach(([label, glyph, value], i) => {
    const row = b.frame(settings, {name: label, layout: 'row', w: 'fill', pad: [14, 16], gap: 12, cross: 'center', stroke: c.border, strokeWeight: 1, strokeAlign: 'INSIDE'});
    b.update(row, {individualStrokeWeights: {top: 0, right: 0, bottom: i < rows.length - 1 ? 1 : 0, left: 0}});
    b.instance(row, icon, {name: 'Icon', w: 20, h: 20}, {'Type': glyph});
    b.text(row, label, t.body, {color: c.text, w: 'fill'});
    if (value === 'toggle') {
      darkRow = row;
      const toggle = b.frame(row, {name: 'Toggle', layout: 'row', w: 44, h: 26, pad: 2, radius: 13, main: 'start', cross: 'center', fill: c.surface, stroke: c.border, strokeWeight: 1, strokeAlign: 'INSIDE'});
      b.ellipse(toggle, {name: 'Knob', w: 22, h: 22, fill: '#FFFFFF', effects: [{type: 'DROP_SHADOW', color: {r: 0, g: 0, b: 0, a: 0.16}, offset: {x: 0, y: 1}, radius: 3, spread: 0, visible: true, blendMode: 'NORMAL'}]});
    } else {
      if (value) b.text(row, value, t.small, {color: c.text2});
      b.instance(row, icon, {name: 'Arrow', w: 16, h: 16}, {'Type': 'Next'});
    }
  });
  const navOnProfile = b.instance(profile, nav, {w: 'fill'});
  b.props(`${navOnProfile};${items[0]}`, {'State': 'Default', 'Label': 'Home', 'Icon': iconVariant('Home')});
  b.props(`${navOnProfile};${items[3]}`, {'State': 'Active', 'Label': 'Profile', 'Icon': iconVariant('Profile')});

  const feedDark = feed('Feed — dark theme');
  b.setMode(feedDark.frame, theme.id, theme.modes[1]);

  // ── Prototype ──
  const dissolve: Transition = {type: 'DISSOLVE', duration: 0.3, easing: 'EASE_OUT'};
  const go = (destinationId: NodeId, transition: Transition = {type: 'INSTANT'}): Reaction =>
    ({trigger: {type: 'ON_CLICK'}, actions: [{type: 'NODE', navigation: 'NAVIGATE', destinationId, transition}]});
  // A tab of a tab bar instance is the copy of the nav component's tab item.
  const tabIn = (bar: NodeId, label: 'Home' | 'Profile') => `${bar};${items[label === 'Home' ? 0 : 3]}`;
  b.device(screens, 'iphone-16');
  b.flow(screens, signIn, 'App sign-in');
  b.react(enter, go(feedLight.frame, dissolve));
  for (const shown of [feedLight, feedDark]) {
    b.react(tabIn(shown.bar, 'Profile'), go(profile));
    b.react(shown.me, go(profile));
  }
  b.react(tabIn(navOnProfile, 'Home'), go(feedLight.frame));
  if (darkRow) b.react(darkRow, go(feedDark.frame, dissolve));

  b.normalize();
  b.arrangeOnPage([signIn, feedLight.frame, profile, feedDark.frame], {gap: 80});
  return b.finish();
}

