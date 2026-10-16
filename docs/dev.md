# Running Morfa locally

How to install, run and check the TypeScript app on a Mac. There is no CI:
`scripts/gate.sh` is the gate, and it runs locally before every push to `main`.

## Requirements

- A Mac on arm64 with **Node 22.23.2 for arm64** first on `PATH`
  (`export PATH=$HOME/.nvm/versions/node/v22.23.2/bin:$PATH`). An x64 Node breaks esbuild (Vite, tsx); the gate
  refuses to start with one.
- Docker Desktop with the `postgres:18` image already pulled (the test cluster never pulls: `pull_policy: never`).
- Chromium for Playwright 1.63: `npx playwright install chromium` (skip it if `~/Library/Caches/ms-playwright`
  already has `chromium-1243`). The e2e suite and the design tool's vector PDF use it.
- `npm ci`. `node_modules` may be a symlink to an install outside the checkout (`.gitignore` lists `node_modules`
  without a slash so the link is never committed); Vite allows that real path.

## Ports

| What | Port | Set in |
|---|---|---|
| App (Vite dev server, `#designs`) | 5400 | `vite.config.ts` |
| API (`server/index.ts`) | 3400 | `package.json` `dev` (`PORT=3400`); Vite proxies `/api`, `/uploads`, `/fonts` to it |
| e2e app / API | 4400 / 4401 | `playwright.config.ts` (`E2E_PORT`, `E2E_API_PORT`) |
| PostgreSQL test cluster | 5440 by default; one port per checkout (for example 5440 and 5442) | `--port` below |

## Run the app

```sh
npm run fonts                 # copies the font files into public/fonts (gitignored); once, and after font changes
npm run dev                   # API on 3400, app on 5400
open http://127.0.0.1:5400/#designs
```

The API reads its database and flags from `.env.local` (see `.env.example`: `MORFA_DATABASE_URL`,
`MORFA_MIGRATION_DATABASE_URL`, `MORFA_BACKUP_DATABASE_URL`, `DESIGN_*`). Nothing has to be switched on to sign in: the
app asks for a name (`docs/authentication.md`). Migrate a database with `npm run db:migrate`.

## The PostgreSQL test cluster

`npm run test:pg` and `npm run test:e2e` run against an isolated, disposable PostgreSQL 18 in Docker, created by
`scripts/postgresql/test-cluster.mjs` (`compose.postgresql-test.yaml`). Every test file gets its own freshly
migrated database in it. The state directory holds the cluster's credentials, so the script requires it to be
**outside the repository**, owned by you and private (mode 0700):

```sh
STATE=$HOME/.cache/morfa-pg/$(basename "$PWD")     # any private path outside the checkout
mkdir -p "$STATE" && chmod 700 "$STATE"
npm run db:test-cluster -- up --port 5440 --state-dir "$STATE"
set -a; . "$STATE/cluster.env"; set +a            # MORFA_TEST_DATABASE_URL, _CLUSTER_ID, _CLUSTER_TOKEN, _ENDPOINT
npm run test:pg                                    # tests/postgresql-*.test.ts, four files at a time
npm run db:test-cluster -- status --state-dir "$STATE"
npm run db:test-cluster -- down --state-dir "$STATE"
```

- Use a port no other checkout or session uses; never 5432.
- If `up` fails with only "failed during owned test cluster startup", a leftover empty Docker network is the usual
  cause: `docker network ls` shows `morfa-postgres-test-<id>_default` networks. Remove only empty ones that are
  yours (`docker network inspect <name>` lists no containers), never another session's containers.
- After `down`, remove the cluster's own leftover `…_default` network if it is still there and empty.
- `MORFA_PG_TEST_CONCURRENCY` changes the four files at a time.

## Tests

