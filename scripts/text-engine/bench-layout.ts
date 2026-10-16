// Lane L3: layoutText cost per text, TypeScript vs the wasm engine, with the tests' fake measurer
// (no fonts, so the boundary alone is measured). Usage: npx tsx scripts/text-engine/bench-layout.ts
import {BLACK, defaultTextProps, solid} from '../../shared/design/defaults';
import {engineCalls, setEngine} from '../../shared/design/engine-switch';
import {layoutText, layoutTextMany, type FontSpec, type TextMeasurer} from '../../shared/design/text-layout';

const unitWidth = (ch: string) => (ch === ' ' ? 0.25 : 0.5);
const measurer: TextMeasurer = {
  width(text: string, font: FontSpec) {
    let w = 0;
    for (const ch of text) w += unitWidth(ch) * font.size;
    return w;
  },
  metrics(font: FontSpec) {
    return {ascent: font.size * 0.8, descent: font.size * 0.2};
  },
};
// Russian words on purpose: the layout bench measures Cyrillic text (shaping, wrapping at Cyrillic word breaks).
const words = ['Кнопка', 'Заголовок', 'карточки', 'Подробнее', 'цена', '1 990 ₽', 'Купить', 'в корзину', 'Доставка', 'завтра'];
const short = (i: number) => ({width: 120, height: 0, fills: [solid(BLACK)], text: {...defaultTextProps(`${words[i % 10]} ${words[(i * 7) % 10]} ${words[(i * 3) % 10]} №${i % 50}`), textAutoResize: 'HEIGHT' as const}});
const long = (i: number) => ({width: 600, height: 0, fills: [solid(BLACK)], text: {...defaultTextProps(Array.from({length: 300}, (_, k) => words[(k * 7 + i) % 10]).join(' ')), textAutoResize: 'HEIGHT' as const}});

const best = (count: number, make: (i: number) => ReturnType<typeof short>, batches = 5) => {
  let elapsed = Infinity;
  for (let b = 0; b < batches; b++) {
    const nodes = Array.from({length: count}, (_, i) => make(i));
    const started = performance.now();
    for (const n of nodes) layoutText(n, measurer);
    elapsed = Math.min(elapsed, performance.now() - started);
  }
  return elapsed;
};

for (const mode of ['ts', 'wasm', 'ts', 'wasm'] as const) {
  setEngine('text', mode);
  for (let i = 0; i < 2000; i++) layoutText(short(i), measurer);
  const shortMs = best(1000, short);
  const longMs = best(20, long);
  let batched = Infinity;
  for (let b = 0; b < 5; b++) {
    const nodes = Array.from({length: 1000}, (_, i) => short(i));
    const started = performance.now();
    layoutTextMany(nodes, measurer);
    batched = Math.min(batched, performance.now() - started);
  }
  console.log(`${mode.padEnd(4)} 1000 short texts: ${shortMs.toFixed(1)} ms (${shortMs.toFixed(1)} µs each), batched ${batched.toFixed(1)} ms; 20 texts of 2 000 chars: ${longMs.toFixed(1)} ms (${((longMs / 20) * 1000).toFixed(0)} µs each)`, JSON.stringify(engineCalls('text')));
}
