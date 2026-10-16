# Morfa — the backend built for a Figma-class load

Drafted 2026-10-08. Targets: `docs/TARGETS.md`.
The hot paths are built in Rust for Figma-class load from the start (rather than "Rust collab service: Phase 3 or never"). The other
half of that old plan stays true and is argued in §6: Rust buys nothing for auth
and CRUD, so those stay TypeScript.

## 1. Shape

```
                 browsers (TS editor + WASM engine)          desktop (Tauri, later)
                     │ HTTPS                 │ WSS (one socket per open file)
   ┌─────────────────▼──────────┐   ┌────────▼──────────────────────────────────────┐
   │  api  (TypeScript, Node)   │   │  collab  (Rust: tokio + axum + tungstenite)   │
   │  auth, accounts, teams,    │   │  router: file id → owner node (lease)         │
   │  files CRUD, versions list,│◄──┤  DocActor per open file: the authoritative    │
   │  comments, libraries,      │int│  in-memory document; ops via crates/ops;      │
   │  meetings, admin,          │HTTP│ presence; op journal (group commit);          │
   │  tickets for the socket,   │   │  checkpoints; catch-up; backpressure          │
   │  ACL push to collab        │   └──┬───────────────┬──────────────┬─────────────┘
   └──────┬──────────┬──────────┘      │ journal rows  │ checkpoints  │ render jobs
          │          │                 │               │              ▼
   ┌──────▼────┐  ┌──▼─────────────────▼───┐   ┌───────▼──────┐  ┌────────────────────┐
   │ PostgreSQL│  │ PostgreSQL (same DB):   │   │ S3-compatible│  │ render (Rust: axum)│
   │ accounts, │  │ design_files (meta,     │   │ checkpoints, │  │ crates/render +    │
   │ teams,    │  │ checkpoint key, lease), │   │ pictures by  │  │ crates/export:     │
   │ …         │  │ design_file_changes =   │   │ content hash │  │ thumbnails, PNG,   │
   └───────────┘  │ the op journal          │   │ → CDN        │  │ SVG, PDF (no       │
                  └────────────────────────┘   └──────────────┘  │ Chromium)          │
                                                                  └────────────────────┘
                 observability: tracing → OTLP → self-hosted Grafana/Tempo/Prometheus in the same DC
```

Three services, one database, one object store. `api` and `collab` share PostgreSQL so a transaction can span
file metadata and journal rows; the stores never share tables for writing (api writes metadata, collab writes
the journal and checkpoint pointers). All three run in one region, close to their users; the S3-compatible store and the CDN are the operator's choice of provider.

## 2. `collab` — the Rust multiplayer service

