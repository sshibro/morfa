# Decision: the text shaper of `crates/text`

2026-10-08. Status: **decided — harfrust + skrifa** (one parser, `read-fonts`); woff2 decoded in
Rust with `wuff`. Numbers below are from this Mac (M-series, arm64, Rust 1.99, release profile of the
workspace: `opt-level = "s"`, fat LTO, `wasm-opt -Os`). Harness: `crates/text/bakeoff/` (not a workspace
member; `cargo run --release --manifest-path crates/text/bakeoff/Cargo.toml --features all -- . [--quick]
[--verbose]`, `--dump-json . rows.json`, then `node crates/text/bakeoff/chrome-measure.mjs --json rows.json
out.json` and `node crates/text/bakeoff/compare-chrome.mjs out.json`). Raw outputs: `output/L3/t1-*.md`
(not in git).

## Candidates

| | Shaping | Outlines / metrics | Parser(s) | Notes |
|---|---|---|---|---|
| A | `rustybuzz` 0.20 | `ttf-parser` 0.25 | one (`ttf-parser`) | the brief's reference; the smallest |
| B | `harfrust` 0.14 | `skrifa` 0.48 | one (`read-fonts` 0.45) | HarfBuzz port on fontations (Google's parser, the one Chrome is moving to) |
| C | `swash` 0.2 | `swash` | one | parley's shaper (parley 0.11 = swash + its own layout) |
| D | `cosmic-text` 0.19 | `swash` | two (`ttf-parser` + `swash`) | shapes with rustybuzz → advances identical to A; size only |
| E | `parley` 0.11 | `swash` | one | shapes with swash → advances identical to C; size only |

D and E also bring their own line breaking and layout, which Morfa cannot use: the layout algorithm is
the TypeScript one (`shared/design/text-layout.ts` is the oracle for T2; greedy breaking, Russian dash rules,
Figma's half-leading), so only the shaper and the outline reader matter.

## T1 — per-cluster advances against the brief's reference (rustybuzz)

Corpus: 57 strings — Cyrillic pangrams, Latin pangrams, mixed scripts with digits and "₽", kerning pairs
(АТ, Ту, AV, To, ГА, Ya, Wa, LT, ДУ, Ьт, Ау, ТА, АУ), ligatures (fi, ffl, fl, ffi, office, affluent, fjord, Th),
combining marks (е́, й, ö decomposed, a̋ stacked), emoji (👍🏽, 🇷🇺, a ZWJ family, «Текст 😀 ещё»), Russian
typography ("№ 12 345,67 ₽", «ёлочки» — тире, 2-3 x/y, северо-запад, д’Артаньян), spaces (space, NBSP,
tab) and all-caps lines. Faces: every file under `public/fonts` (250 woff2 → 250 TTF; `woff2-patched`
decodes 248, `wuff` the two Roboto Flex instances fontTools pinned), variable faces at every weight of
{300, 400, 500, 700, 900} inside their range: **584 faces, 303 560 clusters**. A cluster passes when the pen
position at its start is within 1/64 em of the reference's.

| Candidate | Clusters | Failures (> 1/64 em) | Worst | Outline bbox ≠ reference (> 1 unit) | ns / cluster | Parse ms / face |
|---|---|---|---|---|---|---|
| A rustybuzz + ttf-parser (self) | 303 560 | 0 | 0 | 0 | 277 | 0.006 |
| B harfrust + skrifa | 303 560 | 2 489 (0.82 %) | 9.0 / 64 em | 3 | 242 | 0.006 |
| C swash | 303 560 | 7 735 (2.55 %) | 94.7 / 64 em | 523 | 112 | 0.000 (lazy) |

Where B differs from A: only variable faces away from their default weight (Inter 700/900 "quartz,",
Lora 500/700 "WWW", "AV", "Wa", Caveat 700 «Ау», Alumni Sans 900 "L T", Geist 900, Merriweather, Jost, EB Garamond…),
always on a **kerning pair**. Where C differs: the same pairs plus combining marks the face lacks (swash drops
them, HarfBuzz gives them `.notdef`) and the tab (swash: 0, HarfBuzz: the space glyph). The three bbox
mismatches of B are Caveat's composite glyphs at wght 700 (skrifa and ttf-parser place one component 1–2
units apart); swash's 523 are its own scaler's rounding.

## Who is right: Chrome's `measureText` as the oracle

The product is judged against Canvas2D (the text checks T3/T4), so the same strings were measured in
headless Chromium 141 (`FontFace` from the woff2, `textRendering: geometricPrecision`, 1000 px, converted to
font units). Only strings every character of which the face's `cmap` covers compare (Chrome falls back to a
system font for the rest, which no shaper can know); tabs excluded (Blink measures them as spaces).