| Command | What |
|---|---|
| `npm run test:design` | the design unit tests, `tests/design-*.test.ts` (node:test through tsx) |
| `npm test` | every `tests/*.test.ts`: the design tests and the PostgreSQL files (load the cluster env first) |
| `npm run test:pg` | `tests/postgresql-*.test.ts`; refuses to run without the cluster env, so it never passes by skipping |
| `npm run test:e2e` | `tests/e2e/design-*.spec.ts` in Chromium against `scripts/e2e-server.ts` (needs the cluster env) |

- Unit tests that read fonts need `public/fonts`: run `npm run fonts` first (the gate does).
- Node reports the host in `navigator.platform` ("MacIntel" on a Mac), and the design keyboard reads it, some of it
  when a module loads (`src/design/engine/commands/align.ts`, `mask.ts`). The three tests that assume a host that is
  not a Mac (`design-align`, `design-boolean-commands`, `design-editor-commands`) import
  `tests/helpers/linux-platform.ts` first, which pins Linux's value for that file; the others pass `mac` themselves.
- e2e: one worker, no retries (a spec that passes only on a second attempt is a failure), Chromium only.
  `E2E_OUTPUT_DIR` sets where reports, traces and videos go (default: the system temp folder; the gate uses
  `output/gate/<time>/e2e`). `PLAYWRIGHT_CHROMIUM` points at another Chromium binary. `MORFA_E2E_WARMUP=0` skips
  transforming the editor's module graph before the first spec. Each test gets a new account and session from
  `/__e2e/fixtures`; the server deletes its database and data folder when it stops.

## Type check

`npm run check` type-checks every file of `tsconfig.json` in four programs, one after another, each in its own
process under a 2 560 MB heap with 300 MB to spare (`scripts/typecheck/`): `shared`, `server` (with `scripts/`),
`design` (`src/design/`) and `client` (the rest of `src/`). Tests and root configs join the program that already
loads most of what they import. `npm run check -- --plan` only writes `.typecheck/<program>.json`; any program then
runs by hand with `npx tsc -p .typecheck/<program>.json`. Never put a bare `tsc --noEmit` over everything into a
script: the split is what keeps the check inside the cap.

Each run prints what every program needed (`type check design: ok, 1077 files, 756 MB of 2260 MB, 7 s`).

### When a program outgrows its limit

A program that passes with more than 2 260 MB fails the check with a pointer to this section.

1. If the program has many tests, raise its `testPrograms` in `scripts/typecheck/plan.ts` by one: its tests are
   divided between that many programs (`design`, `design-2`). Each extra program loads again what its tests import.
2. If the program is big without its tests, give part of it its own entry in `SOURCE_PROGRAMS`, before the entry
   that holds it now (for example `src/design/editor/` before `src/design/`).
3. Raise `heapMb` in `scripts/typecheck/main.ts` only when neither helps.

## Build and bundle budgets

`npm run build` = fonts → `check` → `build:app` (`dist/app`) → `performance:budgets`. The build writes no source maps.

`scripts/performance/budgets.mjs` measures each route's initial JavaScript (gzip level 9) and fails over the
ceilings — `designFiles` (`#designs`) 230 KiB, `designEditor` (`#design/<id>`) 700 KiB — or when a route grows more
than max(10 KiB, 5 %) past `scripts/performance/initial-js-baseline.json`. That baseline starts at the numbers accepted for the same routes at the source commit (214 400 and 680 282 bytes). After a reviewed change that grows a
route on purpose, accept the new numbers with `node scripts/performance/budgets.mjs --accept-baseline` (ceilings
never move that way) and commit the file. The full report is written to `output/performance/`.

The production build needs `VITE_APP_ORIGIN` (an absolute https origin) for a real deploy. Without it the build falls
back to `https://app.morfa.example` (the placeholder domain).

## The gate

```sh
MORFA_TEST_ENV_FILE=$STATE/cluster.env scripts/gate.sh   # on the Mac: everything (or load cluster.env yourself)
MORFA_CLOUD=1 scripts/gate.sh                            # cloud sessions: no PostgreSQL, no e2e
```