**Process model.** One `collab` process per node (not one process per document as Figma does: Figma's
[multiplayer post](https://www.figma.com/blog/how-figmas-multiplayer-technology-works/) and
[Rust post](https://www.figma.com/blog/rust-in-production-at-figma/) describe a child process per document for
isolation). We use one **`DocActor` per open file**: a tokio task owning the document, fed by an `mpsc` inbox.
No locks on the document; everything that touches it runs inside the actor. Isolation is by `catch_unwind` per
message and a per-document memory cap (`stats()` from the model crate) instead of process boundaries. A node
holds documents of many files; a 4-vCPU node is sized for 400 open `f20k` files (TARGETS M5–M7).

**Routing and the lease.** `design_files.collab_node, lease_until` (migration 012, B2). `GET /api/design-files/:id/session`
(api, B6) answers `{wsUrl, ticket}`: it takes the lease for an idle file (`UPDATE … WHERE lease_until < now()`),
or names the current holder. Leases last 15 s and the owner renews every 5 s. One owner per document at all
times is the rule; §8 says what happens when it breaks. Clients never pick a node themselves.

**The socket.** One WebSocket per open file per tab. Binary frames in **S1's codec** (postcard, rkyv or
bincode — S1 is measuring all three on `f20k`; the rule in TARGETS §3b picks binary when it decodes ≥ 2× faster
or is ≥ 2× smaller than JSON). The same `model` crate sits at both ends, so an op is decoded straight into model
types: no `serde_json::Value`, no field-name strings on the wire. The browser decodes frames inside the WASM
build of the same crate and hands the TS store a patch; JSON exists only at that TS↔WASM edge, where it is
already the contract (`load(json)`, `apply_patch(json)`). A JSON text-frame mode stays for debugging and for
`loadgen`'s legacy comparison. Messages (`crates/protocol`, B1):

| Client → server | Server → client |
|---|---|
| `hello {ticket, since?, clientId, lastSeq}` | `welcome {version, role, peers, catchUp[] or snapshotUrl}` |
| `op {seq, baseVersion, patch, before?, beforeTables?}` | `ack {seq, version, own?}` · `change {version, by, patch}` |
| `presence {cursor?, page?, selection?, viewport?, editing?}` | `presence {by, …}` coalesced ≤ 30 Hz per receiver |
| `ping` | `pong` · `access {role}` · `file {name}` · `comments {}` · `meeting {revision, user?}` · `bye {reason}` |

The server also sends WebSocket pings to a socket quiet for `PING_MS` (the browser answers them itself, so a
background tab with throttled timers stays open); any frame counts as heard, and `SILENCE_MS` without one closes it.

An `op` is today's `PATCH /:id/document` body. The actor applies it with **the same `ops` crate the browser
runs** (L2a): `mergeChange` against the current version, `checkPatchedDocument`, then `applyPatch`. The answer
carries `own` exactly as today, so `src/design/realtime/live-session.ts` keeps its model (B3 swaps the transport,
not the semantics). `(clientId, seq)` makes ops idempotent across reconnects: a re-sent op already journaled is
re-acked, not re-applied.

**Presence** rides the same socket, is never journaled, and is dropped first under backpressure. The server
coalesces per receiver: at most one presence frame per peer per 33 ms.

**Backpressure.** Each connection has a bounded send queue (4 MB). Over 50 %: presence dropped. Over 75 %:
individual `change` frames replaced by one `catchUp {from, to}` the client pulls when ready. Over 100 %: `bye
{slow}`; the client reconnects with `since`. Per-client inbound limits: 50 ops/s, 2 MB/s, one op > 8 MB → refused
`design_document_too_large` as today (the client then uses `PUT` through api). The actor's inbox is bounded; a
full inbox makes the socket read loop wait, never the actor.

**Reconnect and catch-up.** The client sends `since: version` and `lastSeq`. The actor serves ops `(since, now]`
from its in-memory tail (last 20 000 ops or 64 MB per document), then from the journal, then — only beyond
TARGETS M9 — `snapshotUrl` for a full reload. A version vector is not needed: there is one order (the server's
version) plus per-client `seq`; that pair is what we call the version vector in the briefs.

**Permissions.** The ticket is an Ed25519-signed token minted by api (60 s, carries user, file, role, team). The
actor caches the ACL per connection and api **pushes** changes (`POST /internal/acl` on collab, and a PostgreSQL
`LISTEN design_acl` fallback); every connection also re-validates through api every 20 s (today's rule, TARGETS
A4 tightens it to 2 s via the push). Viewers and developers never send `op`; a demoted editor gets `access` and
its ops are refused.

**Apply pipeline, per op:**
`decode → ACL → merge (ops crate) → check → apply → tail.push → fan-out (M1 ends here) → journal.enqueue → ack after commit (M1b)`.
The journal is **group-committed**: one `INSERT … VALUES (…),(…)` per node every 2–5 ms or 256 ops (D1: commit
p99 ≤ 10 ms at 2 000 editors). Fan-out to the other editors goes out **before** the commit (TARGETS M1, ≤ 5 ms
p99): a peer that applies an op the journal then loses would diverge, so if a commit fails the actor sends a
`rollback {version}` and the peers rebase as on a `resync` — this path is exercised by `durability.ts` and is
expected never in normal operation. The sender's **ack** waits for the commit (M1b ≤ 15 ms p99 = M1 + D1). The
user feels M3 (the other person's edit) and never waits for M1b except in the "Saved" indicator.

## 3. Storage

**Journal = `design_file_changes`.** Today's table already is an op log keyed `(file_id, version)` with the
patch as applied. Migration 012 adds `client_id text, client_seq bigint, user_id text, fence bigint, op bytea`
and an index on `(file_id, client_id, client_seq)`. In `legacy|shadow` mode Node writes `patch` (JSON) as today;
in `rust` mode collab writes `op` in S1's codec and leaves `patch` null. Readers go through `document-store.ts`,
which decodes `op` with the WASM build (`crates/wasm` `decode_op`), so history, restore, PDF and export keep
working on both kinds of rows (B6). Rows below the last checkpoint are deleted lazily, keeping a tail of
20 000 versions for catch-up and history.

**Checkpoints in S3.** `design_files.checkpoint_key, checkpoint_version, checkpoint_format` point at
`ckpt/<file>/<version>.<fmt>.zst`: the document in S1's codec (or JSON if the §3b rule says JSON), zstd level
3, plus a 64-byte header `{magic, format, version, sha256, node_count, bytes}`. Written off the actor's thread
(the actor hands over an `Arc` of the immutable document; S1's compact layout clones unchanged subtrees cheaply,
so the actor keeps editing). The format is a decision on S1's `f20k` numbers (TARGETS W4/W5), taken once, in
`crates/model/CHANGELOG.md`; the reader accepts both formats forever, so the decision can be revisited without a
migration. `design_files.document` keeps the latest checkpoint as JSON too for files ≤ 4 MB (fast path for the
api's readers); larger files hold only the key.

**Cold load = checkpoint + journal tail.** The new owner streams the checkpoint from S3, decodes on a blocking
thread, applies the journal rows above `checkpoint_version` with `applyPatch`, and serves (TARGETS S1 ≤ 2 s for
100 MB). The browser gets the same checkpoint stream straight from S3 through a short-lived signed URL
(`snapshotUrl`), decodes it in WASM and loads the shadow document from it, so the first byte does not pass
through collab (S2) and the TS store receives JSON only from its own WASM.

**Pictures** (`design_images`) become content-addressed: key `img/<sha256>`, served through a CDN with
signed URLs (15 min) because private uploads must not need the owner's cookie on a CDN edge. Dedup is free;
`image_files` counts stay per account. Thumbnails `thumb/<sha256>.webp` from the render service.

**Versions.** A named or automatic version is `(file_id, version)` plus the checkpoint nearest below it; opening
version N replays ≤ 1 000 ops (S6). No more whole-document copies per version (today ≤ 20 MB each).

## 4. `render` — the Rust render/export service

Shares `crates/render` (L4) and `crates/export` (L5) with the browser build, so a thumbnail, a PNG and the
canvas draw the same pixels. CPU rasterizer (the L4 memo decides the API; server side is always CPU). Jobs over
HTTP from api (`POST /internal/render`): thumbnails on every checkpoint, PNG/JPG/WebP at scale, SVG, and the
**vector PDF without Chromium**: `pdf-writer` + our own page/font code, TrueType subsets for static faces, Type 3
glyph outlines for variable instances, soft masks, shadings, link annotations — the table in
`docs/design-tool.md` §Vector PDF is the spec, and the pixel diff against today's Chromium output is the gate
(TARGETS X4). Text layout uses the `text` crate (L3) on the server, so the editor stops posting
`measurements`; until L3 lands, the service accepts them as today. Limits as today (50 pages, 96/240 MP), a
bounded job queue, one worker thread per core.

## 5. `api` — stays TypeScript

Auth, accounts, teams, invites, file CRUD and listing, trash, versions listing, comments, libraries, meetings metadata, admin. It also mints socket tickets, takes leases,
pushes ACL changes to collab, and calls render. Nothing here is CPU-bound: every request is one or two indexed
PostgreSQL queries plus JSON; p95 is the database's. Rewriting ~12 000 runtime-tested lines of regulated code
would spend weeks for no row in TARGETS. The only api rows (A1–A5) are met with indexes and a 20 s ACL cache.

## 6. Where Rust buys nothing, and why

| Path | Today | Rust gain | Decision |
|---|---|---|---|
| Op apply + merge + fan-out on a hot file | Node, 31 ms CPU per save | 10–30× (no GC, no JSON re-stringify, shared `ops` crate) | **Rust** (`collab`) |
| Journal + checkpoint + cold load | TOAST text + changes | binary-safe streaming, off-thread zstd | **Rust** |
| Thumbnails, PNG, PDF | browser + Chromium | no browser; same pixels as the canvas | **Rust** (`render`) |
| File list, ACL, teams, invites | indexed SQL | none: the database is the latency | TypeScript |
| Comments, libraries, meetings metadata | SQL + fan-out notice | none | TypeScript; their "changed" notices ride the collab socket as `file`-class events (B6) |

## 7. Migration from today's SSE + PATCH path

Switch `DESIGN_COLLAB = legacy | shadow | rust`, per account/team (`DESIGN_COLLAB_ACCOUNTS`) and global.

1. **legacy** (today): SSE down, PATCH up, Node merge, `design_file_changes` written by Node.
2. **shadow**: the Node path stays authoritative; every accepted PATCH is also sent to collab (`POST
   /internal/shadow-op`), which applies it to its own copy and returns the document hash. A mismatch is logged
   with the first differing path (the same oracle idea as `engine-switch.ts` `both`). This runs for days on the
   maintainers' own files before anyone depends on collab.
3. **rust**: the editor opens the socket (B3); api stops accepting PATCH for that file (409 `collab_active`
   with the session URL) except `PUT` (restore/import), which api forwards to the actor as a `replace`.
   The lease, journal and checkpoints are live. SSE stays as a read-only fallback for a release.

The schema does not fork: both paths write `design_file_changes` and read through `document-store.ts`, which
learns to read a checkpoint key (B6). Roll back = flip the flag; the journal is the same table.

## 8. Failure modes

| Failure | Behaviour |
|---|---|
| Collab node dies | Lease expires in ≤ 15 s (or api sees the health check fail and expires it at once); clients reconnect through `/session`, a new owner loads checkpoint + tail (TARGETS D2 ≤ 3 s). Acked ops are in PostgreSQL: zero loss. Unacked ops are re-sent by the client with their `seq`. |
| Split brain (old owner still alive) | Every journal insert carries the lease `fence`; the table has `(file_id, version)` as primary key and a `CHECK` through a trigger that the fence equals `design_files.fence`. The old owner's inserts fail; it closes its sockets with `bye {moved}`. |
| PostgreSQL down | Acks pause (D3); ops queue in memory up to 64 MB per node; presence continues; after 30 s clients show "Offline"; nothing is lost that was acked. |
| S3 down | Checkpoints retry with backoff; the journal tail grows (bounded by the 20 000-row rule becoming soft); cold loads of files without a recent `design_files.document` copy fail with 503 until S3 returns. |
| Slow client | §2 backpressure; never slows the actor. |
| Poison op (panics the actor) | `catch_unwind`, the op is refused with `design_document_invalid`, the panic is traced with the op's digest, the actor continues from the last good document. |
| Memory cap of a document hit | The actor refuses ops that grow the document (413 `design_documents_limit`), as today. |

## 9. Observability

`tracing` spans per op (`file`, `client`, `bytes`, `merge_us`, `check_us`, `apply_us`, `journal_us`, `fanout_us`,
`ack_us`), sampled 1 % plus every op over 20 ms. Prometheus `/metrics` on each service: `op_ack_seconds`
(histogram), `op_fanout_seconds`, `journal_commit_seconds`, `docs_open`, `doc_resident_bytes`, `conn_open`,
`send_queue_bytes`, `presence_dropped_total`, `catchup_total`, `lease_moves_total`, `checkpoint_seconds`,
`render_job_seconds`. OTLP to a self-hosted Grafana + Tempo + Prometheus in the same DC (no third-party SaaS).
`scripts/bench/collab-load.ts` reads the same histograms, so the loop measures what production shows.

## 10. Deployment

Two production VMs minimum at one hosting provider (dedicated VMs, not shared with any other
service): `ru-4` runs api + collab + render under systemd (Docker Compose today; k3s only if nodes > 3); a
second VM runs PostgreSQL primary with a streaming replica (sync or async = TARGETS D4, the operator's choice ★) and
the observability stack. Production access is **operator-only**. Beside it, **bench-ru** ★: a non-production VM of the
same shape plus a small ru-net VM, provisioned by the deploy script, with SSH for benchmarks only
and `scripts/bench/close.sh <hash>` deploys a hash and runs the closing numbers (TARGETS §0). Nothing from
production — no data, no secrets, no domain — is ever on bench-ru. S3-compatible storage and CDN from the same provider. Caddy terminates TLS for api and the
WebSocket (`/collab/*` with `flush_interval -1`, idle timeout 1 h). Collab nodes scale horizontally by adding
VMs: the lease spreads files, nothing else changes. Deploys: a collab node drains (stops taking leases, checkpoints
every document, closes sockets with `bye {shutdown}`; clients reconnect to the other node) — zero data loss, a
2–3 s hiccup per file.

## 11. Security

Ticket on the socket (Ed25519, 60 s, bound to user + file + role + origin); `Origin` check on the upgrade; the
session cookie is **not** sent on the socket. Per-file ACL cached and pushed (A4). Rate limits per client and per
account (ops, bytes, presence 30 Hz, socket opens 60/min). Every op validated by `checkPatchedDocument` (ops
crate) before it reaches the document; pictures must be the account's own (as today). Max message 8 MB, max
document per cap. Internal endpoints (`/internal/*`) bound to the private network with a shared secret. Secrets
in `.env.local`/systemd credentials, never in the repo.

Who mints tickets (TARGETS A2): `GET /api/design-files/:id/session` is served by the collab nodes that hold
the signing key (`MORFA_COLLAB_TICKET_PRIVATE_KEY`, the private half of `MORFA_COLLAB_TICKET_KEY`), with api's checks
in api's order and the same SQL text (`server/design/collab/sql/session.sql`, `crates/collab/src/session.rs`); Caddy
routes that one path to the nodes, and api's own route stays as the oracle and the fallback. The cookie still never
reaches the socket. A node with the private key can mint any ticket, which adds little to what a node already holds
(the database URL, the internal secret); rotating the key changes api's and every node's settings together.

## 12. Compared with Figma's published architecture

Same: WebSockets, a central authority per document, the server holds the document in memory, a rewrite of the
hot path in Rust for GC-free latency, reconnection by re-applying unacknowledged local edits. Different: Figma
runs a process per document and we run an actor per document in one process (cheaper memory; weaker isolation,
mitigated in §8); Figma's merge is last-writer-wins per property with fractional indexing for order, ours is
field-level with one level of record merge, `parentId`-driven lists rebuilt by `mergeList`, and the structural
rules of `docs/design-tool.md` "Merge rules"; Figma re-downloads the document on reconnect, we catch up from the
journal and reload only past TARGETS M9; Figma's live metadata layer (LiveGraph) reads the replication stream, we
use PostgreSQL `NOTIFY` plus pushes, which is enough at our scale and is revisited only if A-rows miss.
