import {test} from 'node:test';
import assert from 'node:assert/strict';
import {evaluateNumberInput, formatNumber, normalizeNumberInput, scrubMultiplier, settleNumber, takeScrubSteps} from '../src/design/ui/number-expression';

test('a number field evaluates arithmetic typed in it', () => {
  assert.equal(evaluateNumberInput('12+4'), 16);
  assert.equal(evaluateNumberInput('100/4'), 25);
  assert.equal(evaluateNumberInput('2*(8+4)'), 24);
  assert.equal(evaluateNumberInput('10 - 2 * 3'), 4);
  assert.equal(evaluateNumberInput('-5'), -5);
  assert.equal(evaluateNumberInput('-(2+3)'), -5);
  assert.equal(evaluateNumberInput('3 × 4'), 12);
  assert.equal(evaluateNumberInput('9 : 3'), 3);
  assert.equal(evaluateNumberInput('2−5'), -3);
});

test('decimal commas, grouped thousands and the units the field shows are understood', () => {
  assert.equal(evaluateNumberInput('12,5'), 12.5);
  assert.equal(evaluateNumberInput(',5'), 0.5);
  assert.equal(evaluateNumberInput('12,5+0,5'), 13);
  assert.equal(evaluateNumberInput('1 280'), 1280);
  assert.equal(evaluateNumberInput('1 280,5'), 1280.5);
  assert.equal(evaluateNumberInput('50%'), 50);
  assert.equal(evaluateNumberInput('90°'), 90);
  assert.equal(evaluateNumberInput('12px'), 12);
  assert.equal(normalizeNumberInput(' 12,5 px '), '12.5');
});

test('an operation on the current value needs one current value', () => {
  assert.equal(evaluateNumberInput('+8', 10), 18);
  assert.equal(evaluateNumberInput('*2', 10), 20);
  assert.equal(evaluateNumberInput('/4', 10), 2.5);
  assert.equal(evaluateNumberInput('-8', 10), -8, 'a leading minus is a negative number');
  assert.equal(evaluateNumberInput('+8', null), null, 'Mixed: there is no single value to add to');
  assert.equal(evaluateNumberInput('+8'), null);
  assert.equal(evaluateNumberInput('/0', 10), null);
});

test('text that means no number is rejected, never evaluated as code', () => {
  for (const text of ['', '   ', 'abc', '12+', '(1+2', '1+2)', '1/0', 'alert(1)', '1..2', '2**3', 'Infinity', 'NaN', '1e999']) {
    assert.equal(evaluateNumberInput(text), null, text);
  }
  assert.equal(evaluateNumberInput('('.repeat(40) + '1' + ')'.repeat(40)), null, 'nesting is bounded');
});

test('numbers print rounded, without trailing zeros, with a decimal point', () => {
  assert.equal(formatNumber(12.5), '12.5');
  assert.equal(formatNumber(3), '3');
  assert.equal(formatNumber(1 / 3), '0.33');
  assert.equal(formatNumber(1 / 3, 0), '0');
  assert.equal(formatNumber(-0.001), '0');
  assert.equal(formatNumber(1280.004), '1280');
  assert.equal(formatNumber(Number.NaN), '');
});

test('values settle into their range and precision; scrub steps follow the modifiers', () => {
  assert.equal(settleNumber(120, {max: 100}), 100);
  assert.equal(settleNumber(-3, {min: 0}), 0);
  assert.equal(settleNumber(1.23456, {precision: 2}), 1.23);
  assert.equal(scrubMultiplier({shiftKey: true, altKey: false}), 10);
  assert.equal(scrubMultiplier({shiftKey: false, altKey: true}), 0.1);
  assert.equal(scrubMultiplier({shiftKey: false, altKey: false}), 1);
});

test('a scrub lands on whole steps however finely the pointer reports its travel (tenths with Alt)', () => {
  const plain = {shiftKey: false, altKey: false}, alt = {shiftKey: false, altKey: true}, shift = {shiftKey: true, altKey: false};
  // A high-density screen reports half pixels: 0.5 + 0.5 is one step, never 0.5 of one.
  const scrub = {rest: 0};
  const steps = [0.5, 0.5, 0.5, 0.25, 0.25, 1.5].map(dx => takeScrubSteps(scrub, dx, plain));
  assert.deepEqual(steps, [0, 1, 0, 0, 1, 1]);
  assert.equal(scrub.rest, 0.5);
  // Back the other way: the travel left over counts against it, nothing jumps.
  assert.equal(takeScrubSteps(scrub, -1.25, plain), 0);
  assert.equal(takeScrubSteps(scrub, -1, plain), -1);
  // 24 px with fractions, as Playwright's steps report them: 24 whole steps in all, every one an integer.
  const drag = {rest: 0};
  let total = 0;
  for (let i = 0; i < 7; i++) {
    const each = takeScrubSteps(drag, 24 / 7, plain);
    assert.ok(Number.isInteger(each));
    total += each;
  }
  assert.equal(total, 24);
  // Alt: a tenth per pixel; Shift: ten per pixel.
  const fine = {rest: 0};
  assert.equal(takeScrubSteps(fine, 3, alt), 0.3);
  assert.equal(takeScrubSteps(fine, 0.5, alt), 0);
  assert.equal(takeScrubSteps(fine, 0.5, alt), 0.1);
  assert.equal(takeScrubSteps({rest: 0}, 0.5, shift), 5);
});