| Candidate | Strings (face × weight × text) | Outside 1/64 em of Chrome | Worst |
|---|---|---|---|
| A rustybuzz + ttf-parser | 12 858 | 94 (0.73 %) | 9.0 / 64 em |
| **B harfrust + skrifa** | 12 858 | **0** | 0.62 / 64 em (Chrome's float rounding) |
| C swash | 12 858 | 179 (1.39 %) | 38.4 / 64 em |

So the brief's reference is the one that is wrong: rustybuzz 0.20 does not apply the GPOS variation deltas
of kerning pairs at non-default weights (Inter Bold "quartz," is 63/2048 em narrower in Chrome and in
harfrust than in rustybuzz; Lora Medium "W" kerns 18 units less). Those are exactly the headings designers
set — bold weights of variable faces — so A would fail T3 line widths on them. harfrust matches Chrome on
every covered string.

Metrics: Chrome's `fontBoundingBoxAscent/Descent` are the face's hhea ascender/descender scaled and
**rounded to whole px** (Inter at 1000 px: 969 / 241 from 1984 / −494 at 2048 upem) — `crates/text`
reproduces that rounding (T3).

## Size (wasm32, release, after `wasm-opt -Os`; the probe keeps parse + shape + outline reachable)

| Build | raw | wasm-opt -Os | gzip -9 |
|---|---|---|---|
| A rustybuzz + ttf-parser outlines | 737 755 | 595 110 | 241 556 (235.9 KiB) |
| B harfrust + skrifa (default features) | 1 736 828 | 1 145 239 | 427 100 (417.1 KiB) |
| B harfrust + skrifa (`std` only, no autohint) | 1 735 936 | 1 145 124 | 427 261 (417.2 KiB) |
| C swash (shaping + outlines) | 1 197 754 | 790 834 | 285 498 (278.8 KiB) |
| E parley (swash + layout) | 1 257 563 | 879 046 | 351 793 (343.5 KiB) |
| `woff2-patched` decoder (full `brotli`) | 290 447 | 232 456 | 107 015 (104.5 KiB) |
| `wuff` decoder (`brotli-decompressor`) | 261 178 | 218 301 | 101 313 (98.9 KiB) |

| skrifa alone (parse, cmap, outlines at a variation) | 769 670 | 467 556 | 166 859 (162.9 KiB) |
| D cosmic-text (rustybuzz + swash + its layout) | 1 267 845 | 879 275 | 343 954 (335.9 KiB) |
| B with `opt-level = "z"` instead of `"s"` | 1 851 698 | 1 058 683 | 397 400 (388.1 KiB) |

So of B's 417 KiB, harfrust is ≈ 254 KiB and skrifa ≈ 163 KiB; `opt-level = "z"` saves 29 KiB (a workspace
profile change affecting the whole workspace). In the real `morfa-wasm` build the text engine ships
629.8 KiB gzip: B 417 + `wuff` 99 + layout, carets, segmentation and serde ≈ 115.

## Decision

**B: harfrust + skrifa.** Fidelity decides: it is the only candidate within 1/64 em of Chrome on every
covered string, including variable kerning, and its outlines come from the same parser and the same
variation location as its advances (no second parser to disagree). It costs 417 KiB gzip against A's 236 —
a real price inside the 700 KiB editor ceiling, recorded with the hot spots
(harfrust's complex-script shapers and skrifa's CFF2 + hinting are compiled in without being used; a
feature-trimmed fork or `read-fonts`-only glyf outlines are the "further wins" to try). Speed is a wash:
242 vs 277 ns per cluster natively, both far under the measurer budget (heavyPage's 3 200 texts shape in
≈ 1 ms before caching).

Not A: wrong on bold variable headings (T3 would list every such node). Not C/D/E: swash misses marks
and variable kerning; parley and cosmic-text bring a layout Morfa does not use.

## Font files: how Rust gets decodable faces

The catalogue is woff2 (`public/fonts`, from `@fontsource*` and `assets/fonts`; `scripts/copy-fonts.ts`).
Options: (1) ship TTF/OTF beside the woff2 — needs a woff2 decoder at copy time (no fontTools on this Mac;
`wawoff2` would be a new npm dependency) and the browser would download every face twice (woff2 for
`FontFace`, TTF for Rust; 6.1 MB → 13.9 MB on disk); (2) decode woff2 in Rust — `wuff` adds 99 KiB gzip once,
and one `fetch` serves both `new FontFace(name, bytes)` and the Rust store. **Decision: (2), `wuff`**
(pure Rust, `brotli-decompressor` only; decoded all 250 files, 0.5 ms per file natively). `woff2-patched`
rejects the two Roboto Flex instances. If the budget forces it, (1) remains possible later without touching
`crates/text`'s API: `text_add_face` takes sfnt or woff2 bytes.

## What this means for the text engine

- `Measurer` = shaped advances from harfrust at the face's variation location, subset faces chosen per
  character as CSS does (unicode-range, then `cmap`); characters no face covers stay on Canvas2D
  (fallback fonts), listed per glyph class.
- Glyph outlines from skrifa at the same location, cached as `Path2D` per (face, glyph) in the renderer.
- T1 is reported twice: against rustybuzz (the brief's letter: 2 489 clusters differ, all explained
  by rustybuzz's variable-kerning bug) and against Chrome (0 differ).