Steps, in order: `fonts`, `check`, `test:design`, `test:pg`, `build` (`build:app`, budgets; fonts and
the check already ran), `test:e2e`. Every step runs even after another failed, so one run shows everything that is
red; without `MORFA_CLOUD=1` a missing cluster env fails `test:pg` and `test:e2e` instead of skipping them. Logs and
e2e artifacts go to `output/gate/<time>/` (gitignored), and the run ends with one table, also saved there as
`summary.txt`:

```
step         result seconds  note
fonts        PASS         1
check        PASS        16
test:design  PASS        14
test:pg      PASS       …
build        PASS       …
test:e2e     PASS       …
total        PASS       …
```

The exit status is 0 only when every step that ran passed. The Rust half (`scripts/gate-rust.sh`, cargo and the wasm build) runs at
the start of the script (step `rust`).

## Co-editing on the collab service (DESIGN_COLLAB)

The api is the control plane of the Rust service `morfa-collab` (docs/BACKEND.md §5, §7; `server/design/collab/`).
Nothing changes until a node is configured: without `DESIGN_COLLAB_NODES` every file stays on SSE + PATCH.

| Setting (api) | What |
|---|---|
| `DESIGN_COLLAB` | `legacy` (default), `shadow` (PATCH stays authoritative and is mirrored to collab's `/internal/shadow-op`), `rust` (the editor opens the socket through `GET /api/design-files/:id/session`) |
| `DESIGN_COLLAB_ACCOUNTS` | per account or team: `<id>=<mode>,…`; a file follows its team's entry, then its holder account's, then `DESIGN_COLLAB` |
| `DESIGN_COLLAB_NODES` | `name=http://internal:port[\|wss://public]`, comma-separated; `name` is the node's `MORFA_COLLAB_NODE` |
| `DESIGN_COLLAB_INTERNAL_SECRET` | the bearer secret both ways (`MORFA_COLLAB_INTERNAL_SECRET`), ≥ 16 characters |
| `DESIGN_COLLAB_TICKET_KEY` | the Ed25519 private key of the socket tickets (`morfa-collab keygen` prints the pair) |
| `DESIGN_CHECKPOINT_DIR` | where collab writes checkpoints when it uses a directory (`MORFA_COLLAB_CHECKPOINT_DIR`); with `DESIGN_BLOBS=s3` they are read from the bucket |
| `DESIGN_COLLAB_WIRE`, `DESIGN_COLLAB_SHADOW_LOG`, `DESIGN_COLLAB_BODY_LIMIT` | `binary` socket wire in /api/config; the shadow mismatch log (JSON lines); collab's /internal body limit (2 MiB today) |

Locally (PostgreSQL from the test cluster or `.env.local`):

```sh
CARGO_TARGET_DIR=~/.cache/morfa-target/gate cargo build -p morfa-collab
~/.cache/morfa-target/gate/debug/morfa-collab keygen        # MORFA_COLLAB_TICKET_PRIVATE_KEY / MORFA_COLLAB_TICKET_KEY
MORFA_COLLAB_ADDR=127.0.0.1:3420 MORFA_COLLAB_NODE=local MORFA_COLLAB_TICKET_KEY=<public> MORFA_COLLAB_INTERNAL_SECRET=<secret> \
  MORFA_COLLAB_PG_URL=<the api's MORFA_DATABASE_URL> MORFA_COLLAB_API_URL=http://127.0.0.1:3400 \
  MORFA_COLLAB_CHECKPOINT_DIR=data/collab-checkpoints ~/.cache/morfa-target/gate/debug/morfa-collab
# api: DESIGN_COLLAB_NODES=local=http://127.0.0.1:3420 DESIGN_COLLAB_INTERNAL_SECRET=<secret> DESIGN_COLLAB_TICKET_KEY=<private>
#      DESIGN_CHECKPOINT_DIR=data/collab-checkpoints DESIGN_COLLAB_ACCOUNTS=<your account id>=rust
```

`/internal/*` of both services must stay on the private network. Tests: `tests/postgresql-runtime-design-collab-*.test.ts` and
the `*.shadow` / `*.rust` wrappers of the legacy suites need the binary (the gate's `cargo test` builds it into
`~/.cache/morfa-target/gate`); `MORFA_SHADOW_FUZZ_OPS=10000` runs the shadow pass condition; `npx tsx scripts/collab-shadow-report.ts
<log>` prints a mismatch log as tables.

### Render service (`crates/render-service`, binary `morfa-render`)

SVG and the vector PDF without Chromium (`DESIGN_PDF_ENGINE=service`). The api sends everything a job
needs (`POST /internal/render`, server/design/pdf/service.ts), the service reads only the font files:

```sh
cargo build --profile service -p morfa-render-service     # opt-level 3 (the release profile is size-first, for wasm)
MORFA_RENDER_ADDR=127.0.0.1:3440 MORFA_RENDER_INTERNAL_SECRET=<secret> MORFA_RENDER_FONTS_DIR=$PWD/public/fonts target/service/morfa-render
# api: DESIGN_PDF_ENGINE=service DESIGN_RENDER_URL=http://127.0.0.1:3440 DESIGN_RENDER_SECRET=<secret>
npx tsx scripts/render/requests.ts && target/service/morfa-render job output/B4/requests/x4-product.mrr out.pdf --runs 5
```

## Big files (DESIGN_BIG_FILES)

The decision in docs/TARGETS.md §9 replaces the 50 000-layer / 20 MB cap with a memory budget and pages loaded on demand
once the GPU renderer meets C3/C11; until then it is a switch, off by default (docs/decisions/big-files.md):

| Setting | What |
|---|---|
| `DESIGN_BIG_FILES=1` (api) | the caps become `DESIGN_BIG_FILE_CAPS` (2 000 000 layers, 1 GiB, 1 000 pages); `/api/config` says `bigFiles: true` and the editor opens files as a skeleton plus one page (`GET /:id?pages=skeleton`, `GET /:id/pages/:pageId`), with the memory budget (2 GiB per tab, warnings at 60 % and 75 %, hidden pages let go) under the file name |
| `MORFA_BIG_FILES=1` (collab, the Rust tests) | the model crate's caps (`morfa_model::limits::big_files`) and the engine limits follow |
| `?bigFiles=1` in the address | the editor's page loading and budget alone (a local run, `tests/e2e/design-big-files.spec.ts`); the server's caps stay as set |

Benches: `tsx scripts/bench/open-save.ts --machine laptop --only S1,S2,S5` (the api path on f100k with the switch),
`tsx scripts/bench/storagesim-open-save.ts --doc fixtures/bench/f100k.json` (the collab checkpoint path, S1/S3),
`checkpoint-bench fixtures/bench/f100k.json` (W4/W5). SQL013 moved the fixed caps out of the database.

## Rust

The engine is a Cargo workspace (root `Cargo.toml`, `crates/*`; crate map and who edits what in
`crates/README.md`). `rust-toolchain.toml` pins Rust 1.99 with the `wasm32-unknown-unknown` target, clippy and
rustfmt; rustup installs it on first use. wasm-pack (`cargo binstall -y wasm-pack`) builds the `wasm` crate. It
needs the wasm-bindgen CLI of exactly the version in `Cargo.lock` and binaryen's `wasm-opt` (release builds run
`wasm-opt -Os`, `crates/wasm/Cargo.toml`); it uses the ones on `PATH` when they fit and otherwise downloads them
on the first build (on the Mac: `brew install binaryen` also works). Node is the version in `.nvmrc`
(package.json `engines`: `>=22.23.2 <23`).

