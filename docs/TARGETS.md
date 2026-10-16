# Morfa — performance targets (the measurable goal)

Drafted 2026-10-08 from the goal "a full functioning backend optimised for a full Figma-like platform,
super fast, without compromises". This sheet turns that into numbers. A work stream is closed
only when its rows pass. Every row has a benchmark that prints **target / ceiling /
actual**; B0 builds them (`scripts/bench/targets.ts` runs them all).

Legend. **Target** = what we aim for and report green. **Ceiling** = the hard limit: red above it, the work stream stays
open. **Src**: `F` a public Figma figure (cited), `M` our measurement today (`docs/design-tool.md` §Performance),
`P` our proposal. **★** = the number needs an explicit decision (it decides cost or scope).

## 0. Reference hardware and networks (fixed, so numbers compare run to run)

| Name | What it is | Used for |
|---|---|---|
| **laptop** | M1-class: MacBook Air M1 16 GB, Chrome stable, 1440×900 CSS px at DPR 2, 60 Hz, 50 Mbit/s. Until one is available (★), a development Mac (M4-class, 14 cores) runs Chrome at **2× CPU throttle** as a stand-in; a row closes only on a real M1-class run | canvas, editing, open |
| **dev-4** | Docker container on the Mac limited to 4 CPUs / 8 GB (today's measurements were a 4-core container) | server dev loop |
| **bench-ru** ★ | a separate, **non-production** VM shaped like production: 4 vCPU, 16 GB, NVMe, PostgreSQL 18, S3-compatible storage of the same provider; never a production host. SSH access is for benchmarks only. `scripts/bench/close.sh <hash>` (B0) builds that hash, deploys it there, runs every server row and writes `lanes/targets/close-<hash>.md`. This is the closing machine for M/D/S/X/A/K rows | server, multiplayer, cost |
| **ru-4** | the production VM, operator-only; `targets` runs there only as a smoke check after a release, never for closing | production smoke |
| **ru-net** | synthetic editors on a second small VM in another DC (or `tc netem` 30 ms RTT, 0.1 % loss, from bench-ru itself) | round trip |
| **Files** | `gen-file.ts --layers N` (B0, extends `tests/helpers/design-big-files.ts`): `f20k` = today's 20 041-layer page (15.9 MB JSON), `f100k` ≈ 80 MB, `f500k` ≈ 400 MB; `product` = the 12 452-layer product file (40 screens of nested auto layout); `board2k` = 2 000 stickies | all |

Figma publishes few absolute numbers. What it does publish: a separate server process per document and WebSockets
([How Figma's multiplayer technology works](https://www.figma.com/blog/how-figmas-multiplayer-technology-works/)); the
multiplayer server rewritten from TypeScript to Rust because of GC pauses and "unpredictable latency spikes", with
serialization "over 10x faster" ([Rust in production at Figma](https://www.figma.com/blog/rust-in-production-at-figma/));
load time "more than 3x" better with WebAssembly, load = app init + file download + first full render
([WebAssembly cut Figma's load time by 3x](https://www.figma.com/blog/webassembly-cut-figmas-load-time-by-3x/));
perf tests run "100 multiplayer editors moving layers and typing", a 20 % noise margin on VMs
([Keeping Figma fast](https://www.figma.com/blog/keeping-figma-fast/)); LiveGraph reads the PostgreSQL replication
stream for millisecond updates ([LiveGraph](https://www.figma.com/blog/livegraph-real-time-data-fetching-at-figma/));
PostgreSQL horizontally sharded by a custom proxy ([How Figma's databases team lived to tell the scale](https://www.figma.com/blog/how-figmas-databases-team-lived-to-tell-the-scale/)).
Figma's help centre states a 2 GB memory limit per browser tab. Everything else below is `P` or `M`.

## 1. Canvas (laptop; `scripts/bench/canvas.ts`: Playwright drives the built app, reads `requestAnimationFrame`
## timestamps and the Event Timing API; medians of 3 runs of 10 s each)

| # | Scenario | Metric | Target | Ceiling | Src |
|---|---|---|---|---|---|
| C1 | Pan `f20k`, nothing selected | fps / frame p99 | 60 / ≤ 16.7 ms | 55 / 25 ms | M (budget today) |
| C2 | Pan `f100k` | fps / frame p99 | 60 / ≤ 20 ms | 50 / 33 ms | P |
| C3 | Pan `f500k` ★ | fps / frame p99 | ≥ 45 / ≤ 33 ms | 30 / 66 ms | P; needs the L4 GPU renderer |
| C4 | Zoom (pinch 1× → 4× → 1×, 4 s) on `f100k` | frame p99 | ≤ 33 ms (tiles may re-raster within budget) | 50 ms | P |
| C5 | Pan `f20k` with 5 000 layers selected | frame p95 | ≤ 12 ms | 17 ms | M: 17 ms at 1× today |
| C6 | Pointer move → pixel (drag one layer, `f100k`) | input-to-pixel p95 | ≤ 33 ms (2 frames) | 50 ms | P |
| C7 | Open `f100k` cold (empty caches, 50 Mbit/s) | first paint / interactive | ≤ 3 s / ≤ 5 s | 5 s / 8 s | P; F says load fell 3× with WASM, no absolute |
| C8 | Open `f100k` warm (checkpoint in IndexedDB, WASM compiled cache) | first paint / interactive | ≤ 1 s / ≤ 1.5 s | 2 s / 3 s | P |
| C9 | Open `f20k` cold / warm | interactive | ≤ 1.5 s / ≤ 0.6 s | 2.5 s / 1 s | M: first paint < 1.5 s budget today |
| C10 | Memory, `f100k` open 5 min, idle, after GC | JS heap + WASM + GPU tiles | ≤ 700 MB | 1.2 GB | P; F: 2 GB per tab is Figma's hard limit |
| C11 | Memory, `f500k` ★ | the same | ≤ 2 GB | 3 GB | P; sets the layer cap we advertise |
| C12 | Board `board2k`, all selected, pan | frame p95 | ≤ 16.7 ms | 33 ms | M: 50 ms at 4× today |

## 2. Editing operations (laptop; `scripts/bench/edit-ops.ts`: in-browser, `both` engine mode allowed, reports the
## commit time (transaction + normalize + patch) and the frame the edit lands in)

| # | Scenario | Metric | Target | Ceiling | Src |
|---|---|---|---|---|---|
| E1 | Move one layer in `f100k` | commit p95 / frame | ≤ 1 ms / 1 frame | 4 ms / 2 | P; today's store work is size-independent |
| E2 | Resize a top frame of `product` (reflows ~5 000 auto-layout descendants) | commit p95 | ≤ 8 ms | 16 ms | P |
| E3 | Change a component with 1 000 instances (L2c sync) | commit p95 | ≤ 20 ms | 50 ms | P; **8.1–8.4 ms** a commit in Chromium at 2× (cloud container, 2026-10-09); a run on Apple silicon closes it |
| E4 | Boolean union, 200 fuzzed operands (L1 set) | wall | ≤ 50 ms | 200 ms | P; today's budget `BOOLEAN_TIME_BUDGET_MS` 1 500 |
| E5 | Keystroke in a 2 000-character text with 40 runs, `f100k` | commit p95 / input-to-pixel | ≤ 2 ms / 1 frame | 4 ms / 2 | P |
| E6 | Undo / redo of E2 | commit p95 | ≤ 8 ms | 16 ms | P |
| E7 | Select all (`f100k`) then pan | select / frame p95 | ≤ 300 ms / ≤ 33 ms | 1 s / 50 ms | M: 192 ms for 5 000 today |
| E8 | Paste 5 000 layers | commit + validation | ≤ 150 ms | 500 ms | P |

## 3. Multiplayer (bench-ru server, ru-net editors; `crates/loadgen` drives N synthetic editors over WebSocket:
## each sends 1 op/s of 20 moved layers (~9 KB as JSON) and cursors at 30 Hz; `scripts/bench/collab-load.ts` prints)

Two server-side numbers, on purpose. **M1** is the actor's work: op received → merged, checked, applied, and
the `change` frame queued to the peers. It excludes the journal commit, because fan-out does not wait for it.
**M1b** is the ack the sender gets: M1 plus the group commit (D1). **What the user feels** is M3 (the other
person's edit appearing) and C6 (their own edit on their own screen, which never waits for the server); M1b/M2
only move the "Saved" indicator. So M1 + D1 ≈ M1b, and M2 ≈ RTT + M1b.

| # | Scenario | Metric | Target | Ceiling | Src |
|---|---|---|---|---|---|
| M1 | Op → change queued to peers, 5 editors on `f20k`, server side, journal excluded | p50 / p95 / p99 | ≤ 0.5 / 2 / 5 ms | 1 / 5 / 20 ms | M: 31 ms CPU per save today |
| M1b | Op → ack after journal commit, same run, server side | p50 / p95 / p99 | ≤ 3 / 8 / 15 ms | 6 / 15 / 30 ms | M: 21 / 29 ms today incl. PostgreSQL |
| M2 | Op → ack over ru-net (30 ms RTT) | p50 / p95 / p99 | ≤ 35 / 45 / 60 ms | 50 / 80 / 150 ms | P: RTT + M1b |
| M3 | Op → applied at another editor (same file) over ru-net | p95 / p99 | ≤ 45 / 60 ms | 80 / 100 ms | M: 4.4 ms after save answer today, single process; P: RTT + M1 + client apply |
| M4 | One file: 100 editors + 400 viewers ★ | M1 p99 / M3 p95 | ≤ 2× M1 / ≤ 2× M3 | 4× / 4× | P; F tests 100 editors + typing |
| M5 | 2 000 editors across 400 files (5 per file) on bench-ru | M1 p99 / CPU | ≤ 20 ms / ≤ 3 of 4 cores | 50 ms / 4 | P; today's limit is 2 000 streams per process |
| M6 | Server memory per open document (resident) | × JSON size | ≤ 2.5× (`f20k` → ≤ 40 MB) | 4× | M: ~25–41 MB kept text today per 16 MB |
| M7 | Open documents per GB of server RAM (`f20k`, idle, 1 editor) | count | ≥ 25 | 15 | derived from M6 |
| M8 | Reconnect after a 30 s drop, 1 000 ops missed | catch-up server time / converged | ≤ 100 ms / ≤ 500 ms over ru-net | 300 ms / 2 s | P; F reloads the whole file instead |
| M9 | Full reload fallback | when | only if the journal tail > 5 MB or > 20 000 ops | — | P |
| M10 | Cursors: 1 000 users moving at 30 Hz | server CPU / receiver rate | ≤ 0.25 core / coalesced ≤ 30 Hz per peer | 0.5 core | M: 148 ms/s CPU for 5 cursor users today |
| M11 | Presence delivery over ru-net | p95 | ≤ 50 ms | 100 ms | P |
| M12 | A slow viewer (64 kbit/s) on a busy file | effect on the others' M1/M3 | none (dropped presence, then coalesced catch-up, then closed) | — | P |

## 3b. Wire, codec and checkpoint format (decided on S1's numbers; `scripts/bench/codec.ts`, bench-ru + laptop)

S1 is adding a compact in-memory layout and a binary codec (postcard vs rkyv vs bincode) with JSON-vs-binary
size and encode/decode timings on `f20k`. **Rule:** the wire format of ops, catch-up and checkpoints is S1's
binary codec when it decodes **≥ 2× faster** than `serde_json` into the model **or** is **≥ 2× smaller** than
JSON on `f20k`; otherwise JSON+zstd stays and this section is re-run when S1 improves. JSON is kept only at the
TS↔WASM edge, where it is already the contract (`load(json)`, `apply_patch(json)`). B1/B2/B3 code against the
codec crate, never `serde_json::Value`, except in the week before S1's codec lands (B1's `JsonEngine` fallback).

| # | Scenario | Metric | Target | Ceiling | Src |
|---|---|---|---|---|---|
| W1 | Encode / decode a 20-layer move op (~9 KB JSON) in Rust, bench-ru | µs | ≤ 15 / ≤ 25 µs | 50 / 80 µs | P; JSON today ≈ 60 / 120 µs expected |
| W2 | The same op decoded in the browser's WASM (laptop) and handed to the TS store as a patch | ms | ≤ 0.15 ms | 0.5 ms | P |
| W3 | Wire bytes of W1's op vs its JSON | ratio | ≤ 0.5× | 0.8× | P |
| W4 | Checkpoint of `f100k`: encode + decode into the model, bench-ru | wall | ≤ 250 ms / ≤ 400 ms | 600 / 1 000 ms | S1 measures; M: JSON parse of 16 MB ≈ 150 ms target in S1 |
| W5 | Checkpoint bytes of `f100k` after zstd, binary vs JSON | ratio | ≤ 0.6× | 1.0× | P |
| W6 | Catch-up of 1 000 ops: bytes and decode time at the client | KB / ms | ≤ 3 MB / ≤ 40 ms | 6 MB / 150 ms | P; feeds M8 |

## 4. Durability (bench-ru; `scripts/bench/durability.ts`: loadgen + `kill -9` of the collab node, a PostgreSQL
## restart, a pulled S3; counts acked ops missing after recovery)

| # | Scenario | Metric | Target | Ceiling | Src |
|---|---|---|---|---|---|
| D1 | Ack means journaled: group-committed append to PostgreSQL before the ack ★ | commit p50 / p99 at 2 000 editors | ≤ 2 / 10 ms | 5 / 20 ms | P; this is the gap between M1 and M1b |
| D2 | Collab node `kill -9` under load | acked ops lost / reconverged | 0 / ≤ 3 s (new owner loads checkpoint + tail) | 0 / 10 s | P |
| D3 | PostgreSQL unavailable 30 s | behaviour | ops queue in memory up to 64 MB per node, acks pause, clients show Saving…; no 409 storms | — | P |
| D4 | Data loss bound if the whole DC's disks are lost | acked ops | ≤ last PostgreSQL backup / replica lag (the hosting choice ★) | — | P |
| D5 | Checkpoint integrity | every checkpoint re-parsed and hash-checked after upload | 100 % | — | P |

## 5. Load, save, checkpoints (bench-ru; `scripts/bench/open-save.ts`)

| # | Scenario | Metric | Target | Ceiling | Src |
|---|---|---|---|---|---|
| S1 | Cold open of a 100 MB file on the server (S3 checkpoint + journal tail of 1 000 ops → ready) | wall | ≤ 2 s | 5 s | P |
| S2 | First byte to the client after S1 (zstd checkpoint stream) | wall after S1 | ≤ 100 ms | 300 ms | P |
| S3 | Checkpoint of a 100 MB document (serialize + zstd + upload), off the document's thread | CPU / effect on M1 p99 | ≤ 1.5 s / none | 4 s / +5 ms | P |
| S4 | Checkpoint cadence | rule | every 1 000 ops or 60 s or last disconnect, whichever first | — | P |
| S5 | A version restore (`PUT` whole document, 100 MB) | ack | ≤ 3 s | 8 s | M: 1.0 s for 16 MB today |
| S6 | History: open version N of a file (checkpoint before N + ops to N) | wall | ≤ 2 s | 5 s | P |

## 6. Export and thumbnails (bench-ru, Rust render service, no Chromium; `scripts/bench/export.ts`)

| # | Scenario | Metric | Target | Ceiling | Src |
|---|---|---|---|---|---|
| X1 | File-card thumbnail (`f20k` page, 512 px) | wall | ≤ 300 ms | 1 s | M: 76 ms in the browser today, sliced |
| X2 | PNG 3840×2160 of a 20k-layer frame, effects on | p95 | ≤ 1.5 s | 4 s | P |
| X3 | SVG of a `f20k` page | p95 | ≤ 1 s | 3 s | P |
| X4 | 50-page vector PDF (frames ≤ 5 000 layers, Cyrillic text, pictures, shadows) ★ | p95 / fidelity | ≤ 5 s / ≤ 0.5 % pixels differ from today's Chromium PDF at 150 dpi | 15 s / 2 % | M: ~1 s per 20k-layer page today + Chromium |
| X5 | Export queue: 20 concurrent exports | X2 p95 | ≤ 2× | 4× | P |

## 7. API (bench-ru, TypeScript service; `scripts/bench/api.ts`, autocannon-style, 50 concurrent)

| # | Scenario | Metric | Target | Ceiling | Src |
|---|---|---|---|---|---|
| A1 | `GET /api/design-files?team=` with 200 files | p95 / p99 | ≤ 80 / 150 ms | 150 / 300 ms | P |
| A2 | Socket ticket: `GET /:id/session` (auth + ACL + lease lookup) | p95 | ≤ 20 ms | 50 ms | P |
| A3 | ACL check inside collab (cached, revalidated ≤ 20 s) | p95 | ≤ 0.1 ms | 1 ms | P |
| A4 | Permission revocation → the editor's socket closed | wall | ≤ 2 s | 20 s | M: ≤ 20 s revalidation today |
| A5 | Comments, libraries, versions listing | p95 | ≤ 100 ms | 250 ms | P |

## 8. Cost (derived from M5–M7 on bench-ru; `scripts/bench/cost.ts` prints from the load run)

| # | Scenario | Metric | Target | Ceiling | Src |
|---|---|---|---|---|---|
| K1 | 1 000 concurrent editors ★ (5 per file, `f20k` average, 1 op/s, cursors 30 Hz) | collab cores / RAM | ≤ 2 cores / ≤ 10 GB | 4 cores / 16 GB | P |
| K2 | The same in ₽ at Russian VM prices (the hosting provider) | ₽ per editor-month | ≤ 10 ₽ | 25 ₽ | P; estimate, provider quote needed |
| K3 | PostgreSQL write load at K1 | WAL per op | ≤ 4 KB | 16 KB | M: 2.7 KB per typing save today |

## 9. Approvals needed (★ rows)

The targets are a **floor, not the finish line** — every work stream also profiles its area after its rows pass
and takes further wins where it finds them (§10). Hosting: one provider for dedicated VMs and S3, separate from any
production host. Still open for whoever runs the benchmarks: provision the bench-ru (and later production) VMs, provide
an M1-class laptop or accept the stand-in rule, pick the replica mode (D4).

The ★ rows as decided:

C3/C11 (500k layers is scope: it needs the GPU renderer and sets the layer cap we advertise), M4 (100 editors +
400 viewers per file), D1 (ack = committed to PostgreSQL, ≈ +2–10 ms on the ack only, vs ack = local fsync with
≤ 1 s loss on disk loss), D4 (replica/backup choice = loss bound), X4 (PDF fidelity by pixel diff, not byte
identity), K1/K2 (the cost envelope), **bench-ru** (a second VM plus a small ru-net VM; SSH for benchmarks only, production stays operator-only), and the
**laptop** stand-in rule until a real M1-class machine is lent.

**Decisions, 2026-10-08 morning.**
- **Renderer (L4): go** for the memo's recommendation — vello (compute) on WebGPU inside today's tile architecture,
  Canvas2D kept for browsers without WebGPU, vello_cpu on the server.
- **Layer cap: no fixed layer cap below what the memory allows, never less than Figma.** Figma has no published
  layer cap; it limits memory to 2 GB per tab (browser and desktop), warns at 60 % and 75 %, and loads pages on
  demand; files around 300 000 layers are reported. Morfa: replace the 50 000-layer cap
  (`shared/design/document-limits.ts`) with a memory budget (2 GB, warnings at 60 % / 75 %) and page-on-demand
  loading, once the GPU renderer meets C3/C11 (500 000 layers ≥ 45 fps, ≤ 2 GB). Until then the cap stays.
- **Text: the lazily loaded wasm-fonts module (≈ 501 KiB gzip) is accepted.**
- **T4: the 15 small/semibold text regions** that differ from Chrome's `fillText` are accepted on the Canvas2D path
  (they come from the glyph rasteriser); text is re-measured on the GPU renderer, which draws
  glyphs itself.

## 10. Rules

- **Floor, not finish (2026-10-08).** When a work stream's rows pass, it profiles its whole area (CPU, allocations,
  bytes on the wire, memory, frame times), lists the remaining hot spots by size ("Further wins"),
  takes every win that keeps the tests and fidelity intact, and re-measures. A work stream is closed when its rows pass
  AND its profile shows no single hot spot above 10 % of its budget that has a known fix.

- A row passes when **3 consecutive runs** on the reference hardware meet the target, with the run's hash recorded.
- A row between target and ceiling is **yellow**: the work stream may hand over, the loop keeps it open.
- Numbers from the Mac stand-in or dev-4 are for the dev loop; closing needs **laptop** / **bench-ru** runs (`scripts/bench/close.sh <hash>`).
- Noise margin 20 % between runs (Figma's own rule on VMs); a regression beyond it reopens the work stream.
- No target is met by lowering fidelity (no skipped effects, no LOD below what Figma does) or by raising a cap.
