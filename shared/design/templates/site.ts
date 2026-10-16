import type {DesignDocument, NodeId, Reaction} from '../types';
import {ICONS, type IconName} from './icons';
import {columns, linear, shadow, TemplateBuilder, type BuildOptions, type ColorToken, type Font} from './kit';

// "Site": a landing page at 1440 px for "Pulse", an online-booking service for studios: header, hero
// with the product, trust strip, features, a closing call to action and the footer. Every block is auto
// layout on a 12-column grid (120 px margins, 24 px gutters); colours and type are local styles. ▶ shows the page
// on a desktop screen: the menu and the buttons scroll smoothly to their sections.

const WIDTH = 1440;
const MARGIN = 120;
const FAMILY = 'Manrope';

export function buildSite(options: BuildOptions): DesignDocument {
  const b = new TemplateBuilder(options);
  const page = b.page('Site', '#E9EBEF');

  const c = {
    ink: b.colorStyle('Neutral/Ink', '#0B0D12', 'Headings and body text'),
    text2: b.colorStyle('Neutral/Graphite', '#5B6170', 'Secondary text'),
    muted: b.colorStyle('Neutral/Ash', '#9AA0AE'),
    line: b.colorStyle('Neutral/Line', '#E6E8EC'),
    surface: b.colorStyle('Neutral/Background', '#F5F6F8'),
    white: b.colorStyle('Neutral/White', '#FFFFFF'),
    accent: b.colorStyle('Brand/Blue', '#3354FF', 'Buttons and links'),
    accentSoft: b.colorStyle('Brand/Blue 50', '#EEF1FF'),
    mint: b.colorStyle('Brand/Mint', '#13B98A'),
    coral: b.colorStyle('Brand/Coral', '#FF6B4A'),
    sun: b.colorStyle('Brand/Sun', '#FFB020'),
  };
  const t = {
    display: b.textStyle('Headings/Display', {family: FAMILY, weight: 800, size: 72, line: 80, tracking: -3}),
    h2: b.textStyle('Headings/H2', {family: FAMILY, weight: 800, size: 48, line: 56, tracking: -2.5}),
    h3: b.textStyle('Headings/H3', {family: FAMILY, weight: 700, size: 22, line: 32, tracking: -1}),
    lead: b.textStyle('Text/Lead', {family: FAMILY, weight: 500, size: 20, line: 32, tracking: -0.5}),
    body: b.textStyle('Text/Primary', {family: FAMILY, weight: 500, size: 16, line: 24}),
    small: b.textStyle('Text/Small', {family: FAMILY, weight: 500, size: 14, line: 20}),
    overline: b.textStyle('Text/Overline', {family: FAMILY, weight: 700, size: 13, line: 16, tracking: 8, case: 'UPPER'}),
    button: b.textStyle('Buttons/Large', {family: FAMILY, weight: 700, size: 16, line: 24}),
  };
  const grid = columns(12, 24, MARGIN);
  b.gridStyle('Grid/Desktop 12', [grid], '12 columns, margin 120, gutter 24');
  const cardShadow = b.effectStyle('Shadows/Window', [shadow(2, 6, 0.04), shadow(24, 64, 0.12)]);

  const site = b.frame(page, {name: 'Home — 1440', w: WIDTH, h: 'hug', layout: 'col', fill: c.white, clip: true, grids: [grid]});

  const button = (parent: NodeId, label: string, kind: 'primary' | 'secondary' | 'ghost' | 'inverse', size: 'l' | 'm' = 'l') => {
    const fill: ColorToken | null = kind === 'primary' ? c.accent : kind === 'inverse' ? c.white : kind === 'secondary' ? c.white : null;
    const frame = b.frame(parent, {
      name: `Button — ${label}`, layout: 'row', gap: 8, main: 'center', cross: 'center', pad: size === 'l' ? [16, 28] : [10, 18], radius: size === 'l' ? 14 : 10,
      fill, stroke: kind === 'secondary' ? c.line : null, strokeWeight: 1, strokeAlign: 'INSIDE',
    });
    b.text(frame, label, size === 'l' ? t.button : {...t.small, weight: 700}, {color: kind === 'primary' ? c.white : c.ink});
    return frame;
  };
  const glyph = (parent: NodeId, name: IconName, size: number, color: ColorToken) =>
    b.vector(parent, ICONS[name], {name: 'Icon', w: size, h: size, viewBox: 24, stroke: color, strokeWeight: 2, strokeCap: 'ROUND', strokeJoin: 'ROUND'});
  const logo = (parent: NodeId, inverse = false) => {
    const row = b.frame(parent, {name: 'Logo', layout: 'row', gap: 10, cross: 'center'});
    const mark = b.frame(row, {name: 'Mark', layout: 'row', w: 32, h: 32, radius: 9, main: 'center', cross: 'center', fill: c.accent});
    b.vector(mark, 'M3 12h4l2.5-6 5 12 2.5-6h4', {name: 'Pulse', w: 20, h: 20, viewBox: 24, stroke: '#FFFFFF', strokeWeight: 2.5, strokeCap: 'ROUND', strokeJoin: 'ROUND'});
    b.text(row, 'Pulse', {family: FAMILY, weight: 800, size: 22, line: 28, tracking: -3}, {color: inverse ? c.white : c.ink});
    return row;
  };

  // Header
  const header = b.frame(site, {name: 'Header', layout: 'row', w: 'fill', pad: [24, MARGIN], gap: 'auto', cross: 'center'});
  logo(header);
  const menu = b.frame(header, {name: 'Menu', layout: 'row', gap: 40, cross: 'center'});
  const menuItems = new Map(['Features', 'Pricing', 'Customers', 'Blog'].map(item => [item, b.text(menu, item, {...t.body, weight: 600}, {color: c.text2})]));
  const headerActions = b.frame(header, {name: 'Actions', layout: 'row', gap: 8, cross: 'center'});
  button(headerActions, 'Sign in', 'ghost', 'm');
  const tryFree = button(headerActions, 'Try for free', 'primary', 'm');

  // Hero
  const hero = b.frame(site, {name: 'Hero', layout: 'col', w: 'fill', pad: [80, MARGIN, 0, MARGIN], gap: 64, cross: 'center'});
  const heroText = b.frame(hero, {name: 'Text', layout: 'col', w: 896, gap: 24, cross: 'center'});
  const badge = b.frame(heroText, {name: 'Announcement', layout: 'row', gap: 8, pad: [6, 8, 6, 6], radius: 20, cross: 'center', fill: c.accentSoft});
  const badgeTag = b.frame(badge, {name: 'Tag', layout: 'row', pad: [2, 8], radius: 12, fill: c.accent});
  b.text(badgeTag, 'New', {...t.small, weight: 700, size: 12, line: 16}, {color: c.white});
  b.text(badge, 'Client reminders in Telegram', {...t.small, weight: 600}, {color: c.accent});
  b.text(heroText, 'Online booking that works for you', t.display, {color: c.ink, w: 'fill', align: 'CENTER'});
  b.text(heroText, 'Clients book on their own at any time, get reminders and arrive on time. Staff workload and revenue in one window.', t.lead, {color: c.text2, w: 680, align: 'CENTER'});
  const heroButtons = b.frame(heroText, {name: 'Buttons', layout: 'row', gap: 12, pad: [16, 0, 0, 0]});
  const start = button(heroButtons, 'Start for free', 'primary');
  button(heroButtons, 'Watch demo', 'secondary');
  b.text(heroText, '14 days free  ·  No credit card  ·  Set up in 10 minutes', t.small, {color: c.muted, align: 'CENTER'});

  // Product picture: the booking calendar in a window.
  const stage = b.frame(hero, {name: 'Product', layout: 'col', w: 1200, h: 560, pad: [40, 48, 0, 48], radius: [28, 28, 0, 0], fill: linear([['#E7ECFF'], ['#F5F7FF']], 90), clip: true});
  const app = b.frame(stage, {name: 'App window', layout: 'row', w: 'fill', h: 'fill', radius: [16, 16, 0, 0], fill: c.white, effectStyle: cardShadow, effects: [shadow(2, 6, 0.04), shadow(24, 64, 0.12)], clip: true});
  const side = b.frame(app, {name: 'Menu', layout: 'col', w: 232, h: 'fill', pad: [24, 16], gap: 4, fill: c.surface});
  const sideHead = b.frame(side, {name: 'Studio', layout: 'row', gap: 10, cross: 'center', pad: [0, 8, 16, 8]});
  b.ellipse(sideHead, {name: 'Avatar', w: 28, h: 28, fill: linear([['#FF8A65'], ['#FF5470']], 45)});
  b.text(sideHead, 'Mint Studio', {...t.small, weight: 700}, {color: c.ink});
  ([['calendar', 'Schedule', true], ['user', 'Clients', false], ['star', 'Staff', false], ['chart', 'Analytics', false], ['bell', 'Reminders', false]] as const).forEach(([icon, label, active]) => {
    const item = b.frame(side, {name: label, layout: 'row', w: 'fill', gap: 10, pad: [8, 10], radius: 8, cross: 'center', fill: active ? c.white : null, effects: active ? [shadow(1, 2, 0.06)] : []});
    glyph(item, icon, 18, active ? c.accent : c.text2);
    b.text(item, label, {...t.small, weight: active ? 700 : 600}, {color: active ? c.ink : c.text2});
  });
  const board = b.frame(app, {name: 'Schedule', layout: 'col', w: 'fill', h: 'fill', pad: [24, 28], gap: 20});
  const boardHead = b.frame(board, {name: 'Heading', layout: 'row', w: 'fill', gap: 'auto', cross: 'center'});
  const boardTitle = b.frame(boardHead, {name: 'Date', layout: 'col', gap: 2});
  b.text(boardTitle, 'Today, October 14', {...t.h3, size: 20, line: 28}, {color: c.ink});
  b.text(boardTitle, '18 bookings · 86% booked', t.small, {color: c.text2});
  button(boardHead, '+ New booking', 'primary', 'm');
  const lanes = b.frame(board, {name: 'Staff', layout: 'row', w: 'fill', h: 'fill', gap: 16});
  const appointments: [string, [string, string, string][]][] = [
    ['Alina · hair', [['10:00', 'Emma K.', 'Cut and style'], ['12:30', 'Nina P.', 'Coloring'], ['16:00', 'Maria L.', 'Haircut'], ['18:30', 'Vera D.', 'Styling']]],
    ['Karina · nails', [['09:30', 'Sophia R.', 'Gel manicure'], ['11:30', 'Daisy M.', 'Pedicure'], ['14:00', 'Ellen V.', 'Manicure'], ['17:00', 'Anna S.', 'Removal and gel']]],
    ['Dennis · barber', [['10:30', 'Arthur N.', 'Haircut and beard'], ['13:00', 'Paul S.', 'Hot towel shave'], ['15:30', 'Ian T.', 'Haircut'], ['19:00', 'Max E.', 'Gray camouflage']]],
  ];
  const tones: [ColorToken, string][] = [[c.accent, '#EEF1FF'], [c.coral, '#FFF0EC'], [c.mint, '#E8F8F2']];
  appointments.forEach(([master, list], i) => {
    const lane = b.frame(lanes, {name: master, layout: 'col', w: 'fill', h: 'fill', gap: 12});
    b.text(lane, master, {...t.small, weight: 700}, {color: c.text2});
    for (const [time, who, what] of list) {
      const slot = b.frame(lane, {name: `${time} ${who}`, layout: 'col', w: 'fill', gap: 2, pad: [12, 14, 12, 16], radius: 10, fill: tones[i][1], stroke: tones[i][0], strokeWeight: 3, strokeAlign: 'INSIDE'});
      b.update(slot, {individualStrokeWeights: {top: 0, right: 0, bottom: 0, left: 3}});
      b.text(slot, `${time} · ${who}`, {...t.small, weight: 700}, {color: c.ink});
      b.text(slot, what, {...t.small, size: 13, line: 16}, {color: c.text2});
    }
  });

  // Trust strip
  const trust = b.frame(site, {name: 'Customers', layout: 'col', w: 'fill', pad: [56, MARGIN], gap: 24, cross: 'center', stroke: c.line, strokeWeight: 1, strokeAlign: 'INSIDE'});
  b.update(trust, {individualStrokeWeights: {top: 1, right: 0, bottom: 1, left: 0}});
  b.text(trust, 'Trusted by more than 3,000 studios in 140 cities', t.small, {color: c.text2});
  const brands = b.frame(trust, {name: 'Logos', layout: 'row', w: 'fill', gap: 'auto', cross: 'center'});
  const brandFonts: Font[] = [
    {family: FAMILY, weight: 800, size: 24, line: 32, tracking: -4},
    {family: FAMILY, weight: 300, size: 24, line: 32, tracking: 12, case: 'UPPER'},
    {family: FAMILY, weight: 700, size: 22, line: 32, tracking: -2, italic: false},
    {family: FAMILY, weight: 600, size: 24, line: 32, tracking: 2},
    {family: FAMILY, weight: 800, size: 22, line: 32, tracking: 4, case: 'UPPER'},
  ];
  ['Mint', 'Loft', 'Barbershop No. 1', 'Nail & Co', 'Studio 12'].forEach((name, i) => b.text(brands, name, brandFonts[i], {color: c.muted}));

  // Features
  const features = b.frame(site, {name: 'Features', layout: 'col', w: 'fill', pad: [120, MARGIN], gap: 56});
  const featuresHead = b.frame(features, {name: 'Heading', layout: 'col', gap: 16, w: 'fill'});
  b.text(featuresHead, 'Features', t.overline, {color: c.accent});
  b.text(featuresHead, 'Everything you need for booking, in one place', t.h2, {color: c.ink, w: 690});
  const cards: [IconName, string, string][] = [
    ['calendar', 'Booking 24/7', 'A booking link for your website, Instagram and Telegram. Clients choose the staff member, service and time themselves.'],
    ['bell', 'Reminders', 'A message a day and two hours before the visit. No-shows drop threefold.'],
    ['chart', 'Analytics', 'Revenue, average ticket and the workload of each staff member by day, with no spreadsheets or manual reports.'],
    ['user', 'Client base', 'Visit history, notes and birthdays. Bring back the clients who have not visited in a while.'],
    ['bolt', 'Online payments', 'Prepayment at booking by card or Apple Pay. The money reaches your account the next day.'],
    ['shield', 'Your data is protected', 'Servers in the EU, daily backups, individual access for every employee.'],
  ];
  const featureGrid = b.frame(features, {name: 'Cards', layout: 'col', w: 'fill', gap: 24});
  const featureRows: NodeId[] = [];
  for (let row = 0; row < 2; row++) {
    const line = b.frame(featureGrid, {name: `Row ${row + 1}`, layout: 'row', w: 'fill', gap: 24});
    featureRows.push(line);
    for (const [icon, title, text] of cards.slice(row * 3, row * 3 + 3)) {
      const card = b.frame(line, {name: title, layout: 'col', w: 'fill', pad: 32, gap: 20, radius: 24, fill: c.surface});
      const tile = b.frame(card, {name: 'Icon', layout: 'row', w: 48, h: 48, radius: 14, main: 'center', cross: 'center', fill: c.white, effects: [shadow(1, 3, 0.06)]});
      glyph(tile, icon, 24, c.accent);
      const copy = b.frame(card, {name: 'Text', layout: 'col', w: 'fill', gap: 8});
      b.text(copy, title, t.h3, {color: c.ink});
      b.text(copy, text, t.body, {color: c.text2, w: 'fill'});
    }
  }

  // Call to action
  const ctaWrap = b.frame(site, {name: 'Call to action', layout: 'col', w: 'fill', pad: [0, MARGIN, 120, MARGIN]});
  const cta = b.frame(ctaWrap, {name: 'Block', layout: 'row', w: 'fill', pad: [72, 80], gap: 'auto', cross: 'center', radius: 32, fill: linear([['#141831'], ['#0B0D12']], 0), clip: true});
  const ctaText = b.frame(cta, {name: 'Text', layout: 'col', gap: 16});
  b.text(ctaText, 'Try it free for 14 days', t.h2, {color: c.white});
  b.text(ctaText, 'We will move your clients from a notebook or spreadsheet and help you set everything up.', t.lead, {color: '#A3A9B8', w: 560});
  button(cta, 'Start for free', 'inverse');

  // Footer
  const footer = b.frame(site, {name: 'Footer', layout: 'row', w: 'fill', pad: [56, MARGIN, 64, MARGIN], gap: 'auto', stroke: c.line, strokeWeight: 1, strokeAlign: 'INSIDE'});
  b.update(footer, {individualStrokeWeights: {top: 1, right: 0, bottom: 0, left: 0}});
  const brand = b.frame(footer, {name: 'About', layout: 'col', gap: 16});
  logo(brand);
  b.text(brand, 'Online booking for salons,\nbarbershops and studios.', t.small, {color: c.text2});
  b.text(brand, '© 2026 Pulse', t.small, {color: c.muted});
  const links = b.frame(footer, {name: 'Links', layout: 'row', gap: 96});
  const groups: [string, string[]][] = [['Product', ['Features', 'Pricing', 'Integrations']], ['Company', ['About us', 'Blog', 'Careers']], ['Help', ['Support', 'Knowledge base', 'Status']]];
  for (const [title, items] of groups) {
    const column = b.frame(links, {name: title, layout: 'col', gap: 12});
    b.text(column, title, {...t.small, weight: 700}, {color: c.ink});
    for (const item of items) b.text(column, item, t.small, {color: c.text2});
  }

  // ── Prototype: smooth scrolling to the sections ──
  const scrollTo = (destinationId: NodeId): Reaction =>
    ({trigger: {type: 'ON_CLICK'}, actions: [{type: 'NODE', navigation: 'SCROLL_TO', destinationId, transition: {type: 'SMART_ANIMATE', duration: 0.6, easing: 'EASE_IN_AND_OUT'}}]});
  b.device(page, 'desktop');
  b.flow(page, site, 'Landing page');
  b.react(menuItems.get('Features')!, scrollTo(features));
  b.react(menuItems.get('Customers')!, scrollTo(trust));
  for (const id of [tryFree, start]) b.react(id, scrollTo(ctaWrap));

  // Cards of a row share the tallest one's height: the row takes that height, its cards fill it.
  b.normalize();
  for (const line of featureRows) {
    b.update(line, {layoutSizingVertical: 'FIXED'});
    for (const card of b.node(line).children!) b.update(card, {layoutSizingVertical: 'FILL'});
  }
  return b.finish();
}
