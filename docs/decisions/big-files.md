# Big files: a memory budget instead of the 50 000-layer cap, pages loaded on demand

Written 2026-10-08. Decision (docs/TARGETS.md §9): **no fixed layer cap below what
memory allows, never less than Figma** — 2 GB per browser tab, warnings at 60 % and 75 %, pages loaded on demand. The
50 000-layer / 20 MB cap stays the default until the GPU renderer (see `docs/decisions/renderer.md`) meets C3/C11 on a real GPU; everything
here is built behind one switch that is flipped then (§9).

The files this memo reasons about are the bench's (`scripts/bench/gen-file.ts`, `fixtures/bench/manifest.json`):

| File | Layers | JSON | What it is |
|---|---|---|---|
| `f20k` | 20 041 | 15.9 MB | today's heavy page (the cap's neighbourhood) |
| `f100k` | 100 201 | 79.6 MB | 200 screens on **one** page |
| `f500k` | 499 999 | 398.8 MB | 1 000 screens on **one** page |
| `f500k` split (`--pages 25`) | 499 999 | ≈ 399 MB | the same layers on 25 pages of ≈ 20 000: what page-on-demand is for |

Measured sizes of one layer (docs/decisions/renderer.md §4): the TypeScript document as the
editor holds it ≈ **2.3–2.5 KB per layer** in the JS heap (f100k: 231–254 MB; the Rust JSON model is 3.8 KB), the Rust
`store::Document` **390 B per layer** (f100k ≈ 39 MB, f500k ≈ 195 MB), the postcard checkpoint **≈ 0.2× JSON** and
**≈ 1 % of JSON after zstd** on these synthetic files (0.54–0.84× of zstd JSON on real ones, B2).

## 1. The switch

One name everywhere, off by default:

