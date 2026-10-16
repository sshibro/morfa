import type {DesignDocument, NodeId} from '../types';
import {docBoard} from './board';
import {ICONS} from './icons';
import {linear, paintOf, shadow, TemplateBuilder, type BuildOptions, type ColorToken, type Font} from './kit';

// "UI kit": a small design system in Inter. "Components" documents buttons, input fields, checkboxes,
// toggles, tags, avatars and a card, each a set of variants with component properties; "Styles" shows
// the colour, text and shadow styles they are built from.

const FAMILY = 'Inter';

export function buildUiKit(options: BuildOptions): DesignDocument {
  const b = new TemplateBuilder(options);
  const componentsPage = b.page('Components', '#ECEEF1');
  const stylesPage = b.page('Styles', '#ECEEF1');

  // ── Styles ──
  const neutrals: [string, string, string][] = [
    ['900', '#12141A', 'Headings, body text'], ['700', '#3A3F4B', 'Text on light'], ['500', '#6B7180', 'Captions, placeholders'],
    ['300', '#C4C8D0', 'Inactive elements'], ['200', '#E2E5EA', 'Borders, dividers'], ['100', '#F1F3F6', 'Field and badge backgrounds'], ['0', '#FFFFFF', 'Surfaces'],
  ];
  const n: Record<string, ColorToken> = {};
  for (const [step, value, note] of neutrals) n[step] = b.colorStyle(`Neutral/${step}`, value, note);
  const brand = {
    50: b.colorStyle('Brand/50', '#EDF1FF', 'Background of selected items'),
    100: b.colorStyle('Brand/100', '#D6DEFF'),
    500: b.colorStyle('Brand/500', '#3D63F5', 'Main color: buttons, links, focus'),
    600: b.colorStyle('Brand/600', '#2C4FD8', 'Hover'),
  };
  const status = {
    success: b.colorStyle('Status/Success', '#12A150'), successBg: b.colorStyle('Status/Success background', '#E7F7EE'),
    warning: b.colorStyle('Status/Warning', '#C77700'), warningBg: b.colorStyle('Status/Warning background', '#FFF4DE'),
    danger: b.colorStyle('Status/Error', '#E5484D'), dangerBg: b.colorStyle('Status/Error background', '#FDECEC'),
  };
  const t = {
    display: b.textStyle('Display', {family: FAMILY, weight: 700, size: 48, line: 56, tracking: -2.5}),
    h1: b.textStyle('Headings/H1', {family: FAMILY, weight: 700, size: 32, line: 40, tracking: -2}),
    h2: b.textStyle('Headings/H2', {family: FAMILY, weight: 600, size: 24, line: 32, tracking: -1.5}),
    h3: b.textStyle('Headings/H3', {family: FAMILY, weight: 600, size: 18, line: 28, tracking: -1}),
    body: b.textStyle('Text/Primary', {family: FAMILY, weight: 400, size: 16, line: 24, tracking: -0.5}),
    small: b.textStyle('Text/Small', {family: FAMILY, weight: 400, size: 14, line: 20}),
    label: b.textStyle('Text/Label', {family: FAMILY, weight: 500, size: 14, line: 20}),
    caption: b.textStyle('Text/Caption', {family: FAMILY, weight: 500, size: 12, line: 16}),
    button: b.textStyle('Buttons/Text', {family: FAMILY, weight: 600, size: 14, line: 20}),
  };
  const shadows = {
    s: b.effectStyle('Shadows/Small', [shadow(1, 2, 0.06), shadow(1, 3, 0.08)], 'Buttons, fields, small cards'),
    m: b.effectStyle('Shadows/Medium', [shadow(2, 4, 0.04), shadow(8, 16, 0.08)], 'Cards, dropdown menus'),
    l: b.effectStyle('Shadows/Large', [shadow(4, 8, 0.04), shadow(20, 48, 0.14)], 'Dialogs and popovers'),
  };
  const effectsOf = (id: string) => b.doc.styles[id].effects!;

  const icon = (parent: NodeId, name: keyof typeof ICONS, size: number, color: ColorToken, box: {name?: string; visible?: boolean} = {}) =>
    b.vector(parent, ICONS[name], {name: box.name ?? 'Icon', w: size, h: size, viewBox: 24, stroke: color, strokeWeight: 2, strokeCap: 'ROUND', strokeJoin: 'ROUND', visible: box.visible});

  // ── Components ──
  const board = docBoard(b, componentsPage, {
    title: 'UI kit',
    lead: 'Components with variants and properties. Change the type and state in the instance\'s right panel, and the texts in the properties.',
    width: 1440,
  });

  // Buttons: Type × State, with a text and an optional icon.
  const buttonRow = board.section('Button', 'Primary is for the main action, secondary and outline for the rest, text for actions inside text.', {gap: 16});
  const kinds = ['Primary', 'Secondary', 'Outline', 'Text'] as const;
  const states = ['Default', 'Hover', 'Disabled'] as const;
  const buttons: NodeId[] = [];
  for (const kind of kinds) {
    for (const state of states) {
      const off = state === 'Disabled', hover = state === 'Hover';
      const fill: ColorToken | null = off ? (kind === 'Text' ? null : n['100'])
        : kind === 'Primary' ? (hover ? brand[600] : brand[500])
        : kind === 'Secondary' ? (hover ? brand[100] : brand[50])
        : kind === 'Outline' ? (hover ? n['100'] : n['0'])
        : hover ? brand[50] : null;
      const color = off ? n['300'] : kind === 'Primary' ? n['0'] : kind === 'Outline' ? n['900'] : brand[500];
      const frame = b.frame(buttonRow, {
        name: `Button/Type=${kind}, State=${state}`, layout: 'row', pad: [10, 16], gap: 8, main: 'center', cross: 'center', radius: 10, fill,
        stroke: kind === 'Outline' && !off ? n['200'] : null, strokeWeight: 1, strokeAlign: 'INSIDE',
        effects: kind === 'Primary' && !off ? effectsOf(shadows.s) : [], effectStyle: kind === 'Primary' && !off ? shadows.s : undefined,
      });
      icon(frame, 'plus', 16, color, {name: 'Icon'});
      b.text(frame, 'Button', t.button, {name: 'Text', color});
      buttons.push(b.component(frame));
    }
  }
  b.normalize();
  const button = b.variants(buttons, 'Height 40. Turn the icon on with the "Icon" property.');
  const buttonText = b.property(button, 'Text', 'TEXT', 'Button');
  const buttonIcon = b.property(button, 'Icon', 'BOOLEAN', true);
  for (const variant of b.node(button).children!) {
    b.bind(b.named(variant, 'Text'), 'characters', buttonText);
    b.bind(b.named(variant, 'Icon'), 'visible', buttonIcon);
  }

  // Input fields
  const inputRow = board.section('Input field', 'Label above the field, a hint or an error below it. Field height 40.', {gap: 24});
  const inputs = (['Default', 'Focus', 'Error', 'Disabled'] as const).map(state => {
    const error = state === 'Error', off = state === 'Disabled', focus = state === 'Focus';
    const frame = b.frame(inputRow, {name: `Input field/State=${state}`, layout: 'col', w: 280, gap: 6});
    b.text(frame, 'Email', t.label, {name: 'Label', color: off ? n['500'] : n['900']});
    const field = b.frame(frame, {
      name: 'Field', layout: 'row', w: 'fill', pad: [10, 12], gap: 8, cross: 'center', radius: 10,
      fill: off ? n['100'] : n['0'], stroke: error ? status.danger : focus ? brand[500] : n['200'], strokeWeight: focus || error ? 1.5 : 1, strokeAlign: 'INSIDE',
      effects: focus ? [{...shadow(0, 0, 1, 3, '#D6DEFF')}] : error ? [{...shadow(0, 0, 1, 3, '#FDECEC')}] : [],
    });
    icon(field, 'mail', 16, n['500']);
    b.text(field, state === 'Default' || off ? 'name@company.example' : 'anna@studio', t.small, {name: 'Value', color: state === 'Default' || off ? n['500'] : n['900'], w: 'fill'});
    b.text(frame, error ? 'The address has no domain, for example @mail.com' : 'We will email you a sign-in link', t.caption, {name: 'Hint', color: error ? status.danger : n['500'], w: 'fill'});
    return b.component(frame);
  });
  b.normalize();
  const input = b.variants(inputs);
  const inputKeys = {
    label: b.property(input, 'Label', 'TEXT', 'Email'),
    hint: b.property(input, 'Hint', 'TEXT', 'We will email you a sign-in link'),
    showHint: b.property(input, 'Show hint', 'BOOLEAN', true),
  };
  for (const variant of b.node(input).children!) {
    b.bind(b.named(variant, 'Label'), 'characters', inputKeys.label);
    if (!b.node(variant).name.includes('Error')) b.bind(b.named(variant, 'Hint'), 'characters', inputKeys.hint);
    b.bind(b.named(variant, 'Hint'), 'visible', inputKeys.showHint);
  }

  // Checkboxes and toggles
  const choiceRow = board.section('Checkbox and toggle', 'A checkbox is for picking from a list, a toggle is for a setting that takes effect immediately.', {gap: 40});
  const checks = (['No', 'Yes', 'Mixed'] as const).map(state => {
    const frame = b.frame(choiceRow, {name: `Checkbox/Checked=${state}`, layout: 'row', gap: 10, cross: 'center'});
    const on = state !== 'No';
    const box = b.frame(frame, {name: 'Box', layout: 'row', w: 20, h: 20, radius: 6, main: 'center', cross: 'center', fill: on ? brand[500] : n['0'], stroke: on ? null : n['300'], strokeWeight: 1.5, strokeAlign: 'INSIDE'});
    if (state === 'Yes') icon(box, 'check', 14, n['0'], {name: 'Check'});
    if (state === 'Mixed') b.rect(box, {name: 'Dash', w: 10, h: 2, radius: 1, fill: n['0']});
    b.text(frame, 'Remember me', t.small, {name: 'Label', color: n['900']});
    return b.component(frame);
  });
  b.normalize();
  const checkbox = b.variants(checks);
  const checkLabel = b.property(checkbox, 'Label', 'TEXT', 'Remember me');
  for (const variant of b.node(checkbox).children!) b.bind(b.named(variant, 'Label'), 'characters', checkLabel);

  const toggles = (['No', 'Yes'] as const).map(state => {
    const on = state === 'Yes';
    const frame = b.frame(choiceRow, {name: `Toggle/On=${state}`, layout: 'row', gap: 10, cross: 'center'});
    const track = b.frame(frame, {name: 'Track', layout: 'row', w: 36, h: 20, pad: 2, radius: 10, main: on ? 'end' : 'start', cross: 'center', fill: on ? brand[500] : n['300']});
    b.ellipse(track, {name: 'Knob', w: 16, h: 16, fill: n['0'], effects: [shadow(1, 2, 0.2)]});
    b.text(frame, 'Notifications', t.small, {name: 'Label', color: n['900']});
    return b.component(frame);
  });
  b.normalize();
  const toggle = b.variants(toggles);
  const toggleLabel = b.property(toggle, 'Label', 'TEXT', 'Notifications');
  for (const variant of b.node(toggle).children!) b.bind(b.named(variant, 'Label'), 'characters', toggleLabel);

  // Tags
  const tagRow = board.section('Tag', 'Statuses and categories. The color means the status: green is done, yellow is in progress, red is a problem.', {gap: 12});
  const tagTones: [string, ColorToken, ColorToken][] = [
    ['Gray', n['100'], n['700']], ['Blue', brand[50], brand[500]], ['Green', status.successBg, status.success],
    ['Yellow', status.warningBg, status.warning], ['Red', status.dangerBg, status.danger],
  ];
  const tags = tagTones.map(([name, fill, color]) => {
    const frame = b.frame(tagRow, {name: `Tag/Color=${name}`, layout: 'row', pad: [2, 8], gap: 6, radius: 6, cross: 'center', fill});
    b.ellipse(frame, {name: 'Dot', w: 6, h: 6, fill: color});
    b.text(frame, 'Tag', t.caption, {name: 'Text', color});
    return b.component(frame);
  });
  b.normalize();
  const tag = b.variants(tags);
  const tagText = b.property(tag, 'Text', 'TEXT', 'Tag');
  for (const variant of b.node(tag).children!) b.bind(b.named(variant, 'Text'), 'characters', tagText);

  // Avatars
  const avatarRow = board.section('Avatar', 'Initials on a gradient until there is a photo. Four sizes.', {gap: 16});
  const avatars = ([24, 32, 40, 56] as const).map(size => {
    const frame = b.frame(avatarRow, {name: `Avatar/Size=${size}`, layout: 'row', w: size, h: size, radius: size / 2, main: 'center', cross: 'center', fill: linear([['#7C93FF'], ['#3D63F5']], 45), clip: true});
    const font: Font = {family: FAMILY, weight: 600, size: Math.round(size * 0.4), line: Math.round(size * 0.5)};
    b.text(frame, 'AS', font, {name: 'Initials', color: n['0']});
    return b.component(frame);
  });
  b.normalize();
  const avatar = b.variants(avatars);
  const initials = b.property(avatar, 'Initials', 'TEXT', 'AS');
  for (const variant of b.node(avatar).children!) b.bind(b.named(variant, 'Initials'), 'characters', initials);

  // Card
  const cardRow = board.section('Card', 'Built from other components: the avatar, tag and buttons are nested instances.', {gap: 24});
  const card = b.frame(cardRow, {name: 'Card', layout: 'col', w: 360, pad: 24, gap: 20, radius: 16, fill: n['0'], stroke: n['200'], strokeWeight: 1, strokeAlign: 'INSIDE', effects: effectsOf(shadows.m), effectStyle: shadows.m});
  const cardHead = b.frame(card, {name: 'Header', layout: 'row', w: 'fill', gap: 'auto', cross: 'center'});
  const person = b.frame(cardHead, {name: 'Author', layout: 'row', gap: 12, cross: 'center'});
  const personText = b.frame(person, {name: 'Name', layout: 'col', gap: 0});
  const cardBody = b.frame(card, {name: 'Text', layout: 'col', w: 'fill', gap: 6});
  b.text(cardBody, 'Account area redesign', t.h3, {name: 'Heading', color: n['900'], w: 'fill'});
  b.text(cardBody, 'New checkout and order history screens are ready. Edits needed by Friday.', t.small, {name: 'Description', color: n['500'], w: 'fill'});
  const cardActions = b.frame(card, {name: 'Actions', layout: 'row', w: 'fill', gap: 8});
  b.normalize();
  b.instance(person, avatar, {}, {'Size': '40', 'Initials': 'ML'});
  b.update(person, {children: [b.node(person).children!.slice(-1)[0], ...b.node(person).children!.slice(0, -1)]});
  b.text(personText, 'Maria Lopez', t.label, {color: n['900']});
  b.text(personText, 'Art director', t.caption, {color: n['500']});
  b.instance(cardHead, tag, {}, {'Color': 'Yellow', 'Text': 'In review'});
  b.instance(cardActions, button, {w: 'fill'}, {'Text': 'Open', 'Icon': false});
  b.instance(cardActions, button, {w: 'fill'}, {'Type': 'Outline', 'Text': 'Later', 'Icon': false});
  b.component(card, 'Task card.');
  const cardKeys = {title: b.property(card, 'Heading', 'TEXT', 'Account area redesign'), text: b.property(card, 'Description', 'TEXT', 'New checkout and order history screens are ready. Edits needed by Friday.')};
  b.bind(b.named(card, 'Heading'), 'characters', cardKeys.title);
  b.bind(b.named(card, 'Description'), 'characters', cardKeys.text);

  // An example of the kit in use: a sign-in form built only from instances.
  const formCard = b.frame(cardRow, {name: 'Example: sign in', layout: 'col', w: 360, pad: 24, gap: 20, radius: 16, fill: n['0'], stroke: n['200'], strokeWeight: 1, strokeAlign: 'INSIDE', effects: effectsOf(shadows.m), effectStyle: shadows.m});
  const formHead = b.frame(formCard, {name: 'Heading', layout: 'col', gap: 4, w: 'fill'});
  b.text(formHead, 'Sign in to your account', t.h2, {color: n['900']});
  b.text(formHead, 'We will send a sign-in link to your email.', t.small, {color: n['500']});
  b.normalize();
  const email = b.instance(formCard, input, {w: 'fill'}, {'State': 'Focus', 'Show hint': false});
  b.overrideText(b.named(email, 'Value'), 'anna@studio.example');
  b.instance(formCard, checkbox, {}, {'Checked': 'Yes'});
  b.instance(formCard, button, {w: 'fill'}, {'Text': 'Get link', 'Icon': false});

  // ── Styles page ──
  const styles = docBoard(b, stylesPage, {title: 'Styles', lead: 'Colors, text and shadows of the file. Change a style and every layer that uses it changes.', width: 1440});
  const swatchGroup = (title: string, note: string, entries: [string, ColorToken][]) => {
    const row = styles.section(title, note, {gap: 16});
    for (const [name, token] of entries) {
      const swatch = b.frame(row, {name, layout: 'col', w: 152, gap: 10});
      b.rect(swatch, {name: 'Swatch', w: 'fill', h: 96, radius: 12, fill: token, stroke: n['200'], strokeWeight: token.hex === '#FFFFFF' ? 1 : 0, strokeAlign: 'INSIDE'});
      const meta = b.frame(swatch, {name: 'Label', layout: 'col', gap: 2, w: 'fill'});
      b.text(meta, name, t.label, {color: n['900']});
      b.text(meta, token.hex.toUpperCase(), t.caption, {color: n['500']});
    }
  };
  swatchGroup('Neutral', 'Text, backgrounds, borders.', neutrals.map(([step]) => [step, n[step]]));
  swatchGroup('Brand', 'Main actions, links, focus.', [['50', brand[50]], ['100', brand[100]], ['500', brand[500]], ['600', brand[600]]]);
  swatchGroup('Status', 'Success, warning and error — text and background.', [
    ['Success', status.success], ['Success background', status.successBg], ['Warning', status.warning], ['Warning background', status.warningBg], ['Error', status.danger], ['Error background', status.dangerBg],
  ]);

  const typeRow = styles.section('Typography', 'Inter. Line heights are multiples of 4, sizes follow a scale from 12 to 48.', {direction: 'col', gap: 0});
  const scale: [string, Font, string][] = [
    ['Display', t.display, '48 / 56 · Bold'], ['Heading H1', t.h1, '32 / 40 · Bold'], ['Heading H2', t.h2, '24 / 32 · Semibold'], ['Heading H3', t.h3, '18 / 28 · Semibold'],
    ['Body text', t.body, '16 / 24 · Regular'], ['Small text', t.small, '14 / 20 · Regular'], ['Label', t.label, '14 / 20 · Medium'], ['Caption', t.caption, '12 / 16 · Medium'],
  ];
  b.update(typeRow, {layoutSizingHorizontal: 'FILL'});
  scale.forEach(([name, font, meta], i) => {
    const row = b.frame(typeRow, {name, layout: 'row', w: 'fill', pad: [16, 0], gap: 32, cross: 'center', stroke: n['200'], strokeWeight: 1, strokeAlign: 'INSIDE'});
    b.update(row, {individualStrokeWeights: {top: 0, right: 0, bottom: i < scale.length - 1 ? 1 : 0, left: 0}});
    const label = b.frame(row, {name: 'Style', layout: 'col', w: 200, gap: 2});
    b.text(label, name, t.label, {color: n['900']});
    b.text(label, meta, t.caption, {color: n['500']});
    b.text(row, font.size >= 40 ? 'The quick brown fox jumps' : 'The quick brown fox jumps over the lazy dog', font, {name: 'Swatch', color: n['900'], w: 'fill'});
  });

  const shadowRow = styles.section('Shadows', 'Three elevation levels: the higher the element, the softer and farther the shadow.', {gap: 40});
  b.update(shadowRow, {fills: [paintOf('#F6F7F9')], autoLayout: {...b.node(shadowRow).autoLayout!, paddingTop: 40, paddingBottom: 40, paddingLeft: 40, paddingRight: 40}, cornerRadius: 16});
  for (const [name, id] of [['Small', shadows.s], ['Medium', shadows.m], ['Large', shadows.l]] as const) {
    const sample = b.frame(shadowRow, {name, layout: 'col', w: 200, h: 120, pad: 16, main: 'end', radius: 12, fill: n['0'], effects: effectsOf(id), effectStyle: id});
    b.text(sample, name, t.label, {color: n['900']});
  }

  b.normalize();
  return b.finish();
}
