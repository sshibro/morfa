import {test} from 'node:test';
import assert from 'node:assert/strict';
import {fontFamilies} from '../shared/fonts';
import {catalogueFamilies, createFontRegistry, faceSources, familyHasItalic, familyWeights, internalFamily, nearestWeight, parseLocalStyle} from '../src/design/engine/fonts';

test('weight matching follows CSS: 400–500 look up to 500 first, light looks lighter, bold looks bolder', () => {
  assert.equal(nearestWeight([300, 400, 700], 400), 400);
  assert.equal(nearestWeight([400, 700], 450), 400);
  assert.equal(nearestWeight([300, 500, 700], 450), 500);
  assert.equal(nearestWeight([300, 600], 500), 300);
  assert.equal(nearestWeight([400, 700], 300), 400);
  assert.equal(nearestWeight([200, 400], 300), 200);
  assert.equal(nearestWeight([300, 400], 700), 400);
  assert.equal(nearestWeight([400, 600, 800], 700), 800);
  assert.equal(nearestWeight([], 500), 500);
});

test('families keep their designer names, once each, with the weights they can draw', () => {
  const families = catalogueFamilies();
  const names = families.map(f => f.family);
  assert.equal(new Set(names).size, names.length);
  for (const name of ['Inter', 'Roboto', 'Montserrat', 'Playfair Display', 'PT Serif']) assert.ok(names.includes(name), name);
  assert.deepEqual(familyWeights(fontFamilies.inter), [100, 200, 300, 400, 500, 600, 700, 800, 900]);
  assert.deepEqual(familyWeights(fontFamilies['pt-serif']), [400, 700]);
  assert.deepEqual(familyWeights(fontFamilies.literata), [700, 900]);
  assert.ok(familyHasItalic(fontFamilies.literata));
  assert.equal(familyHasItalic(fontFamilies.inter), false);
});

test('a variable family loads its two subset files once for every weight', () => {
  const inter = faceSources(fontFamilies.inter, 650, false);
  assert.equal(inter.key, faceSources(fontFamilies.inter, 300, true).key, 'italic without italic files slants the upright face');
  assert.deepEqual(inter.faces.map(f => f.url), ['/fonts/inter/inter-cyrillic-wght-normal.woff2', '/fonts/inter/inter-latin-wght-normal.woff2']);
  assert.equal(inter.faces[0].weight, '100 900');
  assert.ok(inter.faces.every(f => f.unicodeRange));
});

test('a static family loads the nearest weight; listed files pick their style and weight', () => {
  const pt = faceSources(fontFamilies['pt-serif'], 600, false, '/static/fonts');
  assert.deepEqual(pt.faces.map(f => f.url), ['/static/fonts/pt-serif/pt-serif-cyrillic-700-normal.woff2', '/static/fonts/pt-serif/pt-serif-latin-700-normal.woff2']);
  const literata = faceSources(fontFamilies.literata, 800, true);
  assert.deepEqual(literata.faces.map(f => [f.url, f.style]), [['/fonts/literata/Literata-BlackItalic.woff2', 'italic']]);
  const upright = faceSources(fontFamilies.literata, 700, false);
  assert.deepEqual(upright.faces.map(f => f.url), ['/fonts/literata/Literata-Bold.woff2']);
});

test('local font style names give weight and slant', () => {
  assert.deepEqual(parseLocalStyle('Regular'), {weight: 400, italic: false});
  assert.deepEqual(parseLocalStyle('SemiBold Italic'), {weight: 600, italic: true});
  assert.deepEqual(parseLocalStyle('Extra Light'), {weight: 200, italic: false});
  assert.deepEqual(parseLocalStyle('Black Oblique'), {weight: 900, italic: true});
  assert.deepEqual(parseLocalStyle('Bold'), {weight: 700, italic: false});
  assert.deepEqual(parseLocalStyle('Condensed'), {weight: 400, italic: false});
});

test('the registry names faces privately and lists the catalogue without a browser', async () => {
  const fonts = createFontRegistry();
  const css = fonts.cssFont({family: 'Inter', weight: 650, italic: true, size: 13.5});
  assert.equal(css, `italic 650 13.5px "${internalFamily('Inter')}", Arial, sans-serif`);
  // A Cyrillic family name is kept on purpose: non-ASCII names pass through, the quotes are escaped.
  assert.match(fonts.cssFont({family: 'Неизвестный "шрифт"', weight: 2000, italic: false, size: 0}), /^1000 1px "dz Неизвестный \\"шрифт\\"", Arial, sans-serif$/);
  // Without FontFace (node) nothing loads and nothing waits.
  await fonts.ensure({family: 'Inter', weight: 400, italic: false, size: 16});
  assert.equal(fonts.isLoaded({family: 'No such family', weight: 400, italic: false, size: 16}), true);
  const listed = fonts.families();
  assert.ok(listed.length > 50);
  assert.deepEqual(listed.find(f => f.family === 'Inter'), {family: 'Inter', weights: familyWeights(fontFamilies.inter), italic: false, source: 'catalog', kind: 'sans'});
  assert.equal(await fonts.requestLocalFonts(), false, 'no local font access outside Chromium');
});
