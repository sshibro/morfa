# vendor — patched copies of upstream crates

`[patch.crates-io]` in the root `Cargo.toml` points three vello crates at these directories. Each is the crates.io
source of the same version with a small change; `PATCHES.diff` is the whole difference against crates.io, kept
current (regenerate: `diff -ruN --exclude=Cargo.lock crates.io/<crate>-<version> vendor/<crate>`).

## vello 0.11.0, vello_encoding 0.11.0, vello_shaders 0.11.0 (see docs/decisions/renderer.md)

The renderer module (`crates/render-wasm`, the web build) ships vello on WebGPU. Upstream vello always links its
glyph machinery — skrifa and read-fonts outlines, autohinting, COLR and bitmap (PNG) glyphs — because glyph runs are
resolved inside `vello_encoding::Resolver`, and the CPU implementations of every compute stage for
`RendererOptions::use_cpu`. Morfa's text never goes through vello (the host paints glyphs, as sprites), so
this is 600 KB of unreachable code the linker cannot prove dead: 200 KiB gzip of a 700 KiB budget.

The patch adds two features, both **on by default** so a plain `vello` keeps upstream behaviour:

- `vello/glyphs` (→ `vello_encoding/glyphs`, `dep:skrifa`, `dep:png`): `Scene::draw_glyphs`, `DrawGlyphs`, the
  colour-glyph painter and the `OutlinePen` impl of `PathEncoder`, the `GlyphCache` of the resolver. Without it a
  `Patch::GlyphRun` resolves to nothing.
- `vello/cpu_shaders`: installs `vello_shaders::cpu::*` as the stages' CPU fallbacks; without it every stage is
  `CpuShaderType::Missing` and link-time optimisation drops the implementations (the binding types of
  `vello_shaders::cpu` stay — the engine is written against them).
- `vello_shaders`: its dependency on `vello_encoding` no longer turns `vello_encoding`'s default features on (the
  `cpu` feature pulled glyphs back in through them); and its build script embeds the WGSL without comments,
  indentation and blank lines (`minify_wgsl` in `build.rs`: 393 KB of shader text → 232 KB; WGSL has no string
  literals, so a `//` always opens a comment).

`crates/render` depends on `vello` with `default-features = false, features = ["wgpu"]`: no glyphs, no CPU shaders.
Measured on the web build of `crates/render-wasm` (scripts/wasm-render-build.sh, gzip -9): 708.3 KiB → 507.8 KiB
(glyphs and CPU shaders) → 472.9 KiB (the WGSL minified).

Upstream: https://github.com/linebender/vello (Apache-2.0 OR MIT; the LICENSE files are kept beside each copy).
Proposing the features upstream is on the to-do list; when a release carries them, these copies go.
