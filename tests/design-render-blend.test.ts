import {test} from 'node:test';
import assert from 'node:assert/strict';
import type {BlendMode} from '../shared/design/types';
import {BLEND_OPERATIONS, blendOperation, cssColor, isNormalBlend} from '../src/design/engine/render/blend';

const MODES: BlendMode[] = ['PASS_THROUGH', 'NORMAL', 'DARKEN', 'MULTIPLY', 'COLOR_BURN', 'LIGHTEN', 'SCREEN', 'COLOR_DODGE', 'OVERLAY', 'SOFT_LIGHT', 'HARD_LIGHT', 'DIFFERENCE', 'EXCLUSION', 'HUE', 'SATURATION', 'COLOR', 'LUMINOSITY'];
const CANVAS_OPERATIONS = new Set(['source-over', 'darken', 'multiply', 'color-burn', 'lighten', 'screen', 'color-dodge', 'overlay', 'soft-light', 'hard-light', 'difference', 'exclusion', 'hue', 'saturation', 'color', 'luminosity']);

test('every blend mode maps to a canvas composite operation of the same name', () => {
  assert.deepEqual(Object.keys(BLEND_OPERATIONS).sort(), [...MODES].sort());
  for (const mode of MODES) {
    const operation = blendOperation(mode);
    assert.ok(CANVAS_OPERATIONS.has(operation), `${mode} → ${operation}`);
    if (!isNormalBlend(mode)) assert.equal(operation, mode.toLowerCase().replace(/_/g, '-'));
  }
  assert.equal(blendOperation(undefined), 'source-over');
  assert.ok(isNormalBlend('PASS_THROUGH') && isNormalBlend('NORMAL') && !isNormalBlend('MULTIPLY'));
});

test('colours become rgba() with 0..255 channels and clamped alpha', () => {
  assert.equal(cssColor({r: 1, g: 0.5, b: 0}), 'rgba(255, 128, 0, 1)');
  assert.equal(cssColor({r: 0, g: 0, b: 0, a: 0.5}, 0.5), 'rgba(0, 0, 0, 0.25)');
  assert.equal(cssColor({r: 2, g: -1, b: Number.NaN, a: 3}), 'rgba(255, 0, 0, 1)');
});