| Where | Setting | Read by |
|---|---|---|
| api (Node) | `DESIGN_BIG_FILES=1` | `shared/design/big-files.ts` → the caps of `schema.ts`, `files.ts`'s 413, `router.ts`'s body limit; `/api/config` reports `bigFiles: true` |
| browser | `/api/config.bigFiles` (or `?bigFiles=1` for a local build) → `globalThis.__MORFA_BIG_FILES__` | the same shared module; the store's partial loading, the memory budget and its indicator |
| collab (Rust) | `MORFA_BIG_FILES=1` (the model crate's `limits::big_files()`) | `crates/model` caps, `crates/ops` check, `EngineLimits`, the page-slice frames |
| tests | `setBigFiles(true)` / `morfa_model::limits::set_big_files(true)` | unit tests run both ways |

With the switch off the caps are today's (`DESIGN_DOCUMENT_CAPS`: 50 000 layers, 20 MB JSON, 200 pages) and no
code path below runs: the full gate is the proof. With it on, the caps become `DESIGN_BIG_FILE_CAPS`
(2 000 000 layers, 2 GiB JSON, 1 000 pages): a safety net against hostile input, not a product limit — the product
limit is the memory budget (§6), as at Figma.

## 2. Storage: one checkpoint object per document, the journal tail, and page slices for the wire

**Decision: the checkpoint stays one object per document; it is not split per page.** B2's numbers decide it: the
whole f100k document decodes from its checkpoint in 61 ms (W4) and a cold open of 96 MB with a 1 000-row tail
takes 0.24 s (S1 ≤ 2 s). A server that owns a document needs all of it anyway: an op may address any page, and the
invariants of `checkPatchedDocument` (instances of a component on another page, variables, styles) read across
pages. Splitting the object would buy nothing on the server and would cost the per-page interners (S1's store has
one id interner per document).

What a 400 MB file costs on the server (M6 ≤ 2.5× JSON): the actor holds the `DesignDocument` of the ops engine
(the JSON model, 3.8 KB per layer — f500k ≈ 1.9 GB) **or** the `store::Document` (390 B per layer — f500k ≈
195 MB). Today `OpsEngine` works on the JSON model (`crates/collab/src/engine.rs`); the checkpoint crate already
decodes into the store and converts with `to_model` (`crates/collab/src/pg.rs`). So M6 for f500k passes only when
the engine's document is the store, which is the model crate's `Draft`/`Stage` work (L2a/S2's shadow document
already applies patches to a `store::Document`: `MorfaDoc::apply_patch`). This memo records that as the one server
change big files still need beyond the flag: **`OpsEngine` over `store::Document`** (`approx_bytes` then reports
the store's `stats()`); f100k at 3.8 KB per layer is 380 MB resident = 4.8× JSON, over M6's ceiling, f500k does not
fit a 16 GB node beside other files. Until then the actor accepts f100k (measured) and the memory cap of
BACKEND §8 refuses growth past `EngineLimits::max_bytes`.

**Journal tail.** Unchanged: `design_file_changes` rows above `checkpoint_version`, applied on a cold open
(`Checkpoints::load`), checkpoints every 1 000 ops / 60 s / last disconnect (S4). A 100 MB document's checkpoint
is written off the actor (S3: 78 ms encode + zstd at f100k, integrity re-read 140 ms) from an `Arc` clone.

**Versions (S5, S6).** A restore is a `PUT` of the whole document: api validates it (the fast schema path), stores
the text, and in `rust` mode forwards it to the actor as a `replace`. Under the flag the body limit follows the
caps (`DOCUMENT_BODY_BYTES` = caps.bytes + 1 MB). The numbers for f100k come from the bench.

**Page slices (new, for the wire).** The actor serves a page's nodes from its in-memory document on request
(§3); nothing new is stored. A later win (not needed for the rows): cache page slices in S3 beside the checkpoint
(`ckpt/<file>/<version>.p<i>.bin.zst`) so the browser fetches them by signed URL without the actor encoding them.

## 3. The wire: skeleton + the open page, other pages on demand

Today a client gets the whole document: `GET /:id` (legacy) or the `document` frame / `snapshotUrl` (collab).
f100k as one JSON body is 80 MB → ≈ 0.9 s to parse and 240 MB of heap; f500k cannot be parsed whole in a tab.

Under the flag the client opens **partially**:

1. **Skeleton.** `GET /api/design-files/:id?pages=skeleton` (legacy and `rust` mode alike: api reads through
   `document-store.ts`) answers the document with `nodes` reduced to: every `PAGE` node (its `children` intact),
   every `COMPONENT` and `COMPONENT_SET` subtree on any page (instances on the open page need their mains for
   normalization — Figma loads components the same way, they are "always resident"), the hidden library page
   (`LIBRARY_PAGE_ID`) whole, plus all other tables (styles, images, variables, variable modes). `document.partial =
   {loaded: []}` names the pages whose subtrees are present. For f500k split 25 ways the skeleton is ≈ 25 page nodes
   and a few KB.
2. **The open page.** `GET /:id/pages/:pageId` answers `{version, nodes}`: the page's subtree at `version` (the
   file's current version). The editor asks for the page it opens on (the last viewed one, else `pages[0]`) before
   the first paint, and for any page the user switches to (`store.setPage`), with a loading state.
   Both answers are JSON (the TS↔WASM contract); the socket's binary wire is B3's and stays.
3. **Changes to pages a client has not loaded.** The server fans out every change to every client as today
   (one order, one version). The client's `applyRemote` keeps the entries of loaded pages and of the skeleton
   (page nodes, components, tables) and **drops** node entries whose page is not loaded (the page of an entry is
   its `parentId` chain through the store's nodes; an entry whose parent is absent belongs to an unloaded page).
   The version advances as before, so catch-up and `since` are unchanged. A page fetched later at version `V`
   already contains those changes; changes after `V` arrive after the page (the fetch answers with the version
   it read, and the client applies the entries of the change frames it receives while the fetch is in flight on
   top when their version is above `V`, dropping those at or below it).
4. **Moves between pages.** A change that moves a subtree root from an unloaded page into a loaded one carries
   the root but not its descendants: the client re-fetches that loaded page (`refreshPage`) instead of holding a
   node whose children are missing. Rare, correct, and the server is the truth.
5. **Ops the client sends** never touch an unloaded page's nodes: editing needs the page in view. Page-level ops
   (rename, reorder, add) touch page nodes, which are always resident with their `children` intact, so they are
   whole-node patches as today. Deleting a page loads it first (its descendants are deleted in the same patch;
   the server refuses a page deletion that leaves descendants).
6. **Co-editing with different pages loaded.** Nothing changes on the server: one document, one version, every
   client gets every change and keeps what it holds. Presence already carries `page`; a peer's selection on a page
   this client has not loaded is drawn as nothing (as today for a hidden page).

Legacy transport (SSE + PATCH) and the collab socket both work with this, because the page fetch is an api route
that reads through `document-store.ts` in both modes. The cost of that route in `rust` mode is Node composing the
document (checkpoint decoded by the wasm build + rows); the later win is the actor answering page slices itself
over the socket (`page {version, page, nodes}` frames encoded off the actor's thread, held like `send_snapshot`),
which removes the Node copy of a big file entirely; the client code is written against the `pageSource`
interface so that swap is one transport method.

**S2 (first byte ≤ 100 ms after S1).** The skeleton of a big file is small: api answers it as soon as the store
has the document; the first page follows as its own request, so the first byte of useful data does not wait for
the 80 MB body. For that the api keeps the parsed copy of a big file (`document-cache.ts`: 512 MB with the switch
on; `document-store.ts` remembers a document parsed from the text alone), so the skeleton and every page read from
one parse: on this container the skeleton's first byte is 59 ms warm, 1.4 s cold (the one parse after a restart,
which is S1 on this path; the collab path's cold open is 0.2 s). Numbers come from the bench.

**What a resync does in `rust` mode today.** The actor's `document` frame (or `snapshotUrl`) carries the whole
document; the store cuts it down to the pages it holds (`replaceDocument` under `pages`), so memory settles but the
frame's bytes still cross the wire. The next step on the collab side: a
`page {version, page, nodes}` frame encoded off the actor's thread, and `hello {pages: [...]}` so a resync carries the
skeleton and the client's pages only.

## 4. The client: a store that holds only loaded pages

`EditorState.doc` stays a `DesignDocument`; what changes is what `doc.nodes` holds: the skeleton plus loaded
pages. The store gains `partial: {loaded: ReadonlySet<NodeId>; loading: ReadonlySet<NodeId>} | null` (null = the
whole document is here, the flag off) and three operations: `loadPage(id)`, `refreshPage(id)`, `evictPage(id)`.

- **`setPage`** on an unloaded page loads it first (the editor awaits `session.pages.ensure(pageId)` and shows the
  page as loading; the canvas draws nothing for it until then). Page switch is the one place the editor already
  pays for a whole-page index build, so the fetch adds one round trip (f20k page ≈ 16 MB ≈ 150 ms parse + the
  transfer).
- **Whole-table scans** (`for (const id in doc.nodes)`) are what cross-page features use. They keep working on
  what is loaded; features that must see everything say so: **search** (Find and replace) searches loaded pages
  and offers "Search all pages" which loads the rest (Figma's find loads pages too); **assets** (the
  components index) see every component because the skeleton carries them; **styles and variables** are tables,
  always resident; "Selection colors" and the like read the selection, which is on a loaded page.
- **Undo.** A history entry remembers `pageBefore`/`pageAfter`; undo of a step on an evicted page loads the page
  and applies the inverse on top of the server's current state of it (the inverse carries whole nodes, so the
  result is exact). Pages referenced by the history are never evicted while the history holds them (cheap:
  eviction skips them).
- **Export of unloaded pages** (PDF of all pages, "Export" of frames on another page, the card picture of the
  first page): the exporter asks `session.pages.ensure(pageId)` for each page it draws; PDF export already runs
  page by page.
- **Normalization** reads mains of instances (`mainId`): components are in the skeleton, so an instance on a loaded
  page always finds its main. A `COMPONENT` moved into an instance on an unloaded page is a server-side invariant
  (`checkAncestry`) the client never evaluates for pages it does not hold.
- **Autosave / live-session** see whole-node patches of loaded pages only; nothing changes in what is sent.
- **Shadow document** (engine switch): `MorfaDoc.load_part` already exists for loading a document in parts; the
  shadow follows the store patch by patch, so it holds exactly what the store holds.

## 5. Memory accounting, the indicator, eviction

Figma shows a memory bar per file (its help centre: 2 GB per tab, warnings at 60 % and 75 %, the file cannot be
edited past 100 %). Morfa under the flag (`src/design/editor/memory-budget.ts`, `chrome/MemoryIndicator.tsx`):

- **Budget** 2 GiB (`DESIGN_MEMORY_BUDGET_BYTES`), lowered to `navigator.deviceMemory / 4` GiB on small devices
  (a 4 GB laptop gets 1 GiB).
- **Measure.** The real number where the browser gives it (`performance.measureUserAgentSpecificMemory` in
  cross-origin-isolated pages, else `performance.memory.usedJSHeapSize` in Chromium), plus the estimate the store
  keeps for every browser: loaded layers × 2.4 KB (the measured JS size of a layer) + the renderer's tile bytes
  (`RenderStats.tileBytes`) + the wasm memory (`MorfaDoc.stats().memoryBytes`) + the history's patches (JSON
  length ×2). The estimate is what the warnings use (it is deterministic and testable); the real number is shown
  beside it when available.
- **Indicator**: a bar in the file menu ("File memory: 38%"), yellow from 60 % ("This file uses a lot of memory: hidden pages are unloaded.
  Split the file if it keeps growing."), red from 75 % (the same, and editing warns before a paste of thousands of layers);
  at 100 % the store refuses edits that grow the document (`onRefused`) until memory is freed, as Figma does.
- **Eviction**: at 60 % the store evicts hidden pages not referenced by the history, least recently viewed first,
  down to 50 %; the renderer drops their tiles. A page is only ever re-fetched from the server (there is no local
  copy to lose: every edit was acknowledged before the page could be left idle for eviction — the store never
  evicts a page with unsaved changes).

## 6. What f100k and f500k cost on this path

| | f100k (one page) | f500k (one page) | f500k split 25 ways |
|---|---|---|---|
| Server, store::Document (390 B/layer) | 39 MB | 195 MB | 195 MB |
| Server, JSON model (today's engine, 3.8 KB/layer) | 380 MB (4.8× JSON: over M6) | 1.9 GB (**needs the engine over the store**) | 1.9 GB |
| Checkpoint object (postcard + zstd) | 0.66 MB (B2) | ≈ 3.3 MB | ≈ 3.3 MB |
| Cold open S1 | 0.24 s (B2, 120 246 layers) | ≈ 1.2 s (5×) | the same |
| Browser, whole document | 80 MB JSON → ≈ 240 MB heap | 400 MB JSON → ≈ 1.2 GB heap: **over 60 %, not opened whole** | — |
| Browser, skeleton + one page | the same (one page) | the same | ≈ 16 MB JSON → ≈ 50 MB per page; 2 GB holds ≈ 40 pages of 20k |
| Canvas | C2 (GPU renderer) | C3 ★ (GPU renderer) | C1 per page |

So: **f100k** opens today's way under the flag (one page, 240 MB in the tab: 12 % of the budget); **f500k on one
page** is a renderer-and-memory question tied to the renderer's C3/C11 and the store's layout (one page of 500 000
JS objects is 1.2 GB; the shadow document holds the same page in 195 MB — moving the editor's reads to it is the
editor work after the GPU renderer, outside this change); **f500k on many pages** opens, edits and co-edits with pages on demand,
which is the Figma behaviour. The memory indicator tells the user where they are in all three.

## 7. Search, components, styles, variables across unloaded pages — summary table

| Feature | Unloaded pages | How |
|---|---|---|
| Find and replace | not searched until the user asks | "Search all pages" loads them (memory indicator moves) |
| Components (assets, instance mains) | always present | skeleton rule: COMPONENT / COMPONENT_SET subtrees and the library page |
| Styles, variables, modes, images | always present | tables of the skeleton |
| Prototype flows, flow starting points | page-level fields, present | page nodes are whole |
| Export, PDF, thumbnails | loaded on demand per page | `session.pages.ensure` |
| Undo / redo | loads the page, then applies | history remembers the page |
| Co-editing | server unchanged | clients drop entries of pages they do not hold; moves re-fetch the page |

## 8. Steps and what each keeps green

1. Model and server accept documents past the cap behind the flag (`shared/design/big-files.ts`, `schema.ts`
   caps at call time, `files.ts` 413, `router.ts` body limit, `crates/model` runtime caps, `crates/ops` check,
   `EngineLimits`); the full gate with the flag off, the new tests with it on.
2. Checkpoints and cold open at 100 MB: S1, S2, S3, S5 numbers under the flag (`scripts/bench/open-save.ts`
   learns the flag; B2's `storagesim open-save` for S1/S3).
3. W4/W5 on f100k (`checkpoint-bench`), one command for B5.
4. Page-on-demand: api routes, the store's partial state, the editor's page switch, remote-change filtering,
   find, export, undo; e2e with the flag.
5. The memory budget, eviction, the indicator.

## 8b. What was built (2026-10-08)

Steps 1–5 of §8, behind the switch; the numbers (this container, 4 shared cores, provisional) are not
recorded here. The server pieces: the runtime caps (`shared/design/big-files.ts`, `crates/model/src/limits.rs`,
SQL013), the skeleton and page routes, the parsed-copy cache. The client pieces: `state.pages` in the store (loaded,
loading, layers per page), `ensurePage` / `ensureAllPages` / `refreshPage` / `evictPage`, the filter of remote
entries, `memory-budget.ts` + `memory-watch.ts` + `chrome/MemoryIndicator.tsx`, the find bar's "Search all
pages", the pages panel's loading rows. Tests: unit (pages, store, budget, watch), PostgreSQL (SQL013, the
routes, the caps both ways), e2e (`tests/e2e/design-big-files.spec.ts`).

Not built here, by design: the actor-side page frames (above), the engine over `store::Document` (§2, M6 for
f500k), page slices cached in S3 (§2), and the editor's reads of the shadow document for a 500 000-layer page (§6:
editor work after the GPU renderer).

## 9. The switch to flip after the renderer's C3/C11

Set `DESIGN_BIG_FILES=1` on api and `MORFA_BIG_FILES=1` on collab (and the bench's `.env`): the caps become
`DESIGN_BIG_FILE_CAPS`, `/api/config` turns the client's page-on-demand store and memory indicator on. To make it
the default in code: flip `DEFAULT_BIG_FILES` in `shared/design/big-files.ts` and `DEFAULT` in
`crates/model/src/limits.rs` (`big_files()`), then delete the fixed caps a release later.