### Commands

| Command | What |
|---|---|
| `scripts/gate-rust.sh` | The Rust half of the gate, from any directory: `cargo fmt --all --check`, `cargo clippy --workspace --all-targets -- -D warnings`, `cargo test --workspace`, `scripts/wasm-build.sh`, then Node loads `server/design/wasm` and must print the workspace version. Stops at the first failure. `scripts/gate.sh` (the TypeScript half) calls it. |
| `scripts/wasm-build.sh` | Both wasm-pack release builds (below) and the size of each `.wasm` and JS glue, raw and gzip -9. |
| `node scripts/wasm-smoke.mjs` | Browser smoke: a bare Vite dev server (`vite.config.ts` is not loaded) serves `scripts/wasm-smoke.html`, Playwright's Chromium opens it, the page must show `morfa-wasm <version>`. Run `scripts/wasm-build.sh` first. Chromium is Playwright's own build for the installed `playwright-core`; `MORFA_SMOKE_CHROMIUM=<executable>` picks another (the cloud image has an older one: `/opt/pw-browsers/chromium-1194/chrome-linux/chrome`). |
| `cargo lint`, `cargo t` | Aliases (`.cargo/config.toml`) for the clippy and test steps of the gate. |
| `eval "$(scripts/cloud-setup.sh)"` | Cloud containers only, see below. |

