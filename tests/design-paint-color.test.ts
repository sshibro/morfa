import {test} from 'node:test';
import assert from 'node:assert/strict';
import {
  colorKey, formatCss, hslToRgb, hsvFields, hsvToRgb, parseCssColor, parseHex, rgbToHsl, rgbToHsv, sameRgb, to255, toHex, toHex8,
} from '../src/design/panels/design/paint/color';

const close = (a: number, b: number, eps = 1e-9) => assert.ok(Math.abs(a - b) < eps, `${a} ≠ ${b}`);
const RED = {r: 1, g: 0, b: 0};

test('hex reads what designers type: shorthands, «#», alpha bytes', () => {
  assert.deepEqual(parseHex('F'), {color: {r: 1, g: 1, b: 1}, alpha: null});
  assert.deepEqual(parseHex('ab')?.color, parseHex('ABABAB')?.color);
  assert.deepEqual(parseHex('#f00')?.color, RED);
  const withAlpha = parseHex('#ff000080')!;
  assert.deepEqual(withAlpha.color, RED);
  close(withAlpha.alpha!, 128 / 255);
  close(parseHex('f008')!.alpha!, 136 / 255);
  assert.equal(parseHex('12345'), null);
  assert.equal(parseHex('xyz'), null);
  assert.equal(parseHex(''), null);
});

test('hex is written uppercase, alpha only when translucent', () => {
  assert.equal(toHex({r: 217 / 255, g: 217 / 255, b: 217 / 255}), 'D9D9D9');
  assert.equal(toHex8(RED, 1), 'FF0000');
  assert.equal(toHex8(RED, 0.5), 'FF000080');
  assert.equal(toHex({r: 2, g: -1, b: 0.5}), 'FF0080', 'channels are clamped');
});

test('RGB ↔ HSB round-trips every 8-bit colour sample', () => {
  for (let r = 0; r <= 255; r += 51) for (let g = 0; g <= 255; g += 51) for (let b = 0; b <= 255; b += 51) {
    const rgb = {r: r / 255, g: g / 255, b: b / 255};
    assert.ok(sameRgb(hsvToRgb(rgbToHsv(rgb)), rgb), `hsv ${r},${g},${b}`);
    assert.ok(sameRgb(hslToRgb(rgbToHsl(rgb)), rgb), `hsl ${r},${g},${b}`);
  }
});

test('HSB of known colours, and hue kept through grey and black', () => {
  assert.deepEqual(rgbToHsv(RED), {h: 0, s: 1, v: 1});
  assert.deepEqual(hsvFields(rgbToHsv({r: 0, g: 0, b: 1})), {h: 240, s: 100, v: 100});
  assert.equal(rgbToHsv({r: 0.5, g: 0.5, b: 0.5}, 200).h, 200);
  assert.equal(rgbToHsv({r: 0, g: 0, b: 0}, 123).h, 123);
  const hsl = rgbToHsl({r: 0, g: 1, b: 0});
  close(hsl.h, 120); close(hsl.s, 1); close(hsl.l, 0.5);
});

test('CSS colours parse with alpha in every common syntax', () => {
  const a = parseCssColor('rgba(255, 0, 0, 0.5)')!;
  assert.deepEqual(a.color, RED);
  assert.equal(a.alpha, 0.5);
  const b = parseCssColor('rgb(255 0 0 / 25%)')!;
  assert.equal(b.alpha, 0.25);
  assert.equal(parseCssColor('rgb(100%, 0%, 0%)')!.alpha, null);
  const c = parseCssColor('hsla(120, 100%, 50%, .4)')!;
  assert.ok(sameRgb(c.color, {r: 0, g: 1, b: 0}));
  close(c.alpha!, 0.4);
  assert.ok(sameRgb(parseCssColor('hsb(240, 100%, 100%)')!.color, {r: 0, g: 0, b: 1}));
  assert.deepEqual(parseCssColor('#00ff00')!.color, {r: 0, g: 1, b: 0});
  assert.equal(parseCssColor('rgb(1, 2)'), null);
  assert.equal(parseCssColor('blue'), null);
});

test('CSS is written as rgb() when opaque and rgba() when not, and reads back', () => {
  assert.equal(formatCss(RED), 'rgb(255, 0, 0)');
  assert.equal(formatCss(RED, 0.456), 'rgba(255, 0, 0, 0.46)');
  const back = parseCssColor(formatCss({r: 0.2, g: 0.4, b: 0.6}, 0.5))!;
  assert.ok(sameRgb(back.color, {r: 0.2, g: 0.4, b: 0.6}));
  assert.equal(back.alpha, 0.5);
});

test('colour keys tell colours apart as the panel prints them', () => {
  assert.equal(colorKey(RED, 1), 'FF0000:100');
  assert.equal(colorKey({r: 1.0001, g: 0, b: 0}, 0.999), 'FF0000:100');
  assert.notEqual(colorKey(RED, 0.5), colorKey(RED, 1));
  assert.equal(to255(0.5), 128);
});
