# Morfa

Morfa is an open-source design tool for the browser and the desktop, in the spirit of Figma. It has vector
editing and boolean operations, auto layout, components and variants, variables with modes, styles and shared
libraries, prototypes, boards with stickies and meetings, real-time co-editing with comments and version history,
a Dev Mode with code export (React, Vue, CSS and Tailwind), Figma import, and export to SVG, PDF, PNG, JPG and WebP.

The editor is TypeScript and React. The heavy parts are Rust crates compiled to WebAssembly: the document model,
geometry and booleans, layout, text shaping, the GPU renderer, export, and operations and merging. Their
TypeScript implementations are kept as a fallback. A Node server keeps accounts, files and teams in PostgreSQL,
and a Rust service handles live co-editing.

## Repository layout

| Path | What |
|---|---|
| `src/` | The web app: the design editor (`src/design/`), the file browser, the admin console |
| `shared/` | Code shared by the browser and the server: the document model, codegen, Figma import |
| `server/` | The Node API: accounts, design files, teams, comments, the MCP server, admin |
| `crates/` | The Rust engine and services (see `crates/README.md`) |
| `desktop/` | The desktop app (Tauri 2) |
| `tests/` | Unit tests (`node:test` through tsx), PostgreSQL tests and Playwright e2e specs |
| `scripts/` | Type check, wasm builds, fixtures, benchmarks, deploy tooling |
| `deploy/` | Reference configs for self-hosting: systemd units, Caddy, PostgreSQL, backups, observability |
| `docs/` | Architecture and feature docs (start with `docs/design-tool.md` and `docs/BACKEND.md`) |
| `vendor/` | Patched copies of the vello crates (see `vendor/README.md`) |
| `integrations/` | A Claude Code plugin that talks to Morfa's MCP server |

## Quick start

You need Node 22.23.2 (`.nvmrc`), PostgreSQL 18 (Docker works, see `docs/dev.md`), and the Rust toolchain from
`rust-toolchain.toml` with `wasm-pack` to build the WebAssembly modules.

```sh
npm ci
cp .env.example .env.local   # set MORFA_DATABASE_URL; everything optional stays off when unset
MORFA_MIGRATION_DATABASE_URL=… npm run db:migrate -- --mode fresh   # see .env.example for the roles
npm run fonts                # copies the font files into public/fonts
scripts/wasm-build.sh        # and the other scripts/wasm-*-build.sh for the Rust engine (optional)
npm run dev                  # API on 3400, app on 5400
```

Open http://127.0.0.1:5400/#designs and type a name. That is the whole sign-in: a name maps to an account and
there are no passwords (`docs/authentication.md`). Keep a public deployment on a private network or behind your
own authenticating reverse proxy.

```sh
npm run check        # type check
npm run test:design  # design unit tests
npm run test:pg      # PostgreSQL tests (needs the test cluster, see docs/dev.md)
npm run test:e2e     # Playwright e2e
cargo test --workspace
```

`docs/dev.md` covers the database, the test cluster, the wasm builds, the type check and the test suites.

## Configuration

Every setting is an environment variable, documented in `.env.example` and `deploy/env/*.env.example`. Optional
features stay off until they are configured: outgoing e-mail over SMTP, the server's vector PDF export, the MCP
server for AI assistants (`docs/mcp-server.md`), marketplace connections (`docs/marketplaces.md`), the Rust
co-editing service and big-file mode.

## Before you deploy your own copy

The repository uses placeholders where a real deployment has its own details:

- **Domain.** `morfa.example` (the base name, with the desktop downloads, collab and updater hosts) and
  `app.morfa.example` (the app) appear in the desktop app's allowed origin, the Caddy configs and the Claude Code
  plugin. Search the tree for `morfa.example`.
- **Desktop app.** The bundle identifier (`example.morfa.desktop`) and the updater's public key in
  `desktop/src-tauri/tauri.conf.json` (`docs/desktop.md`).
- **Brand.** The name "Morfa" lives in one constant, `PRODUCT_NAME` in `shared/design/product.ts`, and the logos
  are in `assets/brand/`.

## Third-party code and fonts

`vendor/` holds patched vello crates under their original Apache-2.0 / MIT licenses. The fonts in `assets/fonts/`
carry their own licenses next to each font (mostly the SIL Open Font License; Ekran is under its author's free
license, see its `LICENSE.txt`). npm and Cargo dependencies keep their own licenses.

## License

MIT, see `LICENSE`.
