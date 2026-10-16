import {test} from 'node:test';
import assert from 'node:assert/strict';
import {createDocument, defaultTextProps} from '../shared/design/defaults';
import type {DesignDocument} from '../shared/design/types';
import {collectTokens, tokensCss, tokensTs} from '../shared/design/codegen/tokens';
import {PRODUCT_NAME} from '../shared/design/product';
import {add} from './design-codegen-fixture';

// Styles and variables as design tokens: CSS custom properties with a block per extra mode, and the
// same names for TypeScript.
// The style and variable names here are Cyrillic on purpose: token naming maps Russian design words to English identifiers
// (shared/design/codegen/names.ts), so the Cyrillic names, their comments in the output and the derived names stay as they are.

function tokensDoc(): DesignDocument {
  let doc = createDocument('p');
  doc.styles = {
    fill: {id: 'fill', type: 'FILL', name: 'Бренд/Основной', description: '', paints: [{type: 'SOLID', color: {r: 13 / 255, g: 153 / 255, b: 1}, opacity: 1, visible: true, blendMode: 'NORMAL'}]},
    grad: {id: 'grad', type: 'FILL', name: 'Градиент героя', description: '', paints: [{type: 'GRADIENT_LINEAR', gradientHandlePositions: [{x: 0, y: 0.5}, {x: 1, y: 0.5}, {x: 0, y: 1}], gradientStops: [{position: 0, color: {r: 1, g: 0, b: 0, a: 1}}, {position: 1, color: {r: 0, g: 0, b: 1, a: 1}}], opacity: 1, visible: true, blendMode: 'NORMAL'}]},
    h1: {id: 'h1', type: 'TEXT', name: 'Заголовки/H1', description: 'Главный заголовок', text: {...defaultTextProps().style, fontSize: 40, fontWeight: 700, lineHeight: {unit: 'PIXELS', value: 48}, letterSpacing: {unit: 'PERCENT', value: -2}}},
    shadow: {id: 'shadow', type: 'EFFECT', name: 'Тени/Карточка', description: '', effects: [
      {type: 'DROP_SHADOW', color: {r: 0, g: 0, b: 0, a: 0.1}, offset: {x: 0, y: 4}, radius: 12, spread: 0, visible: true, blendMode: 'NORMAL'},
      {type: 'BACKGROUND_BLUR', radius: 20, visible: true},
    ]},
  };
  doc.variableCollections = {
    colors: {id: 'colors', name: 'Цвета', modes: [{modeId: 'light', name: 'Светлая'}, {modeId: 'dark', name: 'Тёмная'}], defaultModeId: 'light', variableIds: ['bg', 'text', 'accent']},
    sizes: {id: 'sizes', name: 'Плотность', modes: [{modeId: 'normal', name: 'Обычная'}, {modeId: 'compact', name: 'Компактная'}], defaultModeId: 'normal', variableIds: ['gap', 'weight']},
  };
  doc.variables = {
    bg: {id: 'bg', name: 'Фон/Страница', collectionId: 'colors', type: 'COLOR', valuesByMode: {light: {r: 1, g: 1, b: 1, a: 1}, dark: {r: 0.1, g: 0.1, b: 0.1, a: 1}}, description: ''},
    text: {id: 'text', name: 'Текст/Основной', collectionId: 'colors', type: 'COLOR', valuesByMode: {light: {r: 0, g: 0, b: 0, a: 0.9}, dark: {r: 1, g: 1, b: 1, a: 1}}, description: ''},
    accent: {id: 'accent', name: 'Акцент', collectionId: 'colors', type: 'COLOR', valuesByMode: {light: {type: 'VARIABLE_ALIAS', id: 'bg'}, dark: {type: 'VARIABLE_ALIAS', id: 'bg'}}, description: ''},
    gap: {id: 'gap', name: 'spacing/m', collectionId: 'sizes', type: 'FLOAT', valuesByMode: {normal: 16, compact: 8}, description: ''},
    weight: {id: 'weight', name: 'Насыщенность заголовка', collectionId: 'sizes', type: 'FLOAT', valuesByMode: {normal: 700, compact: 700}, description: ''},
    beta: {id: 'beta', name: 'Бета', collectionId: 'colors', type: 'BOOLEAN', valuesByMode: {light: true}, description: ''},
  };
  doc = add(doc, 'TEXT', {id: 't', parentId: 'p', text: defaultTextProps('a'), boundVariables: {fontWeight: {type: 'VARIABLE_ALIAS', id: 'weight'}}});
  return doc;
}

