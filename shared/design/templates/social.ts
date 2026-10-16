import type {DesignDocument, NodeId} from '../types';
import {TemplateBuilder, type BuildOptions, type ColorToken, type Font} from './kit';

// "Social": an autumn campaign of the coffee shop "Bean" in three formats — an Instagram post
// (1080 × 1080), a story (1080 × 1920, text kept out of the top and bottom 250 px) and a picture for a
// Telegram channel post (1280 × 720). The cup is drawn from plain shapes, so every part stays editable.

const SERIF = 'Playfair Display';
const SANS = 'Manrope';

export function buildSocial(options: BuildOptions): DesignDocument {
  const b = new TemplateBuilder(options);
  const page = b.page('Posts', '#E7E3DD');

  const c = {
    cream: b.colorStyle('Bean/Cream', '#F4ECE1'),
    milk: b.colorStyle('Bean/Milk', '#FFF8EF'),
    espresso: b.colorStyle('Bean/Espresso', '#2A1A12'),
    roast: b.colorStyle('Bean/Roast', '#6E5A4C'),
    terracotta: b.colorStyle('Bean/Terracotta', '#C9512F'),
    caramel: b.colorStyle('Bean/Caramel', '#E7A65A'),
    foam: b.colorStyle('Bean/Foam', '#EBDCC8'),
  };
  const t = {
    logo: b.textStyle('Social/Logo', {family: SERIF, weight: 800, size: 48, line: 56, tracking: -2}),
    titleL: b.textStyle('Social/Heading L', {family: SERIF, weight: 800, size: 120, line: 120, tracking: -3}),
    titleM: b.textStyle('Social/Heading M', {family: SERIF, weight: 800, size: 88, line: 92, tracking: -3}),
    titleS: b.textStyle('Social/Heading S', {family: SERIF, weight: 800, size: 72, line: 80, tracking: -2}),
    price: b.textStyle('Social/Price', {family: SANS, weight: 800, size: 64, line: 72, tracking: -3}),
    text: b.textStyle('Social/Text', {family: SANS, weight: 600, size: 32, line: 44, tracking: -1}),
    label: b.textStyle('Social/Label', {family: SANS, weight: 800, size: 24, line: 32, tracking: 6, case: 'UPPER'}),
  };

  /** The cup: a frame of shapes `size` px square, centred art on a disc. */
  const cup = (parent: NodeId, size: number, disc: ColorToken, box: {x?: number; y?: number; absolute?: boolean} = {}) => {
    const k = size / 520;
    const s = (v: number) => Math.round(v * k * 10) / 10;
    const art = b.frame(parent, {name: 'Cup', w: size, h: size, clip: false, ...box, constraints: {horizontal: 'MAX', vertical: 'MIN'}});
    b.ellipse(art, {name: 'Circle', x: 0, y: 0, w: size, h: size, fill: disc});
    const line = {stroke: c.espresso, strokeWeight: Math.max(2, s(7)), strokeAlign: 'CENTER' as const};
    b.ellipse(art, {name: 'Saucer', x: s(70), y: s(372), w: s(380), h: s(70), fill: c.foam, ...line});
    b.ellipse(art, {name: 'Handle', x: s(318), y: s(222), w: s(120), h: s(120), fill: c.milk, ...line, arc: {startingAngle: 0, endingAngle: 2 * Math.PI, innerRadius: 0.5}});
    b.rect(art, {name: 'Cup', x: s(110), y: s(196), w: s(260), h: s(200), radius: [s(10), s(10), s(110), s(110)], fill: c.milk, ...line});
    b.ellipse(art, {name: 'Coffee', x: s(110), y: s(170), w: s(260), h: s(56), fill: c.caramel, ...line});
    b.vector(art, 'M0 10C6 2 16 0 24 6c-6 1-9 4-12 9C9 10 5 9 0 10Z', {name: 'Foam', x: s(206), y: s(184), w: s(70), h: s(30), viewBox: [24, 15], fill: c.milk});
    for (const [i, dx] of [[0, 170], [1, 230], [2, 290]] as const) {
      b.vector(art, 'M10 0C0 14 20 22 10 36S20 58 10 72', {
        name: `Steam ${i + 1}`, x: s(dx), y: s(70), w: s(20), h: s(72), viewBox: [20, 72], fill: null, stroke: c.espresso, strokeWeight: Math.max(2, s(7)), strokeCap: 'ROUND',
      });
    }
    return art;
  };
  const pill = (parent: NodeId, label: string, font: Font, fill: ColorToken | null, color: ColorToken, stroke?: ColorToken) => {
    const frame = b.frame(parent, {name: label, layout: 'row', pad: [14, 28], radius: 40, cross: 'center', fill, stroke: stroke ?? null, strokeWeight: 3, strokeAlign: 'INSIDE'});
    b.text(frame, label, font, {color});
    return frame;
  };

  // Instagram: square post
  const post = b.frame(page, {name: 'Instagram — post 1080 × 1080', w: 1080, h: 1080, layout: 'col', pad: 80, gap: 'auto', fill: c.cream, clip: true});
  const postTop = b.frame(post, {name: 'Top', layout: 'row', w: 'fill', gap: 'auto', cross: 'center'});
  b.text(postTop, 'bean', t.logo, {color: c.espresso});
  pill(postTop, 'October only', {...t.label, size: 22, tracking: 4}, null, c.espresso, c.espresso);
  const postMiddle = b.frame(post, {name: 'Middle', layout: 'row', w: 'fill', gap: 24, cross: 'center'});
  const postMain = b.frame(postMiddle, {name: 'Offer', layout: 'col', w: 'fill', gap: 24});
  b.text(postMain, 'Pumpkin\nspice latte', t.titleM, {color: c.espresso});
  const price = b.frame(postMain, {name: 'Price', layout: 'row', gap: 20, cross: 'baseline'});
  b.text(price, '$4.50', t.price, {color: c.terracotta});
  b.text(price, 'was $5.50', t.text, {color: c.roast, runs: [{start: 4, end: 9, decoration: 'STRIKETHROUGH'}]});
  cup(postMiddle, 360, c.caramel);
  const postBottom = b.frame(post, {name: 'Bottom', layout: 'row', w: 'fill', gap: 'auto', cross: 'center'});
  b.text(postBottom, '17 Maple Street\nevery day from 8 am to 10 pm', {...t.text, size: 28, line: 40}, {color: c.espresso});
  pill(postBottom, 'Come in!', {...t.text, weight: 800}, c.terracotta, c.milk);

  // Stories
  const story = b.frame(page, {name: 'Story 1080 × 1920', w: 1080, h: 1920, layout: 'col', pad: [250, 96, 250, 96], gap: 'auto', fill: c.espresso, clip: true});
  const storyTop = b.frame(story, {name: 'Top', layout: 'row', w: 'fill', gap: 'auto', cross: 'center'});
  b.text(storyTop, 'bean', t.logo, {color: c.cream});
  b.text(storyTop, '@zerno.coffee', {...t.text, size: 28}, {color: c.caramel});
  const storyArt = b.frame(story, {name: 'Illustration', layout: 'row', w: 'fill', main: 'center'});
  cup(storyArt, 640, c.terracotta);
  const storyText = b.frame(story, {name: 'Text', layout: 'col', w: 'fill', gap: 32});
  b.text(storyText, 'Autumn\nin every cup', t.titleL, {color: c.cream, w: 'fill'});
  b.text(storyText, 'Pumpkin spice latte, chai latte and cocoa with marshmallows — until November 30.', {...t.text, size: 40, line: 56}, {color: '#D9C8B4', w: 'fill'});
  const swipe = b.frame(story, {name: 'Call to action', layout: 'row', w: 'fill', main: 'center'});
  pill(swipe, 'Order to go ↑', {...t.text, weight: 800}, c.caramel, c.espresso);

  // Telegram cover
  const cover = b.frame(page, {name: 'Telegram — post 1280 × 720', w: 1280, h: 720, layout: 'row', pad: [80, 80, 80, 96], gap: 48, cross: 'center', fill: c.milk, clip: true});
  const coverText = b.frame(cover, {name: 'Text', layout: 'col', w: 'fill', gap: 28});
  b.text(coverText, 'Coffee shop channel', t.label, {color: c.terracotta});
  b.text(coverText, 'Bean — coffee\nto go, made with care', t.titleS, {color: c.espresso, w: 'fill'});
  b.text(coverText, 'New menu items, offers and greetings to our regulars.', {...t.text, size: 28, line: 40}, {color: c.roast, w: 'fill'});
  pill(coverText, 't.me/zerno_coffee', {...t.text, size: 26, weight: 800}, c.espresso, c.milk);
  cup(cover, 400, c.caramel);

  b.normalize();
  b.arrangeOnPage([post, story, cover], {gap: 120});
  return b.finish();
}
