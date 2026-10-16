# Renderer decision memo

Written 2026-10-08 on a development Mac: Apple M4 Pro, 14 CPU cores, 20 GPU cores, Metal 4, 24 GB. Browser
measurements: Playwright's Chromium 153 on this Mac in the **new headless mode with WebGPU flags**
(`--enable-unsafe-webgpu --enable-features=WebGPU --ignore-gpu-blocklist`, `channel: 'chromium'`), which runs on the real
Apple GPU (the spike's WebGPU probe reported adapter "apple metal-3", WebGL2 "ANGLE Metal Renderer: Apple M4 Pro"); the
plain headless shell has no WebGPU and draws WebGL2 in SwiftShader, so it was used only for the goldens, where software
rendering is wanted. Other builds ran on the same machine that night: the 1-minute load average was 5–26 at every
measurement, **so every number below is provisional** (marked so in the spike's result files). The rankings held
across three runs; the absolute frame times should be re-taken on a quiet machine and on the M1 stand-in before any row
of TARGETS.md closes.

## Page one (summary)

**The question.** Which drawing engine should Morfa's canvas use for the next years: Figma-class files (100 000–500 000
layers), smooth pan and zoom on an ordinary laptop, exports and thumbnails on the server without a browser, inside a
700 KiB download budget for the editor.

**What was measured** (all drawing the same pictures from the same files; details below):

1. **Today's renderer** — Canvas2D, tiled and cached (what the editor ships now).
2. **vello** ("compute") — the Rust GPU renderer of the Linebender project, through WebGPU.
3. **vello_hybrid** ("sparse strips") — the newer Rust renderer of the same project: the CPU prepares the geometry,
   the GPU paints; it runs on **WebGPU and on WebGL2** (the fallback for browsers without WebGPU).
4. **vello_cpu** — the CPU twin of vello_hybrid (same code), for the server: exports and thumbnails.
5. **tiny-skia** — a small Rust port of Skia's rasterizer, CPU only (the other server option).
6. **Skia itself** (CanvasKit, Google's WebAssembly build) — measured for size only; it was out before the race.

**The numbers that decide** (M4 Pro, canvas 1440 × 900 at DPR 2; "1×" = one screen of the page in view, "fit" = the
whole page in view; the 100 000-layer page is B0's `f100k` shape):

| | Today (Canvas2D tiles) | vello (compute, WebGPU) | vello_hybrid WebGPU | vello_hybrid WebGL2 |
|---|---|---|---|---|
| Download, gzip (brotli) | 0 — in the browser | 468 KiB (346) | 297 KiB (240), both GPU paths in one file | same file |
| Pan at 1×, 20k and 100k layers | 60 fps | 60 fps | 60 fps | 60 fps |
| **Whole page in view, 20k layers** | 60 fps (cached tiles) | **60 fps**, 3 ms a frame | **10 fps**, 94 ms a frame | 11 fps |
| **Whole page in view, 100k layers** | 60 fps (cached tiles) | **60 fps**, 10 ms a frame | 16 fps, 61 ms | 16 fps |
| The same with the CPU slowed 4× (laptop stand-in) | 60 fps | 60 fps (20k) / 24 fps (100k) | 2.4 fps / 3.7 fps | 2.7 / 3.8 fps |
| Pan at 1×, CPU slowed 4× | 60 fps | 60 fps | 48 fps (20k) / 39 fps (100k) | 49 / 37 fps |
| Picture while zooming | soft (stretched tiles), sharp 130 ms after the gesture | sharp every frame | sharp every frame | sharp every frame |
| First picture, 100k layers | 156 ms | 452 ms, of which 279 ms is the spike's JSON | 310 ms (267 JSON) | 448 ms |
| Fidelity vs today's picture (SSIM; 1 = identical) | 1 | 0.98–0.9995 outside effects; one blank frame | 0.98–0.9995 | same as WebGPU |
| Shadows, blur, inner shadows | all | box shadows only; blur and inner shadows need a pass of our own | all (blur filters, inner shadows) | all |
| Works without WebGPU | yes | **no** | yes | yes |
| Same pixels for server exports | no (needs a browser) | no CPU twin | **yes** (vello_cpu) | yes |

Skia/CanvasKit: 7.3 MB of WebAssembly (2.9 MB gzip, 2.3 MB brotli) — four times the editor's whole budget on its own,
before fonts, and a C++ island beside our Rust crates with a separate build for the server. Ruled out.

**Recommendation.** Build the renderer on **vello (compute) through WebGPU as the main engine, inside today's tile
architecture; keep today's Canvas2D as the engine for browsers without WebGPU; use vello_cpu on the server for exports
and thumbnails** — all three fed by one display list (the spike already builds it). The hybrid/sparse-strips family was
the night's hope (one engine for GPU, WebGL2 and server, blur included), and it draws exactly what the CPU twin draws,
but its rasterization runs on the CPU: a full view of a 20 000-layer page costs it 90 ms a frame on an M4 Pro and
400 ms with the CPU slowed 4×, where vello (compute) spends 3 ms and 11 ms. That is the difference between "Figma-class"
and "what we have". The price of vello is a blur pass we write ourselves (render the node to a texture, blur, composite —
the same pass background blur needs on every engine anyway) and no WebGL2: for browsers without WebGPU (≈ Firefox on
Linux and on Intel Macs, Safari before 26, old Yandex/Chrome builds) the existing Canvas2D renderer stays as it is, so
nobody loses the editor. The hybrid's WebGL2 backend stays on the shelf as a later replacement for that fallback if its
raster speed improves (the crates are young) or if the fallback share proves to matter.

**Risks.** (1) vello is a 0.x crate too: we hit an empty frame on the effects page at DPR 2 (a
buffer-overflow mode of its simple render path; the robust path exists and costs a readback). (2) Text is the text engine's (`docs/decisions/text-shaper.md`); the GPU
spikes drew text as bars tonight, so the fidelity numbers exclude text, and the Canvas2D numbers are shown with and
without text. (3) The browser-side build is 468 KiB gzip tonight with the spike's JSON parser in it; the renderer must be
a lazily loaded chunk and its size promise is written before step 2 starts (§2). (4) WebGPU availability: shipped in
Chrome/Edge/Yandex (Chromium 113+), Safari 26 (September 2025), Firefox on Windows and Apple-silicon Macs; the Canvas2D
fallback covers the rest.

**Calendar for step 2** (after approval): three to four weeks. Week 1: the display list for real (exact geometry,
from the shadow document) and vello_cpu passing every golden in the unit tests, the size promise. Week 2: tiles on the
GPU (vello, WebGPU), seams checked, the blur pass. Week 3: text through the text engine, the performance bars on this Mac and the 2×
stand-in, the switch behind `withEngine('render')` with Canvas2D kept as the fallback engine. Week 4 (overlaps the server export work):
exports on the server with vello_cpu. Details in §10.

---

## Technical part

### 1. What was built tonight

- `scripts/goldens/` — the golden harness: 9 fixtures (an `effects` page with every paint, effect, mask and stroke kind;
  the 20 041-layer page; the product file; the starter templates), painted by today's `paintNodeTree` in headless
  Chromium at DPR 1 / 1.5 / 2 with text and effect masks; SSIM (11 × 11 Gaussian window, σ 1.5) judged per region. Two
  runs are byte-identical. Sensitivity (the spike's SSIM probe): a 1 px shift scores 0.96, a σ 0.8 blur 0.987
  (both fail the 0.995 bar), a different antialiasing of the same geometry 0.998 (passes). SSIM is blind to a uniform
  2 % brightness change (0.997); a mean-luma check should join it in step 2.
- The spike (its own Cargo workspaces, not part of this repository) — one display list (`dl.rs`, built by `web/display-list.ts` in painter order) drawn by four
  spikes: `vello-web` (vello 0.11 on wgpu 30, WebGPU), `hybrid-web` (vello_hybrid 0.2 on wgpu 29 and its WebGL2
  backend), `cpu` (vello_cpu 0.3 and tiny-skia 0.12 to PNG). `web/bench.ts` + `bench.mts` run the scenarios against
  today's renderer (`createSceneRenderer`) in the same page; `--throttle 4` applies Chromium's CPU throttle (the GPU is
  not throttled). wgpu never enters `crates/*` or the gate.

### 2. Sizes (what the editor would download)

| Build | raw | gzip -9 | brotli -11 | of the 700 KiB budget (gzip) |
|---|---|---|---|---|
| vello 0.11 + wgpu 30 (WebGPU only) + serde_json | 1 455 167 B | 468 KiB | 346 KiB | 67 % |
| vello_hybrid 0.2 + wgpu 29 (WebGPU **and** WebGL2) + serde_json | 821 481 B | 297 KiB | 240 KiB | 42 % |
| CanvasKit 0.42 (Skia, WebGL2 build) | 7 317 345 B | 2 934 941 B | 2 272 275 B | 419 % |
| CanvasKit 0.42 "full" | 8 242 911 B | 3 284 650 B | 2 539 445 B | 469 % |
| today's engine wasm (S0 baseline, `version()` only) | 14 282 B | 6.3 KiB | — | 0.9 % |

A "slim" vello build without wgpu's `wgsl` feature was tried and is not possible: vello hands wgpu WGSL source, which needs
naga's front end; the size floor of vello + wgpu on the web is therefore close to the row above minus serde_json
(≈ 60 KiB gzip). Both Rust builds carry `serde_json` and a JSON display list; the production renderer reads the shadow document (S2)
instead, so those bytes go away. The budget rule (`scripts/wasm-build.sh`) counts wasm + glue gzip against 700 KiB
together with the editor's JS, which is most of the budget today: the renderer must be a lazily loaded chunk fetched
with the file, and its size is written down as a promise before step 2 starts. Half of vello's bytes are wgpu and
its WGSL shaders (text); `opt-level = "s"` and `wasm-opt -Os` were already on.

### 3. Frames

Setup: canvas 1440 × 900 CSS px at DPR 2 (2880 × 1800 device px), `requestAnimationFrame` deltas over 600 frames (pan,
overview) or 240 frames (zoom, overzoom) after 90 warm-up frames; "render" is the JS-side time of one `render()` call;
"encode" the Rust scene build inside it. Scenes: `heavy-page` = f20k (20 041 nodes → 17 320 display-list items),
`gen-100000` = f100k (100 201 nodes → 86 600 items; the same shape as B0's `gen-file --kind page`). Scenarios: **pan**
at zoom 1 (one screen, ≈ 190 items in view), **zoom** 1× → 4× → 1× around a screen, **overview** = the whole page in view
with a 4 px jitter, **overzoom** = pinch between fit and 2× fit. The GPU spikes are immediate mode: they cull to the view
and re-encode every visible item every frame — they carry no tile cache, so "overview" is their raw cost per frame.
Today's renderer composites cached tiles, so its steady frames are a copy; its raster cost shows in "first picture" and
in "sharp after" (the time after a zoom gesture until every visible tile is re-rasterized at the exact scale).

**1×, no throttle** (load 5–18; `results/bench-2026-10-08T00-27-11.json`)

| Scene · scenario | Today, with text | Today, no text | vello (compute) | hybrid WebGPU | hybrid WebGL2 |
|---|---|---|---|---|---|
| f20k · first picture | 37 ms | 25 ms | 116 ms (wasm 40 + create 10 + list 33 + parse 28 + render 6) | 106 ms (28 / 4 / 33 / 28 / 13) | 149 ms (28 / 58 / 33 / 25 / 7) |
| f20k · pan: fps, frame p99, render p50/p99 | 60, 16.8, 0.3/2.1 ms | 60, 16.8, 0.2/2.0 | 60, 16.8, 1.0/1.7 (encode 0.5/1.0) | 60, 16.8, 5.1/6.5 (4.4/5.8) | 60, 16.8, 4.9/6.5 (4.7/6.1) |
| f20k · zoom | 60, 16.8, 0.1/0.4; sharp after 0 ms | 60, 16.8, 0.1/0.3 | 60, 16.8, 1.0/2.2 | 60, 16.8, 3.1/5.7 | 60, 16.8, 2.5/5.1 |
| **f20k · overview** (16 440 items in view) | 60, 16.8, 0.1/0.3 | 60, 16.8, 0.2/0.4 | **60, 16.8, 3.2/3.7** (2.4/2.9) | **10.5, 100, 94/99** (92/97) | **11.4, 100, 87/95** (86/90) |
| f20k · overzoom | 60, 16.8, 0.1/8.1; **sharp after 132 ms** | 60, 16.8, 0.1/1.5; sharp 133 ms | 60, 16.8, 2.1/3.0 | 13.9, 100, 73/97 | 15.5, 83, 65/88 |
| f100k · first picture | 156 ms | 111 ms | 452 ms (40 / 119 / 164 / 115 / 14) | 310 ms (28 / 3 / 164 / 103 / 11) | 448 ms (28 / 69 / 164 / 178 / 9) |
| f100k · pan | 60, 16.8, 0.2/2.7 | 60, 16.8, 0.2/2.1 | 59.6, 16.8 (max 83), 1.8/3.9 | 60, 16.8, 6.2/7.5 | 60, 16.8, 5.9/7.3 |
| f100k · zoom | 60, 16.8, 0.1/1.6 | 60, 16.8, 0.1/1.4 | 59.5, 16.8 (max 50), 1.7/7.3 | 60, 16.8, 4.3/7.1 | 60, 16.8, 4.1/6.6 |
| **f100k · overview** (82 200 items in view) | 60, 16.8, 0.1/0.6 | 60, 16.8, 0.1/0.5 | **60, 16.8, 9.7/11.3** (9.2/10.4) | **16.3, 66.8, 61/66** (57/60) | **16.2, 66.8, 61/64** (58/61) |
| f100k · overzoom | 60, 16.8, 0.1/1.0; sharp after 133 ms | 60, 16.8, 0.1/0.4 | 59.8, 16.8 (max 33), 7.3/10.1 | 6.2, 250, 184/252 | 6.3, 250, 185/243 |

**CPU slowed 4×** (TARGETS §0's stand-in rule is 2×; 4× was run to see the slopes; `results/bench-throttle4-…json`)

| Scene · scenario | Today, with text | vello (compute) | hybrid WebGPU | hybrid WebGL2 |
|---|---|---|---|---|
| f20k · first picture | 112 ms | 393 ms (76 / 26 / 142 / 126 / 23) | 426 ms | 561 ms (create 191) |
| f20k · pan | 60 fps, p99 16.8, render 0.3/4.2 | 60, 16.8, 2.3/3.9 (encode 1.2/2.0) | **48.4, 33.4**, 19.6/25.6 (16.6/22.1) | 49.1, 33.4, 19.2/25.3 |
| f20k · overview | 60, 16.8, 0.1/1.0 | **60, 16.8, 11.3/14.2** (8.2/9.9) | **2.4 fps, 450 ms**, 409/446 | 2.7, 400, 365/403 |
| f100k · first picture | 594 ms | 1 703 ms (76 / 108 / 913 / 558 / 48) | 1 556 ms | 1 820 ms |
| f100k · pan | 59.8, 16.8 (max 33), 0.6/9.5 | 59.4, 16.8 (max 67), 6.9/9.4 | **39.0, 33.4**, 24.6/32.2 | 37.2, 33.4, 25.7/34.6 |
| f100k · overview | 59.7, 16.8 (max 50), 0.2/1.8 | **24.0, 50.1**, 40.5/47.7 (encode 38.4/44.7) | 3.7, 317, 261/308 | 3.8, 283, 257/287 |

**Raster throughput from a cold tile cache** — the first picture at the fit zoom, where every layer is in view; today's
renderer here rasterizes every tile under the view within its first-paint budget, the spikes draw one frame:

| Scene | Today, with text | Today, no text | vello (compute) | hybrid WebGPU | hybrid WebGL2 |
|---|---|---|---|---|---|
| f20k at fit zoom (16 440 items in view) | 203 ms | 195 ms | 103 ms, of which **8 ms** is the render (wasm 22 + create 7 + list 37 + parse 29) | 228 ms, **113 ms** render | 207 ms, 88 ms render |
| f100k at fit zoom (82 200 items) | 470 ms | 401 ms | 303 ms, **15 ms** render (22 / 4 / 160 / 103) | 409 ms, **70 ms** render | 385 ms, 69 ms render |

So for the same picture from nothing: today's renderer ≈ 200 / 400–470 ms (its tiles, text included, first-paint budget
120 ms a frame), the hybrid 70–113 ms, vello 8–15 ms. The hybrid rasterizes about twice as fast as today's Canvas2D
tiles and vello 15–30 times. (`results/bench-2026-10-08T00-47-42.json`)

Reading the tables:

- **At 1× zoom every engine is at 60 fps**: the viewport holds ≈ 190 items. Today's renderer copies cached tiles
  (0.1–0.3 ms); vello re-encodes the visible items in 0.5–1.5 ms; the hybrid needs 4.4–6.2 ms **for 190 items** — its
  per-frame floor is the strip rasterization of the full-screen background and of every visible shape on the CPU, and
  at 4× throttle that floor (17–25 ms) alone breaks 60 fps on the one-screen pan.
- **The whole page in view separates the engines.** vello (compute) encodes 16 440 items in 2.4 ms and 82 200 in
  9.2 ms and the GPU keeps up at 60 fps; at 4× throttle it holds 60 fps on f20k and drops to 24 fps on f100k, CPU-bound in
  its encoder (38 ms), which a tile cache removes from the steady state. The hybrid is at 10–16 fps unthrottled and
  2–4 fps throttled: CPU strips over 5 Mpx of 16–82 thousand shapes. Today's renderer shows 60 fps in that row because
  its tiles were rasterized during warm-up; the honest comparison is the fit-zoom first picture above and the
  132 ms it needs to get sharp after a zoom gesture.
- **Zoom**: today's renderer stays at 60 fps by showing stretched tiles and re-rasterizing within an 8 ms budget;
  the picture is sharp again ≈ 130 ms after the gesture ends. The GPU spikes draw the exact scale every frame.
- **First picture** of f100k: 156 ms today; the spikes spend most of their 310–450 ms on building (164 ms) and parsing
  (103–178 ms) a 12 MB JSON display list — the spike's transport, not the renderer; the shadow document removes it.
  Pipeline creation: vello 10–119 ms (WebGPU compiles lazily), hybrid WebGPU 3–5 ms, hybrid WebGL2 58–191 ms (and 1.5 s
  on the first run of the night, before the driver's shader cache was warm).

### 4. Memory

Measured with `performance.memory.usedJSHeapSize` (JS heap), the wasm module's linear memory, and today's tile canvases
(`RenderStats.tileBytes`), at the end of each scenario, 1× no throttle.

| Scene | Today: heap / tile canvases | vello: heap / wasm memory | hybrid WebGPU: heap / wasm | hybrid WebGL2: heap / wasm |
|---|---|---|---|---|
| f20k | 55–81 MB / 126–246 MB | 51 MB / 100–125 MB | 52–54 MB / 101–105 MB | 52 MB / 105–130 MB |
| f100k | 231–254 MB / 74–246 MB | 220 MB / 414–482 MB | 221 MB / 415–629 MB | 221 MB / 796 MB |

The spikes' wasm memory holds the parsed JSON display list and its kurbo paths (f100k: 12 MB of JSON becomes
≈ 400 MB of Rust objects — the spike keeps `String`s and `Vec`s per item; a packed list is a tenth of that) and, for the
hybrid, its strip buffers (the WebGL2 variant keeps a second copy). Not representative of step 2, where the list is
built from the shadow document per dirty tile and the tile atlas replaces the tile canvases byte for byte. The JS heap
of 220–250 MB at f100k is the document itself, the same in every column. TARGETS C10 (≤ 700 MB at f100k) is
measurable only in step 2.

### 5. Fidelity (SSIM against the goldens)

Masks: text is excluded; "effect" is where shadows and blurs reach (bar 0.98); "outside" is everything else
(bar 0.995). The GPU spikes drew text as bars, so only `outside` and `effect` are meaningful; `effects` is the fixture
built for this (blend modes, drop/inner shadows with spread and knock-out, layer and background blur,
alpha/vector/luminance masks, four gradient kinds, pictures in four scale modes, dashes, markers, booleans).

Page one of the fixtures, SSIM per region (DPR 1 / DPR 2). "hybrid" = vello_hybrid on WebGPU; the WebGL2 backend gave the
same digits on every row, and vello_cpu's PNGs match the hybrid's to four decimals (effects @1: 0.9813 / 0.9601 against
0.9813 / 0.9600) — the "same pixels on the server" promise of the sparse-strips family holds.

| Fixture | Region | Today (reference) | vello (compute) | vello_hybrid WebGPU = WebGL2 | vello_cpu | tiny-skia (own compositor) |
|---|---|---|---|---|---|---|
| `effects` (128 nodes, every effect kind) | outside | 1 | 0.984 / **blank frame** | 0.981 / 0.987 | 0.981 / 0.987 | 0.923 / 0.953 |
| | effect | 1 | 0.895 / — | 0.960 / 0.966 | 0.960 / 0.966 | 0.721 / 0.822 |
| `template-site` (184) | outside | 1 | 0.9964 / 0.9992 | 0.9964 / 0.9992 | 0.9964 / 0.9992 | 0.9964 / 0.9992 |
| | effect | 1 | 0.919 / 0.949 | 0.919 / 0.949 | 0.919 / 0.949 | 0.919 / 0.949 |
| `template-mobile` (473) | outside | 1 | 0.992 / 0.9955 | 0.992 / 0.9956 | 0.992 / 0.9956 | 0.9925 / 0.9957 |
| | effect | 1 | 0.989 / 0.992 | 0.993 / 0.9935 | 0.992 / 0.993 | 0.9987 / 0.998 |
| `product-file` "Screens" (12 502, 240 background blurs) | outside | 1 | 0.992 / 0.9995 | 0.998 / 0.9995 | (294 Mpx page, 1.1 s; not scored) | — |
| | effect | 1 | 0.938 / 0.998 | 0.997 / 0.998 | | |

How to read it: on fixtures without shadows the engines are pixel-close to Canvas2D (`outside` 0.9955–0.9995 at DPR 2
with text still drawn as bars, which spill past the text mask's 2 px slack and at line ends). `effect` fails on every
candidate tonight because the exporter approximates what painter.ts does exactly: a shadow of a stroke-only shape or of
text is a filled box, knock-outs behind translucent fills are not cut, `template-site`'s 14 per-side stroke weights became
uniform, markers and variable-width strokes were dropped. Those are geometry the step-2 list emits exactly, not engine
limits; the engine limits are the ones in §6 (vello: no inner shadow, no layer blur — 9 and 4 skipped on `effects`;
hybrid: luminance mask drawn as alpha; nobody: background blur, diamond gradient, image filters). vello at DPR 2 on
`effects` returned an empty frame (§9).

Approximations the exporter counted (`approx` in the results): `effects`: shadowKnockout 3, shadowOfStrokeBand 1,
textShadowAsBox 2, shapeShadowAsBox 1, backgroundBlur 2, luminanceMask 1, diamondGradient 1, imageTile 1, imageFilters 1,
textStroke 1, individualStrokeWeights 1, markers 2, variableWidthStroke 1, booleanFallback 2. `template-site`:
individualStrokeWeights 14. `template-mobile`: 5. `product-file`: backgroundBlur 240, shadowKnockout 40. Pictures and
lists: the spike's `results/fidelity/` (not part of this repository).

### 6. Effect support by engine (from the sources read tonight, versions pinned)

| Capability | Canvas2D today | vello 0.11 | vello_hybrid 0.2 | vello_cpu 0.3 | tiny-skia 0.12 | Skia/CanvasKit |
|---|---|---|---|---|---|---|
| Paths, even-odd, strokes with caps/joins/dashes | yes | yes | yes | yes | yes | yes |
| Blend modes (16) | yes | yes (`Mix`) | yes | yes | yes | yes |
| Opacity / clip layers | yes | yes | yes | yes | by hand (own pixmap stack) | yes |
| Luminance mask | by pixels | `push_luminance_mask_layer` | **no** (`unimplemented!`) | `Mask::new_luminance` | by hand | yes |
| Gradients linear / radial / angular / diamond | yes / yes / conic / shader by hand | yes / yes / sweep / **no** | yes / yes / sweep / no | same | yes / yes / **no** / no | yes / yes / yes / no |
| Drop shadow of a rounded rect | yes | `draw_blurred_rounded_rect` | `fill_blurred_rounded_rect` | same | own blur | yes |
| Drop shadow of any shape, inner shadow with spread | yes | **no** (our pass) | inner: `invert` blur; any shape: filter layer | same | own blur | yes |
| Layer blur | yes (`filter`/box blur) | **no** (our pass) | `push_filter_layer(Blur)` | yes | own blur | yes |
| Background blur | yes (reads the backdrop) | no | no (filters see their own layer) | no | by hand | by hand (backdrop filter) |
| Images, mips | yes | `ImageBrush`, `register_texture` for wgpu textures | atlas upload | pixmap | `Pattern` | yes |
| Text | `fillText` (browser shapes) | glyph outlines via skrifa | `glyph_run` (glifo) | same | outlines by hand | own shaping (fonts shipped) |
| GPU without compute (WebGL2) | n/a | **no** | **yes** | — | — | yes |
| CPU twin | no | no | **vello_cpu** | — | itself | skia-safe (C++ build) |
| Failure mode seen tonight | — | empty frame on buffer overflow | panics on image opacity (0.2) | — | — | — |

Background blur is nowhere native except Canvas2D: in step 2 it is a render-to-texture pass (copy the backdrop under the
shape, blur, composite) in our tile pipeline, like today. vello's blur pass for layer blur, inner shadows and non-rect
shadows is the same machinery (render the node to a texture with a transparent base, blur with a small WGSL pipeline of
our own, `register_texture` → `draw_image`).

### 7. The CPU path (exports, thumbnails: TARGETS X1–X5)

`morfa-spike-cpu`, release build, this Mac, display lists dumped by the fidelity run (text as bars):

| Picture | vello_cpu, 1 thread | vello_cpu, `multithreading` feature (rayon) | tiny-skia (our layer compositor) |
|---|---|---|---|
| Thumbnail of the product page, 513 × 943 px (12 502 layers, 21 000 items; X1 is ≤ 300 ms at 512 px) | **8.3–8.8 ms** | 4.9 ms with 8 threads | 791 ms |
| The product page at DPR 1, 12 644 × 23 260 px = 294 Mpx | 1 114–1 158 ms (≈ 260 Mpx/s) | 699 ms (2), 339 ms (4), **206 ms (8)**, 231 ms (14 threads) — ≈ 1.4 Gpx/s | not run (minutes) |
| `effects` at DPR 1 / DPR 2 (1 260 × 1 528 / 2 520 × 3 056) | 12 ms / 45 ms | **panics**: "Filter effects are not yet supported in multi-threaded rendering" (vello_cpu 0.3 `dispatch/multi_threaded.rs:545`); single-threaded 52 ms | 856 ms / 4 544 ms |
| `template-site` at DPR 1 / DPR 2 (1 444 × 3 024 / 2 888 × 6 048) | 13.6 ms / 53 ms | | 965 ms / 4 858 ms |
| `template-mobile` at DPR 1 / DPR 2 (1 816 × 856 / 3 632 × 1 712) | 1.5 ms / 4.7 ms | 1.1 ms (8 threads) | 42 ms / 171 ms |

tiny-skia's rasterizer itself is quick; the slowness is the compositor the spike had to write around it (a full-size
pixmap per opacity/blend/clip layer, a box-blur triple of our own for every shadow), which is exactly the code we would
own forever if we picked it. vello_cpu has layers, filters and masks built in and the same encoding as the GPU hybrid.
Extrapolating 260 Mpx/s single-threaded: X2 (a 3840 × 2160 PNG of a 20k-layer frame, ≤ 1.5 s) is ≈ 40 ms plus effects,
X1 is met forty times over; on bench-ru's 4 vCPU the 4-thread column applies (339 ms for 294 Mpx). One limit found:
vello_cpu 0.3 cannot run its blur filters in the multi-threaded dispatcher (it panics), so a page with layer blur or inner
shadows renders single-threaded today — or the export service renders pages with filters on one thread per job and
parallelizes across jobs (X5 wants 20 concurrent exports anyway).

### 8. Tile integration (docs/design-tool.md §Performance keeps applying)

The renderer swap happens under `paintNodeTree`'s contract and keeps the tile cache, the live layer, the fallback levels
clipped to their holes, picture mips and the effect-bitmap cache. With vello a tile becomes a region of a texture atlas
(512 px tiles per level, whole device pixels, edge to edge) painted by one `render_to_texture` per dirty batch from the
display list culled to those tiles; compositing to the screen is a textured-quad pass (the seam rule: integer device
pixels, each edge rounded on its own). The live layer is the same engine drawing the `state.live` nodes straight to the
screen texture each frame — tonight's "pan" numbers (190 items, 1 ms) are that cost. Exports in the browser go through the
same `render_to_texture` and a readback (`read_pixels` in the spike); thumbnails and server exports run vello_cpu over the
same display list (B4). Canvas2D stays the `ts` engine behind `withEngine('render')` for browsers without WebGPU and for
`both`-mode comparisons (SSIM of tiles).

What tonight's numbers promise for the TARGETS rows, on this Mac: C1/C2 pan at 60 fps with headroom (vello's whole-view
frame is 3–10 ms, so even a fully dirty viewport re-rasters inside one frame on f20k and in two on f100k); C4 zoom at
exact scale every frame instead of stretched tiles; C3 (f500k) plausible — the encoder cost grows with items in view
(≈ 0.11 µs per item: 9.2 ms for 82 200), the GPU cost with pixels, and a tile cache bounds both; C9 first paint depends on
the display-list build from the shadow document, to be measured in week 1.

### 9. Risks

| Risk | Weight | What we do about it |
|---|---|---|
| **vello is a 0.x crate with a sharp edge.** On the `effects` page at DPR 2 vello rendered an empty frame with no error: the compute pipeline's bump allocators overflowed and the simple `render_to_texture` path is not robust against that (the robust path needs an async readback and a retry; `bump_estimate` sizes buffers up front). Minor versions change APIs (0.11 moved presentation out of the library). | high | Pin exact versions; use the robust render path and `bump_estimate`; tiles bound the scene size per render; the engine sits behind our display list, so a swap (to the hybrid, or a vello 1.0) is one file. |
| **Blur is ours.** Layer blur, inner shadows and non-rect shadows need a render-to-texture + blur pass we write (WGSL, two passes, downsample for large radii) — background blur needs it on every engine anyway. | medium | Week 2 of the plan; the effect-bitmap cache per zoom bucket keeps it off the steady frame, as today. Fidelity bar: `effect` ≥ 0.98 on the goldens. |
| **No WebGPU → no vello.** Firefox on Linux and Intel Macs, Safari < 26, and any browser with WebGPU disabled by policy. | medium | Canvas2D stays, unchanged, as the fallback engine; the display list is shared so the switch is per session. The hybrid's WebGL2 backend (240 KiB brotli, same list) can replace Canvas2D later if parity for the fallback matters more than its CPU cost. |
| **Text.** The GPU spikes drew bars. Real text needs the text engine's glyph outlines (skrifa in vello) and the browser's fonts as blobs. | medium | the text engine contract (tiers T1–T4) covers it; the renderer needs a glyph-run op in the display list. Until L3 flips, text tiles are painted by Canvas2D into the same atlas (two painters, one atlas) — also the migration path for the switch. |
| **Young crates in general.** vello_cpu 0.3 / vello_common 0.3 for the server: "not yet suitable for production" in their README; `Pixmap::from_parts` changed between 0.2 and 0.3; image opacity panics in 0.2; blur filters panic in the multi-threaded dispatcher of 0.3. | medium | Pin; vendor patches as `[patch.crates-io]`; the server path is tested against the goldens in the unit tests, so a regression shows before a release. |
| **Memory.** Tile textures on the GPU plus the display list in wasm. | medium | Tile budget from `navigator.deviceMemory` as now (96–384 MB); a packed display list (no per-item allocations) at a tenth of the spike's; C10/C11 measured in week 3. |
| **WebGPU on the desktop app.** Tauri's webview is WebKit on macOS (WebGPU from Safari 26-class WebKit) and WebView2 on Windows (Chromium: yes). | low | Same wasm; a native wgpu/Metal window is possible later with the same crate but is not needed for Phase 3. Keep web-sys behind a `web` feature; the `cpu` spike already builds natively. |
| **Figma parity of effects**: exact spread on non-rect shapes, knock-outs, stroke-band shadows, markers, individual and variable-width strokes were approximated by the exporter tonight. | low | Geometry, not engine features: the step-2 list reuses the TS geometry (the geometry crate later), as painter.ts does. |
| **The hybrid's numbers may improve.** The crates are young and the sparse-strips design targets exactly this workload. | — | Re-run `bench.mts` on each minor release; the display list and `SparseSink` replay stay in the tree. |

### 10. Build plan and calendar for step 2

Step 2 builds `crates/render` in Rust on vello (compute) + vello_cpu, keeps `paintNodeTree`'s contract and the tile rules,
and flips the canvas last, when every golden passes. One person on the Mac; the text engine's glyph drawing arriving in week 3.

| Week | Days | Work | Done when |
|---|---|---|---|
| 1 | D5–D7 | **Display list for real.** `crates/render/src/list.rs`: the spike's list as a Rust type built from the shadow document (S2) per node, with the exact geometry of painter.ts (spread paths, stroke-alignment clips, markers, per-side weights, boolean fallback) — what the exporter approximated tonight. `scripts/goldens` grows a `--engine vello_cpu` mode. | SSIM ≥ 0.995 outside / ≥ 0.98 effect on every golden **except text**, from vello_cpu, in `npm run test:design` (`tests/design-render-goldens.test.ts`, software, deterministic). |
| 1 | D7 | **Size promise.** The renderer wasm (vello + wgpu, no serde_json, lazily loaded) measured with the editor's JS against 700 KiB; the number recorded. | `scripts/wasm-build.sh` passes with the renderer chunk. |
| 2 | D8–D11 | **Tiles on the GPU.** `crates/render/src/tiles.rs`: tile atlas per level (512 px, whole device pixels), dirty tracking from `SpatialIndex`, fallback levels clipped to holes, picture mips, the live layer; the robust render path with `bump_estimate`. **The blur pass** (render-to-texture, WGSL separable blur, `register_texture`) for layer blur, inner shadows, non-rect shadows and background blur, cached per zoom bucket. Browser SSIM run on every golden through the GPU path. | `tests/design-render-{tiles,scene,blend,gradient,image,stroke,export,index}` green in `wasm` mode; no seam at 37 / 66 / 133 / 150 % at DPR 1.25 / 1.5 / 2 (screenshots in STATUS); `effect` ≥ 0.98 through the GPU. |
| 3 | D12–D14 | **Text, perf, the flip.** The text engine's glyph runs enter the list (skrifa outlines; Canvas2D text tiles into the same atlas until the text engine flips). `heavyPage()` pan/zoom at 60 fps on this Mac and on the 2× stand-in; first paint < 1.5 s; deep zoom to 256× and back without the `wip/perf/canvas` stall; C10 measured. `withEngine('render')` switch in `scene-renderer.ts`; Canvas2D stays as the `ts` engine and the no-WebGPU fallback. | TARGETS C1, C2, C4, C5, C9 yellow or green on the Mac; `both` mode compares tiles by SSIM in the e2e. |
| 4 | D15–D18 | **Exports and the server.** vello_cpu on the server for PNG/JPG/WEBP and thumbnails (B4; SVG/PDF export stay vector); X1–X3 measured on dev-4; parity with the goldens at scale 1/2/3. Multithreading on bench-ru's 4 vCPU. | export parity bars; B4 unblocked. |

Floor, not finish (TARGETS §10): after the rows pass, profile encode per tile, atlas uploads and the blur pass; take the
wins. **Day one of step 2 needs from others:** the shadow document API (`load`/`apply_patch`) to read nodes without
JSON; the text engine's glyph-run shape (or the Canvas2D text-tile bridge); the bench `gen-file` to replace `generatedPage()`; and the
size promise for the renderer chunk.

### 11. How to reproduce

```
export PATH=~/.nvm/versions/node/v22.23.2/bin:$HOME/.cargo/bin:$PATH CARGO_TARGET_DIR=~/.cache/morfa-target/L4
npx tsx scripts/copy-fonts.ts
npx tsx scripts/goldens/render.ts                          # fixtures/goldens/<fixture>/<page>@<dpr>.{png,text.png,effect.png,json}
npx tsx scripts/goldens/ssim.ts --golden fixtures/goldens/effects/page@2 <candidate.png>
```

The spike harness (WebGPU probe, the vello / vello_hybrid / vello_cpu builds, `bench.mts`) is not part of this repository.

Sources read: the crate sources in `~/.cargo/registry` (vello 0.11.0, vello_hybrid 0.2.0, vello_cpu 0.3.0, vello_common
0.2.0/0.3.0, wgpu 29/30, tiny-skia 0.12.0, peniko 0.6.1); the sparse-strips README ("under active development… not yet
suitable for production use", [linebender/vello sparse_strips](https://skia.googlesource.com/external/github.com/linebender/vello/+show/6a45f75661129aa3dcbfeeaed5bbdae2451b880e/sparse_strips/README.md));
WebGPU availability: Safari 26 shipped it everywhere in September 2025, Firefox on Windows (July 2025) and Apple-silicon
Macs (November 2025), Chrome/Edge since 113 ([summary](https://ascii.co.uk/news/article/news-20251126-7cbd345e/webgpu-now-supported-across-chrome-firefox-safari-edge),
[adoption note](https://svilenkovic.com/3d/webgpu-adoption-2026)); Yandex Browser is Chromium-based and inherits Chrome's.
