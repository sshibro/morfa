import {test} from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import {engineFor} from '../shared/design/engine-switch';
import {renderWasmAvailable, viaRenderEngine} from '../shared/design/render-engine';
import {goldenMetas, GOLDENS_DIR, renderDocOf, renderLikeGolden, scoreAgainstGolden} from '../scripts/goldens/engine';
import {DEFAULT_BARS, judge} from '../scripts/goldens/ssim';
import {FIXTURES} from '../scripts/goldens/fixtures';

// The renderer (crates/render) against today's Canvas2D goldens: the CPU path
// (vello_cpu, the nodejs build of crates/render-wasm) renders the fixture pages from the same documents and must score
// SSIM ≥ 0.995 outside the text and effect masks and ≥ 0.98 inside the effect mask, at DPR 1, 1.5 and 2. Text is
// the host's (painted by the host as sprites in the browser; nothing here), so the text mask is never judged.
//
// The goldens are build outputs (`npx tsx scripts/goldens/render.ts`, headless Chromium) and the renderer wasm is
// built by scripts/wasm-render-build.sh: without either the test says so and passes as skipped. In `ts` mode the render
// module answers with the golden itself (Canvas2D painted it); in `wasm` and `both` the renderer is run and compared
// through the engine switch, so the differential report counts the calls. The whole sweep (every golden) is
// `npx tsx scripts/goldens/engine.ts`; this test takes a sample that runs in a few seconds.

// Fixture, DPR and (optionally) the page: the richest pages at the three DPRs, none above 2 000 px a side, so the
// sample stays well under a minute on the software path even in the both-mode run.
const SAMPLE: [string, number, string?][] = [['effects', 1], ['effects', 1.5], ['template-site', 1], ['template-ui-kit', 1.5], ['template-mobile', 1, 't2'], ['product-file', 1, 'components']];

const ready = () => fs.existsSync(path.join(GOLDENS_DIR, 'index.json')) && renderWasmAvailable();

test('the CPU path matches the Canvas2D goldens outside text within the SSIM bars (sample of fixtures × DPR)', async t => {
  if (engineFor('render') === 'ts') {
    t.diagnostic('render module in ts mode: the goldens are Canvas2D’s own picture; nothing to compare');
    return;
  }
  if (!ready()) {
    t.diagnostic('skipped: fixtures/goldens (scripts/goldens/render.ts) or server/design/wasm-render (scripts/wasm-render-build.sh) is missing');
    return;
  }
  const metas = goldenMetas().filter(m => SAMPLE.some(([fixture, dpr, page]) => m.fixture === fixture && m.dpr === dpr && (!page || m.page === page)));
  assert.ok(metas.length >= 4, `expected the sample goldens, found ${metas.length}`);
  const built = new Map<string, ReturnType<typeof FIXTURES[number]['build']>>();
  for (const meta of metas) {
    const fixture = FIXTURES.find(f => f.name === meta.fixture)!;
    let document = built.get(meta.fixture);
    if (!document) built.set(meta.fixture, (document = fixture.build()));
    const doc = await renderDocOf(document);
    try {
      const golden = `${meta.fixture}/${meta.page}@${meta.dpr}`;
      const {rgba, width, height, renderMs, counters} = renderLikeGolden(doc, document, meta);
      const report = await scoreAgainstGolden(path.join(GOLDENS_DIR, meta.fixture, `${meta.page}@${meta.dpr}`), rgba, width, height);
      const verdict = judge(report, DEFAULT_BARS);
      // The switch's record of the call: the golden (ts) against the renderer's score (wasm), equal when within the bars.
      const outcome = viaRenderEngine('goldens', () => 'golden', () => (verdict.ok ? 'golden' : `below the bar: ${verdict.failures.join('; ')}`), {inputs: golden});
      assert.equal(outcome, 'golden', `${golden}: outside ${report.outside.ssim.toFixed(4)}, effect ${report.effect.ssim.toFixed(4)} — ${verdict.failures.join('; ')}`);
      assert.equal(counters.missingPictures, 0, `${golden}: every picture registered`);
      assert.ok(counters.nodes > 0, `${golden}: nodes painted`);
      if (meta.fixture === 'effects') {
        // The effects page goes through the effect paths: shadows and blurs as effect bitmaps, background blur as backdrops.
        assert.ok(counters.effectBitmaps >= 10, `${golden}: ${counters.effectBitmaps} effect bitmaps`);
        assert.ok(counters.backdrops >= 1, `${golden}: ${counters.backdrops} backdrops`);
      } else if (meta.fixture === 'template-mobile' || meta.fixture === 'product-file') {
        assert.equal(counters.backdrops, 0, `${golden}: no background blur on this page`);
      }
      t.diagnostic(`${golden}: ${width}×${height} in ${renderMs.toFixed(0)} ms, outside ${report.outside.ssim.toFixed(4)}, effect ${report.effect.windows ? report.effect.ssim.toFixed(4) : '—'}, text ${report.text.windows ? report.text.ssim.toFixed(3) : '—'} (not judged), ${counters.nodes} nodes, ${counters.effectBitmaps} effect bitmaps`);
    } finally {
      doc.free();
    }
  }
});

test('the renderer reads the document as patches: a patched node moves, the bounds follow', async t => {
  if (engineFor('render') === 'ts' || !renderWasmAvailable()) {
    t.diagnostic('skipped: render module in ts mode or no renderer build');
    return;
  }
  const fixture = FIXTURES.find(f => f.name === 'template-mobile')!;
  const document = fixture.build();
  const doc = await renderDocOf(document);
  try {
    const page = document.pages[0];
    const id = document.nodes[page].children![0];
    const before = Array.from(doc.bounds(page, id));
    assert.equal(before.length, 4);
    const node = document.nodes[id];
    doc.apply_patch(JSON.stringify({nodes: {[id]: {...node, x: node.x + 100}}}));
    const after = Array.from(doc.bounds(page, id));
    assert.ok(Math.abs(after[0] - before[0] - 100) < 1e-6, `moved by 100: ${before[0]} → ${after[0]}`);
    assert.equal(doc.version(), 1);
    doc.apply_patch(JSON.stringify({nodes: {[id]: null}}));
    assert.equal(Array.from(doc.bounds(page, id)).length, 0, 'a removed node has no bounds');
  } finally {
    doc.free();
  }
});
