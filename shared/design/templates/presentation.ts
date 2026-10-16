import type {DesignDocument, NodeId, Reaction} from '../types';
import {linear, radial, TemplateBuilder, type BuildOptions, type ColorToken} from './kit';

// "Presentation": three 1920 × 1080 slides of a strategy deck — a title slide, three findings and a
// chart — on one type scale of text styles ("Slide/…") in Inter Tight and Inter. ▶ shows it as a deck: a click
// or → goes to the next slide, ← to the previous one.

const W = 1920;
const H = 1080;
const PAD: [number, number] = [96, 120];
const HEAD = 'Inter Tight';
const BODY = 'Inter';

export function buildPresentation(options: BuildOptions): DesignDocument {
  const b = new TemplateBuilder(options);
  const page = b.page('Slides', '#E4E5E9');

  const c = {
    night: b.colorStyle('Slides/Night', '#0E1016', 'Title slide background'),
    paper: b.colorStyle('Slides/Paper', '#F7F7F4', 'Regular slide background'),
    ink: b.colorStyle('Text/Ink', '#121318'),
    text2: b.colorStyle('Text/Graphite', '#5E626E'),
    mutedDark: b.colorStyle('Text/Mist', '#8D92A1', 'Secondary text on dark'),
    white: b.colorStyle('Text/White', '#FFFFFF'),
    accent: b.colorStyle('Accent/Violet', '#5B4CFF'),
    accentSoft: b.colorStyle('Accent/Lavender', '#DCD8FF'),
    rule: b.colorStyle('Lines/Divider', '#121318'),
  };
  const t = {
    title: b.textStyle('Slide/Heading XL', {family: HEAD, weight: 700, size: 120, line: 128, tracking: -4}),
    h1: b.textStyle('Slide/Heading', {family: HEAD, weight: 700, size: 72, line: 80, tracking: -3}),
    h2: b.textStyle('Slide/Subheading', {family: HEAD, weight: 600, size: 40, line: 48, tracking: -2}),
    figure: b.textStyle('Slide/Figure', {family: HEAD, weight: 700, size: 240, line: 240, tracking: -6}),
    lead: b.textStyle('Slide/Lead', {family: BODY, weight: 400, size: 36, line: 52, tracking: -1}),
    body: b.textStyle('Slide/Text', {family: BODY, weight: 400, size: 28, line: 40, tracking: -0.5}),
    label: b.textStyle('Slide/Label', {family: BODY, weight: 600, size: 20, line: 24, tracking: 6, case: 'UPPER'}),
    caption: b.textStyle('Slide/Caption', {family: BODY, weight: 500, size: 20, line: 28}),
  };

  const slide = (name: string, fill: ColorToken) => b.frame(page, {name, w: W, h: H, layout: 'col', pad: PAD, fill, clip: true});
  const footer = (parent: NodeId, number: string, dark = false) => {
    const row = b.frame(parent, {name: 'Footer', layout: 'row', w: 'fill', gap: 'auto', cross: 'center'});
    b.text(row, 'Northwind · Strategy 2027', t.caption, {color: dark ? c.mutedDark : c.text2});
    b.text(row, `${number} / 03`, t.caption, {color: dark ? c.mutedDark : c.text2});
    return row;
  };

  // 1. Title
  const cover = slide('01 — Title', c.night);
  b.update(cover, {autoLayout: {...b.node(cover).autoLayout!, primaryAxisAlignItems: 'SPACE_BETWEEN'}});
  b.ellipse(cover, {name: 'Glow', w: 1400, h: 1400, x: 1000, y: -420, absolute: true, fill: radial([['#5B4CFF', 0.55], ['#5B4CFF', 0]]), constraints: {horizontal: 'MAX', vertical: 'MIN'}});
  b.ellipse(cover, {name: 'Ring', w: 760, h: 760, x: 1380, y: 520, absolute: true, fill: null, stroke: {hex: '#FFFFFF', opacity: 0.12}, strokeWeight: 2, constraints: {horizontal: 'MAX', vertical: 'MAX'}});
  const coverTop = b.frame(cover, {name: 'Top', layout: 'row', w: 'fill', gap: 'auto', cross: 'center'});
  const brand = b.frame(coverTop, {name: 'Logo', layout: 'row', gap: 14, cross: 'center'});
  b.vector(brand, ['M4 18 12 4l8 14', 'M8 18h8'], {name: 'Mark', w: 36, h: 36, viewBox: 24, stroke: c.white, strokeWeight: 2.5, strokeCap: 'ROUND', strokeJoin: 'ROUND'});
  b.text(brand, 'Northwind', {family: HEAD, weight: 700, size: 28, line: 32, tracking: -2}, {color: c.white});
  b.text(coverTop, 'October 2026', t.caption, {color: c.mutedDark});
  const coverMain = b.frame(cover, {name: 'Heading', layout: 'col', w: 'fill', gap: 40});
  const pill = b.frame(coverMain, {name: 'Label', layout: 'row', pad: [12, 20], radius: 28, fill: {hex: '#5B4CFF', opacity: 0.22}, stroke: {hex: '#8E83FF', opacity: 0.5}, strokeWeight: 1.5, strokeAlign: 'INSIDE'});
  b.text(pill, 'Strategy 2027', t.label, {color: '#C9C3FF'});
  b.text(coverMain, 'How we will double revenue in one year', t.title, {color: c.white, w: 1280});
  b.text(coverMain, 'Three decisions we propose to make today', t.lead, {color: '#A6ABB8'});
  footer(cover, '01', true);

  // 2. Findings
  const findings = slide('02 — Findings', c.paper);
  b.update(findings, {autoLayout: {...b.node(findings).autoLayout!, itemSpacing: 80}});
  const head = b.frame(findings, {name: 'Heading', layout: 'col', gap: 20, w: 'fill'});
  b.text(head, '2026 results', t.label, {color: c.accent});
  b.text(head, 'Three findings the plan is built on', t.h1, {color: c.ink, w: 'fill'});
  const cols = b.frame(findings, {name: 'Findings', layout: 'row', w: 'fill', gap: 64});
  const points: [string, string, string][] = [
    ['01', 'Customers stay', 'Retention grew to 71%, the best result in five years. Every second customer buys again within a month.'],
    ['02', 'Regions grow faster', 'Revenue outside New York grew by 64%. Demand there outpaces supply, and competition is lower.'],
    ['03', 'Service pays off', 'Support within 5 minutes lifted NPS from 38 to 61. Customer acquisition cost fell by 22%.'],
  ];
  for (const [n, title, text] of points) {
    const col = b.frame(cols, {name: title, layout: 'col', w: 'fill', gap: 24, pad: [32, 0, 0, 0], stroke: c.rule, strokeWeight: 2, strokeAlign: 'INSIDE'});
    b.update(col, {individualStrokeWeights: {top: 2, right: 0, bottom: 0, left: 0}});
    b.text(col, n, {...t.h2, size: 32, line: 40}, {color: c.accent});
    b.text(col, title, t.h2, {color: c.ink, w: 'fill'});
    b.text(col, text, t.body, {color: c.text2, w: 'fill'});
  }
  b.frame(findings, {name: 'Spacer', w: 'fill', h: 'fill'});
  footer(findings, '02');

  // 3. The number and the chart
  const growth = slide('03 — Growth', c.paper);
  b.update(growth, {autoLayout: {...b.node(growth).autoLayout!, itemSpacing: 64}});
  const body = b.frame(growth, {name: 'Content', layout: 'row', w: 'fill', h: 'fill', gap: 96});
  const left = b.frame(body, {name: 'Figure', layout: 'col', w: 720, h: 'fill', gap: 24, main: 'center'});
  b.text(left, 'Revenue', t.label, {color: c.accent});
  b.text(left, '+38%', t.figure, {color: c.ink});
  b.text(left, 'revenue growth in 2026. The goal for 2027 is another +100% from new regions and service.', t.body, {color: c.text2, w: 'fill'});
  const chart = b.frame(body, {name: 'Chart', layout: 'col', w: 'fill', h: 'fill', pad: 56, gap: 40, radius: 32, fill: c.white});
  const chartHead = b.frame(chart, {name: 'Heading', layout: 'row', w: 'fill', gap: 'auto', cross: 'center'});
  b.text(chartHead, 'Revenue by quarter', {...t.h2, size: 32, line: 40}, {color: c.ink});
  b.text(chartHead, '$M', t.caption, {color: c.text2});
  const bars = b.frame(chart, {name: 'Bars', layout: 'row', w: 'fill', h: 'fill', gap: 32, cross: 'end'});
  const data: [string, number, boolean][] = [['Q1', 42, false], ['Q2', 49, false], ['Q3', 55, false], ['Q4', 63, false], ['2027, plan', 126, true]];
  const tallest = 126, room = 440;
  for (const [label, value, plan] of data) {
    const col = b.frame(bars, {name: label, layout: 'col', w: 'fill', gap: 16, cross: 'center'});
    b.text(col, String(value), {...t.h2, size: 28, line: 36}, {color: plan ? c.accent : c.ink});
    b.rect(col, {name: 'Bar', w: 'fill', h: Math.round((value / tallest) * room), radius: [12, 12, 4, 4], fill: plan ? linear([['#7B6EFF'], ['#5B4CFF']], 90) : c.accentSoft});
    b.text(col, label, t.caption, {color: c.text2});
  }
  footer(growth, '03');

  // ── Prototype ──
  const slides = [cover, findings, growth];
  const to = (trigger: Reaction['trigger'], destinationId: NodeId): Reaction =>
    ({trigger, actions: [{type: 'NODE', navigation: 'NAVIGATE', destinationId, transition: {type: 'DISSOLVE', duration: 0.3, easing: 'EASE_OUT'}}]});
  b.flow(page, cover, 'Presentation');
  slides.forEach((id, i) => {
    const next = slides[i + 1], previous = slides[i - 1];
    if (next) {
      b.react(id, to({type: 'ON_CLICK'}, next));
      b.react(id, to({type: 'ON_KEY_DOWN', keyCode: 'ArrowRight'}, next));
    }
    if (previous) b.react(id, to({type: 'ON_KEY_DOWN', keyCode: 'ArrowLeft'}, previous));
  });

  b.normalize();
  b.arrangeOnPage(slides, {gap: 120});
  return b.finish();
}