### Where the wasm lands

| Build | Directory | Loaded by |
|---|---|---|
| `wasm-pack --target web` | `src/design/wasm/` (`morfa_wasm.js`, `morfa_wasm_bg.wasm`, `.d.ts`) | the editor: `import init, {version} from '…/design/wasm/morfa_wasm.js'`, then `await init()` |
| `wasm-pack --target nodejs` | `server/design/wasm/` (CommonJS, own `package.json`) | the server and the unit tests: `require('./server/design/wasm')`; ES modules can `import {version} from '…/server/design/wasm/morfa_wasm.js'` |

Both directories are build outputs and never committed: wasm-pack writes a `.gitignore` containing `*` into each
(`scripts/wasm-build.sh` checks it), and the gate rebuilds them. In a fresh checkout run `scripts/wasm-build.sh`
before anything imports them. The nodejs package has no `"type"` field, so its `.js` stays CommonJS even though
the root `package.json` says `"type": "module"`.

### The text engine switch

The engine switch's module `text` (`MORFA_ENGINE_TEXT` / `MORFA_ENGINE` / `?engine=`, `shared/design/engine-switch.ts`)
picks what lays text out, segments it and places carets: `shared/design/text-layout.ts` and `text-segment.ts`,
the Rust twin in `crates/text` through its own wasm modules, or both with every result compared. The
text engine is not inside `morfa-wasm`: `scripts/wasm-text-build.sh` builds `crates/text-wasm` (layout,
carets, segmentation; ≈ 76 KiB gzip) into `src/design/wasm-text/` + `server/design/wasm-text/` and
`crates/text-fonts-wasm` (the font store, harfrust shaping, skrifa outlines; ≈ 500 KiB, 407 without the
woff2 decoder: `MORFA_WASM_TEXT_FEATURES=--no-default-features`) into `src/design/wasm-fonts/` +
`server/design/wasm-fonts/`. Node loads both on first use (`shared/design/text-engine.ts`); the editor loads them
as dynamic chunks (`src/design/engine/text-wasm.ts`) when the module runs as wasm or both, never on first load.
Under
`wasm`, faces the registry loaded measure in Rust (harfrust) and `MORFA_TEXT_GLYPHS=outline` (or
`setTextGlyphMode`) draws glyphs from the engine's outlines instead of `fillText`. The browser harness
behind T3/T4 and the perf bars: `node scripts/text-engine/run-harness.mjs` (writes `output/L3/`).
`npx tsx scripts/text-engine/bench-layout.ts` times the boundary alone. `withEngine('text', …)`
replaces the mode variable when it lands.