test('tokens.css: styles and variables on :root, every other mode in its own attribute block', () => {
  const css = tokensCss(collectTokens(tokensDoc()));
  assert.equal(css, `/* Design tokens: styles and variables from ${PRODUCT_NAME}. */
:root {
  --color-brand-primary: #0D99FF; /* Бренд/Основной */
  --gradient-hero: linear-gradient(90deg, #FF0000 0%, #0000FF 100%); /* Градиент героя */
  --font-heading-h1: 700 40px/48px 'Inter', sans-serif; /* Заголовки/H1 */
  --font-heading-h1-tracking: -0.02em; /* Заголовки/H1 */
  --shadow-card: 0 4px 12px rgba(0, 0, 0, 0.1); /* Тени/Карточка */
  --color-background-page: #FFFFFF; /* Фон/Страница */
  --color-text-primary: rgba(0, 0, 0, 0.9); /* Текст/Основной */
  --color-accent: var(--color-background-page); /* Акцент */
  --spacing-m: 16px; /* spacing/m */
  --weight-heading: 700; /* Насыщенность заголовка */
}

[data-theme='dark'] {
  --color-background-page: #1A1A1A;
  --color-text-primary: #FFFFFF;
}

[data-density='compact'] {
  --spacing-m: 8px;
}
`);
});

test('tokens.ts: names, default values, flags and modes', () => {
  const ts = tokensTs(collectTokens(tokensDoc()));
  assert.match(ts, /export const tokens = \{\n  \/\*\* Бренд\/Основной \*\/\n  colorBrandPrimary: 'var\(--color-brand-primary\)',/);
  assert.match(ts, /fontHeadingH1: 'var\(--font-heading-h1\)',/);
  assert.match(ts, /colorBrandPrimary: 'var\(--color-brand-primary\)',/);
  assert.match(ts, /export type TokenName = keyof typeof tokens;/);
  assert.match(ts, /spacingM: "16px",/);
  assert.match(ts, /export const flags = \{\n  \/\*\* Бета \*\/\n  beta: true,\n\} as const;/);
  assert.match(ts, /export const themeModes = \['light', 'dark'\] as const;/);
  assert.match(ts, /export const densityModes = \['default', 'compact'\] as const;/);
});

test('the table maps styles and variables to their tokens; it is cached per document tables', () => {
  const doc = tokensDoc();
  const table = collectTokens(doc);
  assert.equal(table.byStyle.get('fill')?.name, 'color-brand-primary');
  assert.equal(table.trackingByStyle.get('h1')?.name, 'font-heading-h1-tracking');
  assert.equal(table.byStyle.get('shadow')?.kind, 'shadow');
  assert.equal(table.blurByStyle.get('shadow'), undefined, 'a background blur has no token (it is not a filter)');
  assert.equal(table.byVariable.get('gap')?.value, '16px');
  assert.equal(table.byVariable.get('weight')?.value, '700', 'bound to a weight: unitless');
  assert.equal(table.modeAttributes.get('colors')?.attribute, 'data-theme');
  assert.equal(collectTokens(doc), table, 'same tables, same answer');
  assert.notEqual(collectTokens({...doc, variables: {...doc.variables}}), table);
  assert.equal(tokensCss(collectTokens(createDocument('p'))), '', 'nothing to write without styles and variables');
});
