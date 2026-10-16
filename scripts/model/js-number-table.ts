// Writes crates/model/tests/tables/js_number.json: doubles (as the 16 hex digits of their bits) and
// what JavaScript's `String(n)` makes of them, the table `crates/model/src/js_number.rs` is tested
// against. Deterministic: the random rows come from a fixed-seed generator, so running it again
// gives the same file. Run with `npx tsx scripts/model/js-number-table.ts`.
import fs from 'node:fs';
import path from 'node:path';
import {fileURLToPath} from 'node:url';

const target = fileURLToPath(new URL('../../crates/model/tests/tables/js_number.json', import.meta.url));

const view = new DataView(new ArrayBuffer(8));
const bitsOf = (n: number): bigint => {
  view.setFloat64(0, n);
  return view.getBigUint64(0);
};
const fromBits = (bits: bigint): number => {
  view.setBigUint64(0, BigInt.asUintN(64, bits));
  return view.getFloat64(0);
};
const hex = (n: number) => bitsOf(n).toString(16).padStart(16, '0');
/** The neighbouring doubles (for positive finite `n`). */
const next = (n: number) => fromBits(bitsOf(n) + 1n);
const previous = (n: number) => fromBits(bitsOf(n) - 1n);

// splitmix64: a small, well-mixed generator with a fixed seed.
let state = 0x6d6f7266614e756dn; // "morfaNum"
function random64(): bigint {
  state = BigInt.asUintN(64, state + 0x9e3779b97f4a7c15n);
  let z = state;
  z = BigInt.asUintN(64, (z ^ (z >> 30n)) * 0xbf58476d1ce4e5b9n);
  z = BigInt.asUintN(64, (z ^ (z >> 27n)) * 0x94d049bb133111ebn);
  return z ^ (z >> 31n);
}
const randomInt = (below: number) => Number(random64() % BigInt(below));

const rows = new Map<string, string>();
const add = (...values: number[]) => {
  for (const n of values) {
    if (!Number.isFinite(n)) throw new Error(`not finite: ${n}`);
    const key = hex(n);
    if (!rows.has(key)) rows.set(key, String(n));
  }
};
const both = (...values: number[]) => add(...values.flatMap(n => [n, -n]));
const around = (n: number) => both(previous(n), n, next(n));

// Zero, small integers and the integers around 2^53.
add(0, -0);
both(1, 2, 3, 7, 10, 42, 100, 255, 1000, 1024, 65535, 1e6, 123456789, 2 ** 31 - 1, 2 ** 31, 2 ** 32);
both(Number.MAX_SAFE_INTEGER - 1, Number.MAX_SAFE_INTEGER, Number.MAX_SAFE_INTEGER + 1, Number.MAX_SAFE_INTEGER + 3, 2 ** 53 + 2, 2 ** 54, 2 ** 63, 2 ** 64, 2 ** 70);
both(123456789012345680000, 12345678901234567000, 1234567890123456800000, 99999999999999990000, 999999999999999900000);
// The switch to exponent form at 1e21 and below 1e-6, and the powers of ten around them.
around(1e21);
around(1e20);
around(1e22);
around(1e-6);
around(1e-7);
around(1e-5);
both(1.5e21, 9.99e20, 1.0000000000000001e21, 0.000001234, 0.0000012345678, 0.00000099, 0.0000001, 123e-20, 1.23e-18);
for (let e = -30; e <= 30; e++) both(Number(`1e${e}`), Number(`3.7e${e}`));
// Extremes: subnormals, the smallest normal, the largest double.
both(Number.MIN_VALUE, 2 * Number.MIN_VALUE, 3 * Number.MIN_VALUE, 7 * Number.MIN_VALUE, 1e-323, 2.5e-323, 1e-320, 1.23e-310);
around(2 ** -1022);
both(fromBits(0x000fffffffffffffn), fromBits(0x0008000000000000n), Number.MAX_VALUE, previous(Number.MAX_VALUE), 1.5e300, 1e308, 2 ** 1023, 2 ** -1000, 2 ** 100, 2 ** -100);
both(Number.EPSILON, 1 + Number.EPSILON, 1 - Number.EPSILON / 2, Math.PI, Math.E, Math.SQRT2, Math.LN2);
// Decimal arithmetic noise and the values a design document is full of.
both(0.1, 0.2, 0.3, 0.1 + 0.2, 0.7 + 0.1, 1.1 * 3, 0.1 * 3, 1 / 3, 2 / 3, 0.333, 0.3333333333333333, 12.5, 1440, 0.12, 0.5, 0.25, 0.125, 1.5, 99.99);
both(128 / 255, 51 / 255, 1 / 255, 0.38196601125010515, 0.382, 2 * Math.PI, 33.333333333333336, 66.66666666666667, 375.5, 1920, 0.6, 0.06, 4.35, 17.8);
for (let i = 0; i < 40; i++) both(randomInt(100000) / 100, randomInt(2000) / 8, randomInt(255) / 255, (randomInt(7200) - 3600) / 10);
// Exact ties: halfway between two equally short digit strings, JavaScript takes the even one (where it
// reads back: below a power of two it may not, as for 2^-24).
both(2249082146819912.25, 2886254405724.53125, 247796919343770.125, 156125673461075.625, 2 ** -24, 2 ** -10, 2 ** -30);
for (let i = 0; i < 40; i++) {
  const bits = 1 + randomInt(10);
  const whole = Number(random64() % (1n << BigInt(53 - bits)));
  add(whole + (2 * randomInt(1 << (bits - 1)) + 1) / 2 ** bits);
}
// Random doubles: any bit pattern (every exponent), random mantissas at exponents across the range,
// and random short decimals (where the closest of several shortest digit strings matters).
for (let i = 0; i < 80; i++) {
  const n = fromBits(random64());
  if (Number.isFinite(n)) add(n);
}
for (let i = 0; i < 80; i++) {
  const exponent = BigInt(randomInt(2046) + 1);
  add(fromBits((random64() & 0x800fffffffffffffn) | (exponent << 52n)));
}
for (let i = 0; i < 40; i++) add(fromBits(random64() & 0x800fffffffffffffn)); // subnormals
for (let i = 0; i < 60; i++) {
  const digits = 1 + randomInt(17);
  const mantissa = random64() % 10n ** BigInt(digits);
  both(Number(`${mantissa}e${randomInt(80) - 40}`));
}

const lines = [...rows].map(([bits, text]) => `  ${JSON.stringify([bits, text])}`);
fs.mkdirSync(path.dirname(target), {recursive: true});
fs.writeFileSync(target, `[\n${lines.join(',\n')}\n]\n`);
console.log(`${rows.size} numbers → ${target}`);
