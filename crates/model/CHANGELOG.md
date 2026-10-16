# morfa-model changelog

The document model's contract with `shared/design/types.ts`, `patch.ts` and `schema.ts`. Only the coordinator edits
`crates/model` (crates/README.md); a lane that needs a change asks in its STATUS and the coordinator notes it here.
Newest first.

## Unreleased — lane N1 step 11, by the coordinator's assignment (grid auto layout, 2026-10-10)

- The one schema change of the freeze (PLAN §7 risk 1), with `shared/design/types.ts`, `schema.ts` and the fixture set
  in the same commit. `LayoutMode` gains `GRID`; a node gains two optional objects: `grid: GridLayout` (the frame's
  tracks, gaps, auto rows and placement mode — Figma's `gridRowCount`, `gridRowSizes`, `gridAutoTracks`,
  `gridItemsPositioning` … without the `grid` prefix) and `gridChild: GridChild` (a child's cell, spans and alignment —
  Figma's `gridRowAnchorIndex`, `gridColumnSpan`, `gridChildHorizontalAlign` …). New types: `GridTrackSize`,
  `GridTrackType`, `GridAutoTracks`, `GridItemsPositioning`, `GridChildAlign`; `L::GRID_TRACKS` (1 000) caps counts,
  anchors, spans and the size arrays; `validate.rs` mirrors `schema.ts` (`int`, `size`, `list`).
- Store: `PropKey::Grid` and `PropKey::GridChild`, `LayoutMode::Grid` and the two node fields are **appended** (store/
  value.rs: variants by position), so every stored frame of `codec::FORMAT` 1 still decodes and `FORMAT` is not bumped:
  a bump would refuse the binary checkpoints already stored (`crates/checkpoint` writes `codec::FORMAT` in its header and
  has no reader for an older one). A frame written with the new variants is refused by an older build with a `Payload`
  error, never misread. The existing `AutoLayout` struct is unchanged for the same reason (the grid's settings are a
  separate prop, not optional fields in the bag). The field table (`store/fields.rs`) appends the two names after `board`
  — the Rust `SceneNode` declares them after `board` too, so the table stays in the model's serialization order
  (types.ts lists them beside `autoLayout` and `maxHeight`; its order is free).
- Behaviour (lane N1's next commits): the layout stage reads `grid` and `gridChild` and writes boxes only — auto rows and
  auto-flow cells are derived, never written back (no new write kinds, no merge surface between the layout and a user's
  edit of the same object). Co-editing merges `grid` and `gridChild` as whole values (they are not in the per-key record
  lists of `shared/design/merge.ts`, `crates/ops`, `crates/collab`); per-key merging of `grid` is the coordinator's call.

## Unreleased — lane S (the api's whole-document fast path, 2026-10-09)

- No change to this crate. `crates/wasm/src/server_document.rs` (server build, feature `server`) uses
  `from_json_validated` and `to_json` as the api's fast path for a whole-document `PUT` and a version restore (TARGETS
  S5): a document it refuses goes through `validateDocument` as before. `tests/design-server-document.test.ts` proves on
  every fixture, 1 500 seeded mutants (20 000 in a manual run) and the documents at the caps that `from_json_validated`
  never accepts what `validateDocument` refuses and that `to_json` of what it accepts parses to zod's stripped value with
  the same byte length. Known divergence it steps around: an escaped lone surrogate reads as U+FFFD here (the fast path
  declines any surrogate escape). Field order: `to_json` writes `children` after `parentId`, TypeScript's documents
  write it later, so a stored text is never the request's bytes as they came (a pass-through would need that order).

## Unreleased — lane N1 (coordinator's delegate, 2026-10-09)

- Step 5 (the store path is the only path): `Draft` (the JSON-model working copy), `DirtySet`, `NodeWrites`,
  `NodeCells`, the old `Stage` trait and `run_stages` are gone from `morfa_model::draft`, which keeps `IdHasher`,
  `LAYOUT_EPSILON`, `same_f64`, `same_value`, `Ctx`, `TextMeasurer`, `FontSpec`, `FontMetrics` and `FixedWidthMeasurer`.
  The crate root re-exports `Ctx` and `store::draft::{SlotSet, Stage, Working}` (`pub use draft::{Ctx, DirtySet, Draft,
  Stage}` before). `Working::from_model(&DesignDocument)` and `Working::into_model()`: the thin constructor over
  `Document::from_model` for tests and harnesses. The `store::draft` differential test compares `Working` against a
  reference that applies TypeScript's `Draft`/`DocumentDraft` rules to the JSON model.
- `store::draft::Working`: the working copy the normalize stages write into, over the store's own nodes: reads by slot (`slot[Id::index()]`, no string hashing), writes as `Arc<Node>`s whose lists and bag values stay
  shared, a transaction's patch laid over first (`lay_over`), and the result as a journal `Entry` (`into_entry`) that
  `Document::replay` applies to the base without converting anything. Same rules as `Draft` (`update`'s `LAYOUT_EPSILON`
  rule, `update_box`, `put`, `insert`, `remove`, `set_modes`, `collect`, `written`, `box_only`, `base_box`), tested equal
  on the same random write sequences (`store::draft::tests`). `store::draft::{SlotSet, Stage, run_stages}`: the id sets
  and the stage trait of the store path.
- `store::Layer<S>`: an interner layered over a shared `Arc<Interner<S>>` (symbols at or above its `offset` resolve in
  the extra one; `extra()` is what an `Entry` records as `new_ids` / `new_atoms`). `Interner::clear`,
  `Document::ids_arc` / `atoms_arc`.
- Pointer-first equality (additive, same answers): `List::eq` and `Props::eq` short-circuit on the shared list's
  pointer (`ptr_eq`), `Prop::eq` compares an `Arc` value by pointer before its contents (`Prop::ptr_eq` compares only
  the pointer); `Props::from_sorted`.
- `store::convert` interns through a `Symbols` trait and resolves through a public `Resolver` trait (a document's
  interners or a working copy's layers); `entry_from_patch` is `entry_in` without the interner bookkeeping.

## Unreleased — lane S2 (coordinator's delegate, 2026-10-08)

- `Draft::over_store(Arc<store::Document>)`: a draft that reads the engine's stored document, converting each node
  to the JSON model the first time it is read (S2's R1: a normalize call costs what it reads, not the file), and
  `Draft::over_store_patched(store, patch)`: the same with a transaction's writes laid over the store first. Reads,
  writes and results equal `Draft::new(store.to_model())`'s (test `a_draft_over_the_store_…`). `Draft::document()` of
  such a draft has an empty `nodes` table: original nodes are read through the new `Draft::base_node(id)`.
- `Draft::ids()` now returns `Vec<&str>`, and `Draft::for_each_id(&mut dyn FnMut(&str))` walks them (a store's ids
  are interned `&str`s, not `NodeId`s).
- `Draft::put(node)`: stores a node exactly and reports it written (L2c's request 1, components.ts
  `DocumentDraft.put`). L2c's `put_exact` decoy (a serde_json::Value round trip) is gone with it.
- `impl From<DesignDocument> for Draft`; `store::Document::tables_model`, `node_model_of`, `slots`.

- `store::Document::node_model(key)`: one node back in the JSON model, for the shadow document's `node(id)` in
  `crates/wasm` (additive; nothing else in the contract changes).
- Feature `js-json-fallback` (default on): the JSON.parse-faithful second read of refused texts. The workspace
  dependency turns default features off, so `crates/wasm` (the browser) builds without it (≈ 20 % of its code);
  `morfa-model`'s own tests, bins and the S1 harness keep it.

## 0.1.0 — lane S1 (2026-10-08)

- Types mirror `shared/design/types.ts` and `board/types.ts` field for field: snake_case fields serialized in
  camelCase, a TS `type` field is `kind`, Figma plugin API names kept. Discriminated unions are enums with one variant
  per tag value (`Paint::GradientLinear`, `Effect::DropShadow`, `PathCommand::C`, `BoardMeta::Connector`...).
- Optional fields: `Option<T>` = `field?: T` (`null` refused, as zod's `.optional()`); `Option<Option<T>>` =
  `field?: T | null` (`Some(None)` is an explicit `null`); a required `Option<T>` = `field: T | null`.
- Numbers are `f64` everywhere (ints included, as in JavaScript); `to_json` writes them as `String(n)` does.
- Unknown keys are dropped, as zod's default `strip` (`designDocumentSchema` and `sceneNodeSchema` strip).
- `from_json_validated` / `validate_document` accept exactly what `validateDocument` accepts: the strict reader
  (`de.rs`: no struct from an array, no enum from a map, `null` only where zod allows it), every bound of the schema,
  and the invariants of `checkDocument`. `patch_from_json_validated` / `validate_patch` mirror `validatePatch`.
- `DocumentPatch` with `is_empty` and in-place `apply` (inverse, compose and diff are L2a's, in `crates/ops`).
- `Draft`, `DirtySet`, `Ctx` and the `Stage` trait: the skeleton the normalize stages of L2b/L2c plug into.
- `js_json`: when serde_json refuses a text, it is read again as `JSON.parse` reads it (a repeated key keeps the last
  value, a number beyond f64 is ±Infinity, any depth under a stripped key); lone surrogates read as U+FFFD.
- `store`: the in-memory model for the server and the browser (owner's request of 2026-10-08): `Id`/`Atom` symbols of
  two per-document append-only interners, a slab of `Arc<Node>` keyed by `Id`, a 176-byte `Node` core and a sorted
  bag of 24-byte `Prop`s, shared `List<T>`s; `Document::from_model`/`to_model` (lossless), `apply_patch`, and the op
  journal (`commit` → `Entry`, `replay`, `Entry::to_bytes/from_bytes`).
- `codec`: `MRFA` + `FORMAT` (1) + postcard of `store::Document`; symbols checked against the interners while read.
  Binary compatibility: append `Prop` variants and fields at the end, bump `FORMAT` for anything else, never reorder
  (store/value.rs). The comparison with bincode 2.0.1 and rkyv 0.8.18 is commit 122e59c.
