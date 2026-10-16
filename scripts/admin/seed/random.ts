// A small deterministic PRNG for the demo seeder (scripts/admin/seed-demo.ts): sfc32 seeded through a string hash, so one `--seed`
// always writes the same history. Never Math.random. `fork(label)` gives an independent stream per part of the model, so changing how
// one part draws leaves the others' draws as they were.

/** xmur3: a 32-bit hash of a string, called repeatedly for the four words of sfc32's state. */
function hashSeed(text: string): () => number {
  let h = 1779033703 ^ text.length;
  for (let i = 0; i < text.length; i++) {
    h = Math.imul(h ^ text.charCodeAt(i), 3432918353);
    h = (h << 13) | (h >>> 19);
  }
  return () => {
    h = Math.imul(h ^ (h >>> 16), 2246822507);
    h = Math.imul(h ^ (h >>> 13), 3266489909);
    return (h ^= h >>> 16) >>> 0;
  };
}

const HEX = '0123456789abcdef';
const BASE36 = '0123456789abcdefghijklmnopqrstuvwxyz';
const URL_SAFE = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789_-';

export class Random {
  private a: number;
  private b: number;
  private c: number;
  private d: number;
  constructor(readonly label: string) {
    const word = hashSeed(label);
    this.a = word();
    this.b = word();
    this.c = word();
    this.d = word();
    // sfc32 needs a few rounds before its output is well mixed.
    for (let i = 0; i < 15; i++) this.next();
  }
  /** A new independent stream, named after this one and `label`. */
  fork(label: string): Random {
    return new Random(this.label + '/' + label);
  }
  /** Uniform in [0, 1). */
  next(): number {
    this.a >>>= 0;
    this.b >>>= 0;
    this.c >>>= 0;
    this.d >>>= 0;
    let t = (this.a + this.b) | 0;
    this.a = this.b ^ (this.b >>> 9);
    this.b = (this.c + (this.c << 3)) | 0;
    this.c = (this.c << 21) | (this.c >>> 11);
    this.d = (this.d + 1) | 0;
    t = (t + this.d) | 0;
    this.c = (this.c + t) | 0;
    return (t >>> 0) / 4294967296;
  }
  /** Uniform in [min, max). */
  uniform(min: number, max: number): number {
    return min + (max - min) * this.next();
  }
  /** A whole number in [min, max], both included. */
  int(min: number, max: number): number {
    return min + Math.floor(this.next() * (max - min + 1));
  }
  chance(p: number): boolean {
    return this.next() < p;
  }
  pick<T>(list: readonly T[]): T {
    if (!list.length) throw new RangeError('Nothing to pick from.');
    return list[Math.floor(this.next() * list.length)];
  }
  /** One of `entries`, each as likely as its weight. */
  weighted<T>(entries: readonly (readonly [T, number])[]): T {
    const total = entries.reduce((sum, [, weight]) => sum + weight, 0);
    let at = this.next() * total;
    for (const [value, weight] of entries) {
      at -= weight;
      if (at < 0) return value;
    }
    return entries[entries.length - 1][0];
  }
  /** An index into `weights`, each as likely as its weight. */
  index(weights: readonly number[]): number {
    const total = weights.reduce((sum, weight) => sum + weight, 0);
    let at = this.next() * total;
    for (let i = 0; i < weights.length; i++) {
      at -= weights[i];
      if (at < 0) return i;
    }
    return weights.length - 1;
  }
  /** `count` distinct items of `list` (all of them when it is shorter), in random order. */
  sample<T>(list: readonly T[], count: number): T[] {
    const copy = [...list];
    for (let i = copy.length - 1; i > 0; i--) {
      const j = Math.floor(this.next() * (i + 1));
      [copy[i], copy[j]] = [copy[j], copy[i]];
    }
    return copy.slice(0, Math.max(0, count));
  }
  /** Box–Muller. */
  normal(mean = 0, sd = 1): number {
    const u = 1 - this.next(),
      v = this.next();
    return mean + sd * Math.sqrt(-2 * Math.log(u)) * Math.cos(2 * Math.PI * v);
  }
  /** A positive number around `median`, spread by `sigma` (the log's standard deviation). */
  logNormal(median: number, sigma: number): number {
    return median * Math.exp(this.normal(0, sigma));
  }
  exponential(mean: number): number {
    return -mean * Math.log(1 - this.next());
  }
  /** Knuth's method; fine for the small means the model uses. */
  poisson(mean: number): number {
    if (mean <= 0) return 0;
    if (mean > 60) return Math.max(0, Math.round(this.normal(mean, Math.sqrt(mean))));
    const limit = Math.exp(-mean);
    let k = 0,
      p = 1;
    do {
      k++;
      p *= this.next();
    } while (p > limit);
    return k - 1;
  }
  private chars(alphabet: string, length: number): string {
    let out = '';
    for (let i = 0; i < length; i++) out += alphabet[Math.floor(this.next() * alphabet.length)];
    return out;
  }
  hex(length: number): string {
    return this.chars(HEX, length);
  }
  base36(length: number): string {
    return this.chars(BASE36, length);
  }
  urlSafe(length: number): string {
    return this.chars(URL_SAFE, length);
  }
  digits(length: number): string {
    return String(this.int(1, 9)) + this.chars('0123456789', length - 1);
  }
  /** A version 4 UUID's shape. */
  uuid(): string {
    const h = this.hex(32);
    const variant = HEX[8 + Math.floor(this.next() * 4)];
    return `${h.slice(0, 8)}-${h.slice(8, 12)}-4${h.slice(13, 16)}-${variant}${h.slice(17, 20)}-${h.slice(20, 32)}`;
  }
}
