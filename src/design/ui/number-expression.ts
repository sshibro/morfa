// What a number field accepts and how it prints numbers. Designers type arithmetic ("12+4",
// "100/3", "2*(8+4)"), decimal commas ("12,5") as well as points, grouped thousands ("1 280"), units the
// field already shows ("50%", "90°", "12px") and, when the field holds one value, an operation on it:
// "+8" adds 8, "*2" doubles, "/2" halves ("-8" is a negative number, as everywhere). A small
// recursive-descent parser does the maths: nothing typed is ever evaluated as code.

type Token = {kind: 'num'; value: number} | {kind: 'op'; value: '+' | '-' | '*' | '/' | '(' | ')'};

/** Text → normalized ASCII: commas between digits are decimal points, spaces inside numbers group thousands. */
export function normalizeNumberInput(text: string): string {
  return text
    .trim()
    .replace(/\s*(px|%|°|deg)$/i, '')
    .replace(/[−‒–—]/g, '-')
    .replace(/[×x]/gi, '*')
    .replace(/[÷:]/g, '/')
    .replace(/(\d)[\s   ]+(?=\d{3}(?!\d))/g, '$1')
    .replace(/(\d),(\d)/g, '$1.$2')
    .replace(/,(\d)/g, '.$1')
    .trim();
}

function tokenize(text: string): Token[] | null {
  const tokens: Token[] = [];
  let index = 0;
  while (index < text.length) {
    const char = text[index];
    if (char === ' ' || char === ' ') { index++; continue; }
    if ('+-*/()'.includes(char)) { tokens.push({kind: 'op', value: char as '+'}); index++; continue; }
    const match = /^(\d+\.?\d*|\.\d+)(e[+-]?\d+)?/i.exec(text.slice(index));
    if (!match) return null;
    tokens.push({kind: 'num', value: Number(match[0])});
    index += match[0].length;
  }
  return tokens;
}

/** expression := term (('+' | '-') term)*; term := factor (('*' | '/') factor)*; factor := ('-' | '+') factor | number | '(' expression ')' */
function evaluate(tokens: Token[]): number | null {
  let position = 0;
  const peek = () => tokens[position];
  const isOp = (token: Token | undefined, ...ops: string[]) => token?.kind === 'op' && ops.includes(token.value);
  let depth = 0;
  const factor = (): number => {
    const token = tokens[position++];
    if (!token) throw new Error('end');
    if (token.kind === 'num') return token.value;
    if (token.value === '-') return -factor();
    if (token.value === '+') return factor();
    if (token.value === '(') {
      if (++depth > 32) throw new Error('depth');
      const value = expression();
      if (!isOp(tokens[position++], ')')) throw new Error('paren');
      depth--;
      return value;
    }
    throw new Error('token');
  };
  const term = (): number => {
    let value = factor();
    while (isOp(peek(), '*', '/')) {
      const op = (tokens[position++] as {value: string}).value;
      const right = factor();
      value = op === '*' ? value * right : value / right;
    }
    return value;
  };
  const expression = (): number => {
    let value = term();
    while (isOp(peek(), '+', '-')) {
      const op = (tokens[position++] as {value: string}).value;
      const right = term();
      value = op === '+' ? value + right : value - right;
    }
    return value;
  };
  try {
    const value = expression();
    return position === tokens.length && Number.isFinite(value) ? value : null;
  } catch {
    return null;
  }
}

/**
 * The number the text means, or null when it means none (empty, malformed, division by zero).
 * `current` is the field's value; a leading `+`, `*` or `/` applies to it, and without one
 * (a field showing "Mixed") such text means nothing.
 */
export function evaluateNumberInput(text: string, current?: number | null): number | null {
  const normalized = normalizeNumberInput(text);
  if (!normalized || normalized.length > 200) return null;
  const relative = /^[+*/]/.test(normalized);
  if (relative) {
    if (current === undefined || current === null || !Number.isFinite(current)) return null;
    const operand = evaluate(tokenize(normalized.slice(1)) ?? []);
    if (operand === null) return null;
    const op = normalized[0];
    const value = op === '+' ? current + operand : op === '*' ? current * operand : current / operand;
    return Number.isFinite(value) ? value : null;
  }
  const tokens = tokenize(normalized);
  return tokens && tokens.length ? evaluate(tokens) : null;
}

/** Rounded to `precision` decimals with trailing zeros dropped, decimal point: 12.5 → "12.5", 3.0 → "3". */
export function formatNumber(value: number, precision = 2): string {
  if (!Number.isFinite(value)) return '';
  const factor = 10 ** precision;
  const rounded = Math.round(value * factor) / factor;
  // -0 prints as 0.
  const text = String(Object.is(rounded, -0) ? 0 : rounded);
  if (/e/i.test(text)) return rounded.toFixed(precision).replace(/\.?0+$/, '');
  return text;
}

/** Clamps and rounds a value the way the field stores it. */
export function settleNumber(value: number, options: {min?: number; max?: number; precision?: number} = {}): number {
  let next = value;
  if (options.min !== undefined) next = Math.max(options.min, next);
  if (options.max !== undefined) next = Math.min(options.max, next);
  const factor = 10 ** (options.precision ?? 2);
  next = Math.round(next * factor) / factor;
  return Object.is(next, -0) ? 0 : next;
}

/** One scrub step: Shift ×10, Alt ×0.1 (Figma's convention). */
export function scrubMultiplier(modifiers: {shiftKey: boolean; altKey: boolean}): number {
  return modifiers.shiftKey ? 10 : modifiers.altKey ? 0.1 : 1;
}

/**
 * Turns a scrub's pointer travel into whole steps (tenths with Alt), as Figma's fields land on round values: pointer
 * events report fractions of a pixel on high-density screens and trackpads, which used to scrub a width to 200,5.
 * `scrub.rest` keeps the travel that has not made a step yet; the result is in steps (multiply by the field's step).
 */
export function takeScrubSteps(scrub: {rest: number}, dx: number, modifiers: {shiftKey: boolean; altKey: boolean}): number {
  const multiplier = scrubMultiplier(modifiers);
  const quantum = Math.min(1, multiplier);
  scrub.rest += dx * multiplier;
  const count = Math.trunc(scrub.rest / quantum + (scrub.rest < 0 ? -1e-9 : 1e-9));
  if (!count) return 0;
  const steps = Math.round(count * quantum * 10) / 10;
  scrub.rest -= steps;
  return steps;
}