### The geometry module

Booleans and the outline stroke (`shared/design/boolean.ts` `fillArea`/`combineAreas`/`areaToPaths`/`combinePaths`,
`outline-stroke.ts` `strokeArea`/`dashPolylines`/`polygonsToSmoothPaths`) run through `withEngine('geometry', …)`
on the Rust port in a wasm module of its own, so `morfa-wasm` stays within its 700 KiB: `scripts/wasm-geometry-build.sh`
builds `crates/geometry-wasm` (≈ 87 KiB gzip, budget `MORFA_WASM_GEOMETRY_BUDGET_KIB`, default 150) into
`src/design/wasm-geometry/` + `server/design/wasm-geometry/`. Node requires it on first use
(`shared/design/geometry-wasm.ts`, `MORFA_WASM_GEOMETRY_PATH` overrides the path); the editor loads it as a dynamic chunk
(`src/design/engine/geometry-wasm.ts`) when geometry runs as wasm or both, and until it is installed those calls fall
back to TypeScript (counted). `worldMatrix`/`worldBox` stay `morfa-wasm`'s readers of the shadow document. The
differential harness builds the same crate with its feature `harness` (`scripts/geometry/build.sh`, then
`scripts/geometry/gate.sh` and `scripts/geometry/diff.ts`).

### Target directories and sccache (the Mac)

Parallel checkouts or branches build into their own target directories and share one sccache:

```sh
export CARGO_TARGET_DIR=~/.cache/morfa-target/<name>   # one per checkout or branch
export RUSTC_WRAPPER=sccache                           # brew install sccache (or cargo binstall sccache)
```

Why: cargo locks the build directory for the whole build, so builds sharing a target directory wait for each
other ("Blocking waiting for file lock on build directory"). Separate directories compile in parallel, and
sccache still shares the compiled dependencies between them (it caches the non-incremental crates; each
checkout's own workspace crates build incrementally in its directory). Disk is the limit, which is
also why dependencies keep `debug = "line-tables-only"` (root `Cargo.toml`); cap the cache with
`SCCACHE_CACHE_SIZE` if needed and check `du -sh ~/.cache/morfa-target/*` now and then.

### Cloud containers

```sh
eval "$(scripts/cloud-setup.sh)"   # or run it and paste the export lines it prints
MORFA_CLOUD=1 scripts/gate-rust.sh
```

`scripts/cloud-setup.sh` is idempotent and prints what it skipped: it installs the toolchain from
`rust-toolchain.toml`, cargo-binstall (`cargo install`), wasm-pack and the wasm-bindgen CLI of `Cargo.lock`'s
version (`cargo binstall`, falling back to `cargo install`), binaryen's `wasm-opt` (the release tarball wasm-pack
would fetch, sha256-checked, into `~/.cargo/bin`), Node from `.nvmrc` when the container's Node does not fit
`engines` (the nodejs.org tarball, sha256-checked, into `/opt/node-v<version>`; set `MORFA_NODE_DIR` to change),
and runs `npm ci` when `node_modules` is missing or older than `package-lock.json`. Behind the cloud proxy
wasm-pack's own downloads fail and cargo-binstall finds no prebuilt binaries (GitHub's API answers 403), so the
first run compiles everything from source: ≈11 minutes with two jobs (cargo-binstall ≈7.5, wasm-bindgen-cli ≈2,
wasm-pack ≈1); `curl` downloads (Node, binaryen) work. Its export lines set `PATH` (when it installed
Node), `CARGO_BUILD_JOBS=2 MORFA_CLOUD=1` and, when unset, `CARGO_TARGET_DIR=~/.cache/morfa-target/<name>` (the
name from the branch). `MORFA_CLOUD=1` skips whatever needs e2e browsers or PostgreSQL; the Rust half needs
neither, so `scripts/gate-rust.sh` runs all its steps either way.
