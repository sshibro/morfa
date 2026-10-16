# Morfa — the vector design tool

An open-source design tool for the browser, for designers and small studios.
It follows Figma's mental model: the same tools, panels and
shortcuts. Teams share workspaces with roles (§Teams, step 1), comment on files (§Teams,
"Comments") and edit one file together with live cursors (§Teams, "Co-editing"). This file is the architecture
contract every module follows; read it before changing anything under `shared/design/`,
`src/design/` or `server/design/`.

## Product

| | |
|---|---|
| Name | Morfa (UI: "Design"). Figma's name appears only in factual references (import from Figma, the parity docs); never its logo, icons or brand styling. |
| Audience | Designers, students and small studios who want a free, self-hostable design tool, plus anyone making banners and social graphics. |
| Scope | A pure design tool: Figma's tools, panels, exports and usability, plus design → React code. Personal files, and team workspaces with roles on the same model (§Teams). |
| Limits | Every account gets the same limits (`DESIGN_LIMITS` in `shared/design/limits.ts`): files and boards are not limited in number, 20 GB of pictures, 365-day version history, 365 days in the trash, named versions, every tool and export format, Figma import, sharing and co-editing. Hard caps that protect the server (`DESIGN_DOCUMENT_CAPS`: layers, JSON bytes, pages, picture size) hold for everyone. |
| Flags | `ENABLE_DESIGN_TOOL=1` turns the product on (`server/index.ts` sets it, so a running server has it on; tests can leave it off). `DESIGN_TOOL_ACCOUNTS` limits it to listed accounts (a staged rollout). |

## Layout of the code

| Path | What | Rules |
|---|---|---|
| `shared/design/` | Pure TS: model (`types.ts`), factories (`defaults.ts`), maths (`geometry.ts`), patches (`patch.ts`), transactions, tree queries, layout, constraints, components, styles, paths, shapes, text layout, boolean geometry, schema (zod), limits, API types, Figma mapper. | No DOM, no React, no server imports. Every module has node tests (`tests/design-*.test.ts`). |
| `src/design/` | The client: routes, file browser, editor, engine runtime (store, renderer, tools, overlays), panels, player, import/export. | Reached from the app only through `import()`; never statically from `App.tsx`/`navigation.ts`/`Shell.tsx` (only `import type`). |
| `src/design/styles/` | The design language (below). | Every rule under `.dz`. No tokens from the app shell's own styles (`--rb-*`). |
| `server/design/` | Files API, storage, versions, thumbnails, images, limits. | Mounted at `/api/design-files`. |
| `tests/design-*.test.ts` | Unit tests. `tests/e2e/design-*.spec.ts` for browser flows. | |

## The document

`shared/design/types.ts` is the single source of truth. A file is a flat `nodes` map; pages are roots;
children are listed bottom-to-top. Invariants every writer keeps (the schema checks them on the server):

- Every node except pages has a `parentId` whose `children` lists it exactly once; no cycles.
- Containers (`CONTAINER_TYPES`) have `children`; leaves do not. Pages contain anything but pages.
- GROUP and BOOLEAN_OPERATION have at least one child and their box is the union of their children.
- Instance descendants have ids `${instanceId};${mainId}`, a `mainId`, and live only under an INSTANCE.
- `images[ref].url` is a same-origin `/uploads/<file>` of the owning account.
- Text runs are sorted, non-overlapping and inside `characters`.
- Sizes are ≥ 0 (LINE height is 0); numbers are finite.
- A page's `backgroundColor` is absent until the designer picks one: the canvas then shows the editor theme's default
  (`defaultPageBackground`: #F5F5F5 light, #1E1E1E dark, as in Figma), and "Page" says "Default".
  A picked colour stays in both themes; "Default color" removes it. Files made before 2026-10-07 keep the #F5F5F5
  they stored. Stored pictures (file thumbnails, template cards) use the light default; exports never paint the page.
- `constrainProportions` ("Lock proportions") is the layer's own, stored like Figma's: W and H in "Layout" and the
  canvas handles keep the aspect ratio while it is on (Shift does the same for one drag); copies inside an instance
  may override it.

Node fields mirror Figma's plugin API names (`fills`, `strokeAlign`, `layoutSizingHorizontal`,
`primaryAxisAlignItems`, `componentPropertyDefinitions`...), so a designer's vocabulary and a Figma
file both map one to one.

### Geometry

`(x, y)` is the box's top-left in the parent's space before rotation. Local → parent is
`translate(x, y) · rotate(−rotation°) · flip about the centre` (`localMatrix`). `rotation` is degrees,
positive is counter-clockwise on screen (as in Figma's panel). Matrices are `[[a, c, e], [b, d, f]]`.
Children of every container, groups included, are in that container's local space. A group's box is
refitted by `normalizeDocument` after each change (children shift so the group keeps its world position).

### Changing a document

Documents are immutable. All edits go through a transaction (`shared/design/transaction.ts`):

```ts
const tx = beginTransaction(doc);
tx.update(id, {fills: [...]});             // shallow merge into the node
tx.create(node, parentId, index?);         // index in children (bottom-to-top); default top
tx.remove(id);                             // the node and its subtree, and it leaves its parent's children
tx.move(id, parentId, index?, {keepWorld: true});
tx.setStyle(style) / tx.removeStyle(id) / tx.setImage(ref, asset) / tx.setPages(order) / tx.setVariable(...)
const {doc: next, patch, inverse, dirty} = tx.commit(normalizeContext);
```

`commit` runs `normalizeDocument` (text auto-resize → instance sync → auto layout → group fit) on the
dirty set, then returns the patch (for autosave) and its inverse (for undo). `DocumentPatch`
(`patch.ts`) replaces or removes whole entries; the server applies the same patches.

## Client engine (`src/design/engine/`)

- **Store** (`store.ts`): framework-agnostic. `getState()`, `subscribe()`, `transact(label, recipe, {select?})`,
  `gesture(label)` → `{update(recipe), commit(), cancel()}` (each `update` re-runs from the gesture's start, so
  drags never drift; one undo step per gesture), `undo()`, `redo()`, `setUI(partial)` for state that is not the
  document (tool, hover, viewport, panels). `onPatch(listener)` feeds autosave. React reads with
  `useDesignStore(selector)` (`useSyncExternalStore`).
- **Editor state**: `{doc, pageId, selection, hoverId, tool, viewport: {x, y, zoom}, editing: null | {kind: 'text' | 'vector' | 'gradient', id}, ...}`.
  Selection holds ids on the current page; the selection context (entered group/frame) follows Figma: click picks
  the top-most ancestor below the context, double-click enters, ⌘/Ctrl-click selects deep.
- **Renderer** (`render/`): Canvas2D with devicePixelRatio, two stacked canvases: the scene and the overlay
  (selection, handles, guides, measurements, labels, drawn in screen px so they stay crisp). The scene is
  redrawn on `requestAnimationFrame` after a change, culled by world bounds. One `paintNode` path renders the
  canvas, PNG/JPG/WEBP export, thumbnails and the prototype player.
  Supports: all node types, solid/gradient (linear, radial, angular, diamond)/image fills (fill, fit, crop,
  tile, filters), stroke align inside/center/outside, dashes, caps, joins, markers, individual stroke weights,
  corner radii + smoothing, drop/inner shadow with spread, layer and background blur, blend modes, opacity
  groups, masks (alpha/vector/luminance), clip content, text with runs, layout grids, section/frame labels.
- **Fonts** (`fonts.ts`): families from `shared/fonts.ts` + `shared/font-library.ts` (all carry Cyrillic),
  loaded on demand with `FontFace` from `/fonts/<dir>/…woff2`; a family that finishes loading re-lays-out the
  text that uses it. Local fonts via `queryLocalFonts()` when the browser allows.
- **Images** (`images.ts`): decode cache keyed by ref; uploads go to `POST /api/design-files/:id/images`.
- **Hit testing**: geometric, in page space, respecting rotation, clipping, masks, visibility and locks.
- **Tools** (`tools/`): one module per tool implementing `Tool {id, cursor, onPointerDown/Move/Up, onKeyDown?, onDoubleClick?, drawOverlay?}`.
- **Commands** (`commands/`): `registerCommand({id, label, shortcut?, run, enabled?})`. Menus, the context menu,
  "Actions" (⌘K; ⌘/ and ⌘P too) and shortcuts all read the registry, so a feature adds a command file and an import line.
  Shortcuts match `KeyboardEvent.code` (physical keys), so they work on any keyboard layout.
- **Panels**: left (pages, layers, assets), right (Design, Prototype, Code). Design-panel sections are components
  in an ordered registry (`panels/design/sections.ts`).

## Server API (`/api/design-files`)

Session required; another account's file is 404. Writes need the app `Origin`. All bodies JSON unless noted.
Types live in `shared/design/api.ts`.

| Route | Body → answer |
|---|---|
| `GET /` (`?trash=1`, `?team=<id>`, `&project=<id>`) | → `{files: DesignFileSummary[], usage: DesignUsage, limits: DesignLimits}`: personal files, or one team's (one project's) with the team's usage and the limits |
| `POST /` | `{name?, document?, clientId?, teamId?, projectId?, kind?}` → 201 `{file}` (`kind: 'board'` makes a board, docs/board.md). 409 `design_file_limit` past 5 000 files with the trash; 403 `design_forbidden` for a member who cannot edit. |
| `GET /:id` | → `{file, document, access?}`; `access` `{role, canEdit, team}` for a team file |
| `POST /:id/move` | `{teamId, projectId}` (null, null = personal) → `{file}`: another project of the same team for an editor; between personal files and a team for the file's holder and the team's managers |
| `PATCH /:id/document` | `{baseVersion, patch, before?, beforeTables?, client?}` → `{version, updatedAt, changes?, own?, resync?}`: with `before` copies a patch made on an older version merges into the current one (§Teams, "Co-editing"); without them a stale `baseVersion` is 409 `version_conflict` `{currentVersion}`. A body over 8 MB (`DESIGN_PATCH_MAX_BYTES`: a paste of thousands of layers) is 413 `design_document_too_large`; autosave then sends the whole document with `PUT` and goes on with patches on its version |
| `GET /:id/events` (`?since=<version>`) | → `text/event-stream`: the others' accepted changes in order, presence, access changes (§Teams, "Co-editing"); 429 `design_live_busy`, 503 `design_live_off` |
| `POST /:id/presence` | `{token, cursor?, page?, selection?, selectionCount?, viewport?, editing?}` → 204; 404 `design_live_gone` when the stream is closed, 429 when flooded |
| `PUT /:id/document` | `{baseVersion, document}` → `{version, updatedAt}` (restore, import, "Keep mine", a change too big for one PATCH); over 20 MB is 413 `design_document_too_large` and autosave stops with that message |
| `PATCH /:id` | `{name}` → `{file}` |
| `POST /:id/duplicate` | → 201 `{file}` |
| `DELETE /:id` | to the trash; `?permanent=1` erases. `POST /:id/restore` brings it back. |
| `PUT /:id/thumbnail` | `image/png` or `image/webp` body ≤ 512 KB → `{thumbnailUrl}` |
| `POST /:id/images` | multipart `file` → `{ref, asset}`; 413 `design_storage_limit` |
| `GET /:id/versions` | → `{versions: DesignVersionSummary[]}`; `POST` `{label}` saves a named version |
| `GET /:id/versions/:versionId` | → `{document}`; `POST …/restore` `{baseVersion}` → `{version}`; `POST …/duplicate` `{name?}` → 201 `{file}`: a new file in the file's place holding that version ("Duplicate file" in the version's menu), under a new file's checks; `PATCH …` `{label}` → `{version}` renames it ("Edit version info…"; an automatic version becomes named, within the named versions' limits) |
| `POST /:id/export/pdf` | `{version, nodeIds, title?, measurements}` → `application/pdf`, a page per layer (§Export); view access is enough |

Autosave sends patches about a second after the last change (one request in flight, batched), flushes on
`visibilitychange`/`pagehide`, and shows "Saved" / "Saving…" / "Offline" in the title bar: "Saving…" only
for a save still running after 1.5 s, a retry, or a save after a lost connection, so quick saves leave "Saved"
steady (`src/design/editor/chrome/save-indicator.ts`); trouble shows at once. Pictures upload two at a time per tab and
a busy answer (429) waits and goes again (`src/design/engine/upload-queue.ts`), so a drop of many pictures never loses
the ones past the server's three places. The server keeps an automatic version at most every 10 minutes of editing plus
every named version, pruned by `historyDays`. Documents are validated with `shared/design/schema.ts` and
capped (50 000 nodes, 20 MB).

"Version history" (`src/design/versions/`): a version shows read-only over the canvas with its own pages and layers in
the left panel; its menu (right-click, the context-menu key or ⇧F10) offers "Show version", "Restore this
version", "Edit version info…", "Duplicate file" and "Copy link to version" — `#design/<file>?version=<id>`,
which opens the file with that version shown (`src/design/engine/commands/link.ts`), as Figma's version links do.

**Lossless saving** (`src/design/persistence/patch-guard.ts`, `recovery.ts`). The server refuses a whole patch for
one bad value, and autosave carries an unsent patch into every later one, so a single bad layer would stop all later
work from saving. Designers never lose work this way:

- Before each request the patch is checked with the server's own schema, entry by entry (`patchIssues`: each entry's
  shape, without dropping keys) and then the invariants around the entries it touches (`patchedDocumentIssues`, against
  the server's copy, which autosave tracks per changed entry; the layer count is kept, not recounted). It costs about
  0.3 ms for a drag of a dozen layers and 0.1 ms for a keystroke in a 20 000-layer file (`tests/design-save-guard.test.ts`).
- A refused entry goes back to the server's copy as one change without an undo step: a new layer leaves with its
  subtree (layers the server already has move back out first), a saved layer gets its stored properties and place back,
  a style, picture or variable its stored value. Everything else is sent, and the user is told once per save in an
  error toast ("Could not save layer <name>: <reason>. The change was reverted.") with "Download a copy" (the open document as
  `.rdesign`).
- A refusal only the server can make (a picture of another account) is put back from the entry its answer names.
- An entry refused again after it was put back, a refusal that names no entry, or more than four recoveries without a
  stored save stop autosave (status `stopped`, "Not saved" in the title) with the "Saving stopped" card over
  the canvas: "Download a copy" first, then "Reload file", which opens the stored version and saves again. Never a
  silent loop. Pasted layers, SVG import and replace-all also check what they add before it reaches
  the store, so the guard is the safety net, not the first line.

Server details (`server/design/`, migration 031):

- Off (`ENABLE_DESIGN_TOOL`, `DESIGN_TOOL_ACCOUNTS`) every route is 404 `design_unavailable`; `/api/config` says
  `designTool`. Every route reaches a file only through `fileAccess(tx, userId, fileId, 'view' | 'edit' | 'admin')`
  (`file-access.ts`): the owner of a personal file, or a member of the file's live team with the role the need asks
  (§Teams); anyone else gets 404. A file in the trash can be opened and its versions read; edits answer 404 until it is
  restored.
- Errors are `{error, code, ...}`: 409 `version_conflict` carries `currentVersion`, 400 `design_document_invalid`
  (403 for a picture of another account) the `path` of the refused value and, when it belongs to one entry, `entry`
  (`{table, key}`: `nodes`, `styles`, `images`, `variables`, `variableCollections`, `variableModes`, or `pages` with a
  null key) and, for a layer, `nodeId` — the same for PATCH, PUT, create and restore; a refused `before` copy is
  reported as `before.…` with no entry, `design_file_limit`/`design_storage_limit`/`design_documents_limit` the `limit`.
- `PATCH /:id/document` also takes `before` (the client's copy of each patched node; null for a new one) and
  `beforeTables` (the same for the other tables and the page order). Both are checked and passed to
  `applyDocumentChange` (`apply.ts`), the one apply step, which merges the patch into the current version field by field
  (§Teams, "Co-editing"); without them a stale `baseVersion` is 409. Autosave validates the patch entries
  in full and the invariants of the nodes the merged result touches; create, replace and restore validate the whole
  document.
- Versions: an automatic copy of the replaced document at most once per 10 minutes of editing, and always before a
  replace or restore. Taking one prunes copies older than `historyDays` (named ones stay) and keeps at most 500 automatic copies; a file holds at most 200 named versions.
- Pictures (`design_images`) are files in `DATA_DIR/uploads` named `dz-<uuid>` (thumbnails `dzt-<uuid>.webp`), served
  to their owner by `GET /uploads/:filename`. They count against `storageBytes`. The bytes decide the type (JPEG, PNG, WebP, AVIF, GIF; SVG is refused, a vector is pasted as nodes); PNG and GIF
  stay lossless PNG, the rest become WebP, at most 4096 px on the longer side and 64 megapixels in. A document may point
  only at the account's own design pictures. `ref` is the filename without its extension.
- Storage of a document (SQL038, `document-store.ts`, §Performance "Saving large files"): `design_files.document`
  holds its JSON text at some version and `design_file_changes` the saves after it, one row per version up to
  `design_files.version`, so the document is the text with those changes applied. Every reader goes through the store
  (the editor's read, saves, copies, versions, restore, moves, library publishing, PDF export, the account export); a
  statement that reads `design_files.document` alone sees an older document. `bytes`, `node_count` and `image_files` are
  always the whole document's.
- Erasing a file (`?permanent=1`, the trash sweep `sweepDesignTrash()` in `lifecycle.ts`, run by the scheduler) takes its
  versions, thumbnail and every picture no other file or version of the account uses. Account erasure and the data export
  include the design rows (`eraseDesignAccount`, `exportDesignAccount`).
- Limits: 600 document writes per 10 minutes, of which at most 60 new files, replaces and restores (each parses and
  checks a whole document, about 1.5 s of the event loop for 20 MB), 120 other writes and 60 picture uploads per minute per account; two
  document bodies at a time per account, taken before the body is read, and 16 on the server, taken only once the body
  has arrived (pictures: three per account, eight on the server, the same way), so a slow sender holds only its own
  account's places; each body must arrive within its window (its declared length at 64 KB/s, from 15 seconds to five
  minutes) or is answered 408 `request_timeout`; four document or version reads at a time (32 on the server); 5 000 files per account including the trash. An
  account's documents and saved versions together, the trash included, hold at most 5 GB of JSON
  (`DESIGN_DOCUMENT_CAPS.accountBytes`, `DESIGN_ACCOUNT_DOCUMENT_BYTES` overrides), because a version, a restore or a copy
  stores a full document of up to 20 MB for a request of a few bytes. Automatic versions give way to new work, oldest
  first; when files and named versions alone fill it, a new file, a copy, a named version, a restore and a save that
  grows a file are refused with 413 `design_documents_limit` (an automatic copy is skipped instead). The room is the
  holding account's (`server/design/room.ts`): a team's files count for the team's owner, so a file an admin moves into
  the team and a team handed over must fit the room of the account that will hold them; a handover never makes the new
  owner's automatic versions give way and is refused instead.

## Design language (`src/design/styles/`)

Neutral and precise, the look professionals know from desktop design tools. Nothing from the app shell's styling.

| Token | Light | Dark |
|---|---|---|
| `--dz-canvas` | `#F5F5F5` | `#1E1E1E` |
| `--dz-panel` | `#FFFFFF` | `#2C2C2C` |
| `--dz-border` | `#E6E6E6` | `#444444` |
| `--dz-hover` | `#F5F5F5` | `#383838` |
| `--dz-field` | `#F5F5F5` | `#383838` |
| `--dz-text` / `-2` / `-3` | `#1E1E1E` / `#6E6E6E` / `#B3B3B3` | `#FFFFFF` / `#B3B3B3` / `#7A7A7A` |
| `--dz-accent` (selection, focus, primary) | `#0D99FF` | `#0D99FF` |
| `--dz-accent-text` / `--dz-selected-row` | `#006BC9` / `#E5F4FF` | `#7CC4F8` / `#0C3A5E` |
| `--dz-component` (components, instances) | `#9747FF` | `#A673FF` |
| `--dz-guide` (smart guides, measurements) | `#F24822` | `#F24822` |
| `--dz-success` / `--dz-danger` | `#14AE5C` / `#F24822` | same |
| `--dz-success-text` (green badges and labels) | `#0A7A3C` | `#5AD08F` |
| `--dz-menu` (menus, tooltips: dark in both themes) | `#1E1E1E`, text `#FFFFFF`, hover `#0D99FF` | same |

Secondary text and accent text are a step darker than Figma's (`#757575`, `#007BE5`) so they keep 4.5:1 on fields and
selected rows (WCAG AA); primary buttons keep white on `#0D99FF`.

Type: Inter Variable (`@fontsource-variable/inter`, has Cyrillic), 11 px / 16 px for UI, 12 px for panel titles,
weights 450 / 550 / 600, tabular figures in number fields. Controls 24 px tall in panels (32 px in the toolbar),
radius 5 px; panels 240 px wide (resizable 200–480); menus radius 12 px with 4 px inset; icons 16 px, 1.5 px
stroke, drawn in `src/design/ui/icons.tsx` (no lucide-react in the design area). Layout: the left panel carries the file menu and name, the right panel's header carries Share, the player (▶),
export and zoom; the toolbar floats at the bottom centre (48 px, Figma UI3's groups, Actions and the modes: §"Toolbar, Actions and modes"). Theme follows
the system with a manual override (`.dz[data-theme]`). Motion follows `src/motion/presets.ts` and the polish
skills: no animation on canvas interactions, 120–160 ms for menus and panels, 200 ms for dialogs (`--dz-modal`); icon
buttons, tabs and segments change at once; anything opened from the keyboard appears at once (the root's `data-input`);
things placed over the canvas move by `translate`, so a press `scale` stays about their middle. The inventory and the
findings: docs/design-motion-audit.md.

## Shared vocabulary

Product name: key `product.name` → "Morfa" (decided 2026-10-08; `PRODUCT_NAME` and `PRODUCT_VOCABULARY` in `shared/design/product.ts`).
Every user-facing string that names the product reads it; never write the name as a literal.

The interface is in English and uses Figma's own words wherever Figma has an equivalent, so a designer's vocabulary carries
over. The words the code, the commands and these docs share:

Tools: Move (V), Scale (K), Frame (F, A), Section (⇧S), Slice (S), Rectangle (R), Ellipse (O), Line (L), Arrow (⇧L), Polygon,
Star, Image (⇧⌘K), Pen (P), Pencil (⇧P), Brush (B), Lasso (Q), Text (T), Text on path, Hand (H), Comment (C), Annotation (Y),
Measure (⇧M); "Width profile" (stroke width profiles). Actions (⌘K; Figma's Actions, formerly Quick actions). Modes: Draw,
Design, Prototype, Code (Dev Mode, ⇧D).
Panels: Layers, Assets, Pages, Design, Prototype, Code. Properties (UI3's sections): Position (alignment, X/Y, rotation,
constraints), Layout (flow: freeform, vertical, horizontal; sizes; clip content; "Auto layout" while auto layout is on),
Appearance (blend mode, opacity, corner radius; "Corner radius" for the corners and smoothing), Point (the selected points
while a path is edited), Layout grid, Fill, Stroke, Effects, Drop shadow, Inner shadow, Layer blur, Background blur, Export;
"Property labels" in the zoom menu shows the captions, Styles, Variables, Component, Instance, Variants, Component properties,
Mask, Boolean operations (Union, Subtract, Intersect, Exclude), Shape builder (a click extracts a region, a drag merges
regions, ⌥ takes one away), Player. Sizing: Fixed, Hug, Fill.

## Performance

Heavy files must stay smooth on a modest laptop without losing quality. The speed comes from architecture, not
the language: TypeScript stays (the model and UI are not the bottleneck), and a hotspot moves to WebAssembly or a
worker only when a profile shows it.

- Rendering is tiled and cached: steady pans and zooms only composite cached tiles; edits invalidate the tiles
  under the changed nodes' render bounds (old ∪ new), found by object identity between immutable documents.
  Zooming shows the nearest cached scale, then re-rasterizes visible tiles within a per-frame budget.
- Nodes under a gesture (`state.live`) draw on a live layer every frame; the rest stays cached.
- Level of detail: sub-pixel nodes are skipped, tiny text is drawn as bars, images use mips, expensive effects are
  cached as bitmaps per zoom bucket.
- A per-page spatial index serves culling, hit testing and marquee; nothing scans every node per frame. A frame
  that only slides (a nudge, a drag) shifts its layers' bounds instead of recomputing them, so nudging every screen
  of a 20 000-layer page stays within the 16 ms budget of tests/design-perf.test.ts; panels that list what a large
  selection holds ("Selection colors") keep their listing when the nodes that changed kept what they show.
- Normalization (layout, instances, groups, variables) touches only dirty chains and writes into the transaction's
  one working table in place (`normalizeDetailed`); the patch is built from the ids written, never by diffing whole
  documents. Undo/redo move patches. The store copies the node table when the editor is idle, so the next edit never
  copies 20 000 entries while the user waits; indexes cached per table (shared/design/table-cache.ts) are carried
  over by checking only changed ids. tests/design-perf.test.ts holds the budgets (calibrated to the machine's speed)
  and counts entries read per drag frame, which must not depend on the file's size.
- React panels never re-render on viewport changes or during drags unless their values change (sliced store
  subscriptions); long lists (layers, assets) are virtualized.
- Another person's change goes into the idle copy of the node table and rebases only the unsaved entries it meets: a
  dozen layers moved in a 20 000-layer file apply in well under a millisecond (`tests/design-live-client.test.ts`).
  Cursors move on animation frames outside React.
- Budgets: 20 000 nodes pan at ~60 fps after warm-up; first paint < 1.5 s; tile memory scales with
  `navigator.deviceMemory`.

### The editor and panels on large files

Measured in the built app (a production build served beside the e2e API) with Chromium's profiler and a React commit counter,
unthrottled and at 4× CPU throttle with `navigator.deviceMemory` 4, on a 20 041-layer page, a 12 452-layer product file
(40 screens of nested auto layout, texts, instances of the UI kit's components), a 2 000-sticky board and a library of 600
components and 480 styles.

- **A selection is measured once.** The overlay keeps what it draws for a selection (ids, colour, outlines, the box:
  `selectionMarks`, `engine/overlay.ts`) while the document and the selection stay, so a pan or a zoom only maps it to the
  screen; before, every frame of a pan with 5 000 layers selected recomputed 5 000 world matrices. Work over many selected
  layers shares their parents: `worldMatrices(doc)` (shared/design/geometry.ts) answers every id with each ancestor's matrix
  worked out once — equal to `worldMatrix` to the bit — and the selection box, the "Position" section (`displayPlacements`) and
  `topLevelSelection` use it or the same idea. The board's context toolbar measures its objects once per document.
- **Panels work out a change once.** `useDesignStore` reuses the store listener's answer only for the same selector function;
  an inline selector is a new function every render and was asked twice per change. Sections read their view through
  `useSectionView(viewOf, ids)` and the header's checks are module-level selectors.
- **Only what changed re-renders.** During a drag "Position" re-renders its X and Y row only (the rows below keep their
  elements); "Selection colors" rows, "Assets" items (a stable menu callback) and the board's context toolbar (hidden
  during a gesture, it reads the settled document) stay quiet; "Text" keeps each text's values per text object, so
  moving texts does not work their styles out again. tests/e2e/design-render-counts.spec.ts counts renders with a React
  DevTools hook (load-independent).
- **No long tasks in the background.** The file card's picture is painted a few roots at a time (~8 ms slices,
  background-priority tasks between them; the same pixels), and autosave hands its JSON to `fetch` as a Blob, which the
  browser takes without copying the string on the main thread.
- **Nothing stays after a file closes.** Every lazy import is a module-level `() => import(…)`: the bundler's preload
  keeps the function that first asked for a chunk with a stylesheet (its `<link>` listeners), and one written inside the
  editor kept the whole closed editor alive (tests/design-lazy-imports.test.ts parses `src/design` for this).
- Sorting names uses one `Intl.Collator`: `localeCompare` with options builds one per comparison (34 ms for 600 names).

Before (`715a93c0`) and after, production builds served side by side and run alternately, medians of 3 runs (a run takes
the median of 3 repetitions); 4× throttle unless marked 1×. The machine (4 cores) was shared with other test runs (load
4–12), so times move ±20 % between runs; render counts do not.

| Scenario | Before | After |
|---|---|---|
| Pan with 5 000 of 20 041 layers selected: frame p95 / blocking time | 167 ms / 3 397 ms | 33 ms / 75 ms |
| The same, 1× | 50 ms / 270 ms | 17 ms / 0 ms |
| Deselect those 5 000 layers | 228 ms | 140 ms |
| Select 5 000 layers, 1× | 273 ms | 192 ms |
| Board, 2 000 stickies all selected, pan: frame p95 / blocking time | 100 ms / 1 145 ms | 50 ms / 71 ms |
| Drag a frame: components rendered per frame (20 041-layer page; product file) | 51; 61 | 8; 11 |
| Nudge or undo on the product file: components rendered | 88 | 11 |
| Drag a sticky on the board: components rendered per frame | 15 | 0.9 |
| An edit with "Assets" open (600 components): components rendered / blocking time | 606 / 119 ms | 6 / 74 ms |
| Autosave after 5 000 layers changed: longest task / blocking time | 1 086 ms / 2 145 ms | 842 ms / 1 743 ms |
| The card picture (20 041 layers; product file): longest task | 693 ms; 947 ms | 76 ms; 118 ms |
| Heap after GC with the two big files opened in turn four times (it starts at 44 MB) | 77–82 MB | 42–48 MB |

Unchanged within noise: selecting one layer or all, typing, the layers panel (scroll, expand all, drag), page switch,
opening a file. Still slow, for later: with a large library and nothing selected the style lists in "Design" and the
"Assets" grid mount every row (deselect ~1 s, opening "Assets" ~1.5 s at 4×; rows of a known height could mount as
they scroll in); the canvas draws a label for every component on each selection change; the canvas renderer is most
of a drag, a nudge, typing and a page switch; autosave still writes its JSON and checks its patch on the main thread
(~0.8 s at 4× for 5 000 changed layers; a worker could take both).

### Saving large files

A save used to rewrite the whole document: `JSON.stringify` of up to 20 MB on the event loop, then PostgreSQL compressed
the text again, wrote its TOAST chunks and logged all of it, for a keystroke. Five people on one big file queued behind
each other in the file's save queue (`live/queue.ts`) at more than a second per save.

- **Changes after the text** (`server/design/document-store.ts`, SQL038). A save of a document of 256 KB or more
  (`DESIGN_DOCUMENT_DELTA_BYTES`) writes its merged change (`applied.stored`, the same patch the others receive) as a row of
  `design_file_changes` and the file's version, size, layer count and pictures in `design_files`, in one transaction under
  the file's row lock; the stored text stays. The text catches up (`compact`: written at the file's version, the changes
  deleted in the same transaction) when 120 changes or 4 MB of them wait (the save itself then writes the whole text), when
  an automatic version is taken, 20 s after the file's last save in the process (`DESIGN_DOCUMENT_COMPACT_MS`), when the
  process stops (`flushDocumentWrites`), and 20 s after a read found changes this process did not write (another
  process's, or one that stopped without catching up). Smaller documents, new files, replaces, restores and rewriting
  moves are written whole as before; versions are always whole documents.
- **Reading.** One statement reads the text with its changes (`WAITING_CHANGES_OF`), so a reader never mixes two
  versions; changes that are not exactly the versions after the text are refused, never put together. The parsed document
  of the last version a process wrote or read stays in `document-cache.ts`, so saves and opens of a file being edited read
  nothing from the database; when another process saved meanwhile, the held document is caught up with the changes after
  it (up to 32, ~7 ms each for 20 000 layers) instead of reading the whole text again (~0.3 s for 16 MB). Putting a
  document together applies the changes in place on its own parsed copy (120 changes of a 20 000-layer file: ~0.14 s, as
  the parse; copying the node table per change took ~0.9 s).
- **Safety.** A change and its version commit together, and the catch-up and every whole write take the file's row lock,
  so two processes, a crash between saves, a catch-up racing a save or a copy, and the thresholds all leave one document
  (`tests/postgresql-runtime-design-file-changes.test.ts`: every reader listed under §Server API, the thresholds, and two
  real processes saving one file with their own 25 ms catch-up timers). A release that reads `design_files.document`
  without the store must never run on a database with waiting changes: SQL038 ships with the design tool's first release,
  and a process that stops writes its waiting texts first.
- **The text** (`server/design/document-text.ts`). The JSON text of a document is put together from each entry's kept
  text (by the entry object: documents are immutable), byte for byte `JSON.stringify`'s, so a save serializes only the
  entries it wrote; the bytes, the written entries and the keys of a node table are carried from table to table with the
  editor's indexes (`shared/design/table-cache.ts`), so a one-layer save measures one entry instead of 20 000 (~13 ms a
  save). The kept text costs memory with the cached documents: for the 16 MB file, ~25 MB once built and ~41 MB after
  3 000 scattered saves (pool slabs that a few live entries keep).
- **Compression.** Whole texts are written with lz4 where PostgreSQL has it (`SET LOCAL default_toast_compression`), pglz
  otherwise; each stored value records its own method. The test cluster here has no lz4, so none of the numbers below
  include it.

**Measured** (2026-10-07; 4-core shared container, PostgreSQL 18.4 without lz4, one app process unless said; the 20 041-layer,
15.9 MB page of `tests/helpers/design-big-files.ts`; a server process and a client process, each run on a fresh database;
medians of 3 runs, the columns measured alternately in the same session). *Before* is the code before these changes, *store*
the changes after the text alone, *after* with the carried sizes, the presence and fan-out changes below.

| Scenario | Before | Store | After |
|---|---|---|---|
| Typing in one layer: save answered, p50 / p95 | 406 / 464 ms | 35 / 47 ms | 21 / 29 ms |
| WAL written per save (that typing) | 2.08 MB | 2.9 KB | 2.7 KB |
| 5 editors, each moving 20 layers about once a second for 30 s: saves accepted | 75 | 143 | 147 |
| … save answered, p50 / p95 | 1 111 / 1 370 ms | 40 / 73 ms | 24 / 40 ms |
| … server CPU per save; share of one core | 234 ms; 0.59 | 47 ms; 0.22 | 31 ms; 0.15 |
| … event loop delay p99 / max | 150 / 245 ms | 24 / 83 ms | 10 / 51 ms |
| … WAL per save (with the whole text every 120 changes) | 2.08 MB | 17.7 KB | 17.3 KB |
| … peak server memory (RSS) | 1 495 MB | 726 MB | 655 MB |
| Opening the file (GET), p50 | 332 ms | 166 ms | 159 ms |
| A new 16 MB file (second create of the process) | 1 031 ms | 999 ms | 1 000 ms |

Saves queue per file, so before the change the five editors waited on each other (~1.1 s a save) and got half their saves
through; the clients wait 0.7–1.3 s after each answer, so ~150 is everything they sent. Measured without the database:
putting a document together from 120 waiting changes 0.85 s → 0.14 s; a one-layer save's size and layer count ~13 ms → under
0.1 ms. Co-editing traffic, same setup:

| Scenario | Before | After |
|---|---|---|
| 5 people moving cursors (one post per 60 ms each): server CPU | 308 ms/s | 148 ms/s |
| … database transactions and activity-journal rows per cursor post | 2 and 1 | 1 and 0 |
| … presence bytes each person receives | 20.7 KB/s | 16.6 KB/s |
| One person moving the cursor: its own presence events sent back to it | ~16 a second | none |

Two app processes on one database (`DESIGN_LIVE_FANOUT=postgres`), the five editors split 3 + 2, 30 s. *Before* has the store
only; *parts* adds the fan-out parts; *after* also catches a held document up with the other process's changes (each pair
measured alternately; the cursor and single-process changes do not apply here):

| Scenario | Before | Parts | After |
|---|---|---|---|
| `resync` sent to editors (each reloads the whole file: a 16 MB GET, ~140 ms to parse, every entry redrawn) | 189 | 0 | 0 |
| Changes delivered live to the other editors | 267 | 492 | 700 |
| Saves accepted / given up after four merges (409) | 85 / 8 | 90 / 7 | 145 / 0 |
| Save answered, p95 | 2 462 ms | 2 051 ms | 77 ms |
| A change reaching the others after its save's answer, p95 | (reloads) | 364 ms | 4.4 ms |
| Server CPU per save | — | 96 ms | 33 ms |

## Export

"Export" in the "Design" panel and the export dialog (⇧⌘E) write each layer's settings
(`src/design/panels/design/layout/export/`, loaded on first use). PNG, JPG and WEBP are painted in the browser by the
canvas renderer at the setting's scale; SVG is `shared/design/svg-export.ts`, in the browser, pictures embedded, text as
text (outlining needs glyph outlines the browser does not give), with "Add layer ids" (`svgIdAttribute`, the format
menu while SVG is chosen) writing each layer's name as a unique id; a slice's SVG is its page cropped to it, as its PDF
page is; PDF is the vector PDF below. Several files download as one zip.

### Vector PDF (`server/design/pdf/`, `shared/design/pdf-export.ts`)

As in Figma: a page per layer, at what the layer paints (its export bounds: a frame's box, plus a shadow reaching out of
it), 1 px = 1 pt exactly, so a 595 × 842 frame is an A4 page; no scale setting. Every PDF setting of one export with the
same suffix goes into one multi-page file ("Export.pdf", the page's name from the dialog, or the layer's name for one
layer), pages in reading order (rows from the top, each from the left). A slice prints what its page shows inside it. A
side over 14 400 pt (Acrobat's 200 inches) is scaled down to fit, keeping proportions.

How it is made:

1. The editor flushes autosave: the server prints the stored document, never markup from the request.
2. The editor runs the very export the server will run, with a measurer that records every text measurement of its
   canvas, and posts `{version, nodeIds, title, measurements}` (numbers only, at most 250 000 strings, 12 MB).
3. The server reads the file through `fileAccess(…, 'view')` at that `version` (409 `version_conflict` otherwise; the
   editor flushes and asks once more), lays text out with the editor's measurements, so lines break exactly as on the
   canvas, and writes each page as SVG in the exporter's `print` flavour.
4. Chromium's headless shell prints one HTML page of those SVGs (`page.pdf`), sandboxed: JavaScript off, a dead proxy, every host unresolvable, no cookie, session or file
   of the app. The server answers the page's requests itself: the page, catalogue fonts from `public/fonts` (`font-display:
   block`, and the print waits for `document.fonts`), and pictures by their number on the page, read from
   `DATA_DIR/uploads` only when the caller may read them under the rule of `GET /uploads/:filename` (a picture of another
   account is 403 `design_document_invalid`, a missing one prints as the editor's grey). Everything else is refused.
5. Chromium takes CSS page sizes in whole points and rounds them to its 300 dpi grid, so each page is printed a little
   larger, the frame in its top-left corner, and `page-boxes.ts` sets every `/MediaBox` to the frame's exact size.

| In the design | In the PDF |
|---|---|
| Text, Cyrillic, every weight and slant, letter spacing, line height, alignment, auto width or fixed, lists, decoration | Real text: selectable, searchable, copied out in order. Fonts embedded as subsets: a static face as TrueType, a variable family's instance as a Type 3 font of glyph outlines (one per weight used, with its Unicode map, as Skia-made PDFs such as Figma's have) |
| Text in a gradient or a picture | That paint clipped to the glyphs: vector, not selectable (viewers fill Type 3 glyphs with a pattern wrongly) |
| Text hyperlinks (http, https, mailto) | Link annotations |
| A font from the designer's computer | Not embedded: the server's fallback face sets it, and the editor says so after the export |
| Glyphs outside a family's Cyrillic and Latin files (arrows, emoji) | The server's system fallback, as the canvas falls back to the computer's |
| Shapes, vector networks, boolean operations, strokes inside / centre / outside, dashes, caps, joins, markers, per-side weights, corner radii (per corner, smoothing), rotation and flips | Vector paths and transforms |
| Linear and radial gradients; diamond | Vector shadings; diamond as four linear ones |
| Angular gradient | 120 solid wedges (a vector approximation; PDF has no conic shading) |
| Pictures: fill, fit, crop, quarter turns | The picture's own pixels clipped to the shape: a stored JPEG or PNG as it is, a WebP photo as JPEG of quality 92 without chroma subsampling, transparency as a soft mask |
| Tiled pictures; pictures in text or strokes | A tiling pattern Chromium rasterizes at 300 dpi |
| Masks (alpha, luminance, vector), clip content, opacity, blend modes | Soft masks, clip paths, transparency groups, PDF blend modes |
| Drop and inner shadows | Rasterized at 300 dpi, each a layer of its own under / over the vector content |
| Layer blur | The layer rasterized at 300 dpi (as Figma) |
| Background blur | Not supported: the layer is drawn without the blur, as in the SVG export (Chromium drops backdrop filters when printing) |
| Hidden layers | Left out |

Colour stays sRGB (no CMYK or PDF/X). Limits: 50 pages per PDF, ten exports a minute per account, one at a time per
account and two on the server (a third is answered 429 `design_pdf_busy`, which the editor retries for 12 seconds), the
request body in its window (§Server API), shadows and blurs at most 96 megapixels for one raster and 240 for the whole
export (413 `design_pdf_too_large` before anything prints: at 300 dpi a full-page shadow on a 1440 × 6000 frame is
150 megapixels), and one minute per print (`DESIGN_PDF_RENDER_MS`; 504 `design_pdf_timeout`). One browser serves the
prints, a fresh context each; it is closed after 20 prints, a minute without work, and at once when a print fails or
runs out of time. The session is checked again before the PDF is sent. Laying out and writing the SVG runs on the event
loop, a page at a time with other requests served in between: about 40 ms for the "Website" template, about a second for a
frame of 20 000 layers (the editor's recording pass costs about the same in the browser).

Switch: `ENABLE_DESIGN_PDF_EXPORT` is on wherever the design tool is (`/api/config` says `designPdf`); `0` turns it off
where Chromium cannot run, and the panel then names the format "PDF (raster)" and the browser writes a lossless
picture inside a PDF page (`export/pdf.ts`). If the browser cannot start, the export is answered 503
`design_pdf_unavailable` and the editor says the server cannot print PDFs now. The production image's headless shell
and the `app` service's seccomp profile are the importer's; `IMPORT_CHROMIUM_PATH` points both at another Chromium.

## Design to code

Designers hand over code, not only pictures. The "Code" tab (Figma's Dev Mode, ⇧D), "Export to React…" and "Export to Vue…" turn a
selection, a page or the whole file into React (or Vue 3) + TypeScript a front-end team would merge as is. The bar is that the generated project
type-checks under `strict` and renders without a React warning for every template and fixture in every styling
(`tests/design-codegen-build.test.ts` compiles them with TypeScript and renders them with `react-dom/server`).

**The generator** (`shared/design/codegen/`, pure and deterministic: the same document always gives the same files):

- `model.ts` reads a component or variant set: variant properties, booleans, texts and swaps become props with types,
  defaults and the designer's names as doc comments. Interaction-state variants ("Hover", "Pressed", "Focus",
  "Disabled") are not props: `space.ts` takes them out of the variant space and `style-rules.ts` writes them as `:hover`,
  `:active`, `:focus-visible` and `:disabled` rules of the looks they belong to.
- Components take their native element's props (`ComponentPropsWithRef<'button'>`, forwarded with `{...props}`, so
  `onClick`, `aria-*`, `ref` and `disabled` just work; clashing names are `Omit`ted). A button's one label is its
  `children`, a field's value text its `placeholder`; a field wires its label, hint and error with `useId`
  (`htmlFor`, `aria-describedby`, `aria-invalid`); a checkbox, radio or switch is a `<button role aria-checked>`, a
  tristate checkbox takes `checked?: boolean | 'mixed'`.
- `tree.ts` builds each variant's element tree, `merge.ts` merges them into one JSX tree with conditions only where looks
  differ; a variant that writes its own text where the others bind a text prop shows the prop too (its usage passes that
  text). A main component standing in a screen (a UI kit's page) is a usage of itself, a variant set its looks, each once
  (a hover, press or focus variant is the browser's state). Siblings that repeat one structure become a typed data array
  (a plain list when only a text differs) and a `.map()` with a stable key; texts follow the screen's heading outline
  (`semantics.ts`: one `h1`, ranks by size, never more than one level deeper than the heading before; logos and
  overlines are text), frames named or shaped like them become landmarks
  (`main`, `header`, `nav`, `aside`, `footer`, `section`). Class names say what a layer is for (`names.ts` translates
  Russian (Cyrillic) layer names through a dictionary with stems, transliterating only unknown words), never the text it shows;
  identical rules share one class.
- `css.ts` maps layers to CSS (auto layout → flexbox with `flex: 1` / `align-self: stretch`, hug roots `inline-flex`,
  constraints → absolute positioning, one-side strokes, radii, shadows, text styles); `tokens.ts` turns styles and
  variables into custom properties (`tokens.css`, Tailwind's `@theme`), and a raw colour equal to a token's value is
  written as the token (Figma's suggested variables). `format.ts` writes lengths in px or rem (hairlines stay px) and
  colours as HEX, RGB or HSL.
- Printers: CSS Modules (variant props as data attributes on the root, `[data-kind='outline'] .label`), Tailwind CSS 4
  (utilities; a property a variant prop changes lives in that prop's map only, never also in the base, since two
  utilities of one property win by stylesheet order; children follow the root's named group, `group-hover/button:`;
  theme in `theme.css`) and inline styles. Vectors are icon components in
  `src/icons` (`currentColor` when one-coloured, one file per drawing); pictures are assets; `src/lib/cx.ts` joins classes.
- `project.ts` makes the Vite + React + TS project zip (`fflate`): the reset, the tokens, a page per screen, README.
- Vue 3 (`toVue`, "Export to Vue…", requested by users): the same pipeline printed as single-file components (`vue.ts` holds
  the template syntax, `react.ts` branches only where printing differs, so the React output is byte for byte what it
  was). `<script setup lang="ts">` with `defineProps` over a props type exported from a plain `<script lang="ts">` (data
  arrays and other files name it), `withDefaults` for the design's defaults; a button's label is the default slot (the
  design's text as its fallback), a swap a named slot (its default component as fallback; a swap with a default keeps its
  show/hide boolean as a prop, since a slot's fallback cannot be turned off from outside); undeclared attributes and
  listeners fall through to the root as Vue does, so there is no `{...props}`, `className` or `cx`; a field sets
  `inheritAttrs: false`, gives `$attrs.class`/`style` to its box and the rest to its input, and takes its ids from Vue's
  `useId`. Stylings: `<style module>` and `$style`, Tailwind classes (`class` plus `:class` for the variant maps), or a
  typed `styles` object (lengths keep their unit: Vue writes numbers as they are). Pieces some variants leave out are
  `<template v-if>` (a template prints `false`), inline runs stay on one line (the template condenses line breaks into
  spaces), texts with `{{` or `}}` become string interpolations. `vue-project.ts` is the Vite + Vue + TS twin of
  `project.ts` (App.vue switcher, ComponentsPage.vue, `vue-tsc --noEmit && vite build`). The bar is the React one:
  `tests/design-codegen-vue.test.ts` type-checks every template and fixture in every styling with vue-tsc (vue and
  vue-tsc are dev dependencies for this), compiles each component with Vue's SFC compiler and renders the screens and
  the component page with `vue/server-renderer`, failing on any Vue warning.

**The "Code" tab** (`src/design/panels/code/`, a lazy chunk; the right panel keeps its own width there, 320 px by default,
`CODE_WIDTH_KEY`):

- The layer: name, type and size (copy the name); for a component or an instance, "Component": `<Button>` and the element
  it extends, each prop with its type, default and the designer's name, the states written as CSS, "Go to main" for an
  instance, and "Playground" (Figma's Explore component behavior): set any prop and copy the usage it gives
  (`propsOfUsage` / `usageFor` in `inspect.ts`), without touching the design.
- "Code": the language (CSS, React + CSS Modules, React + Tailwind, React + inline styles, Vue + CSS Modules, Vue + Tailwind,
  Vue + inline styles, Tokens), the files as tabs with copy and download, an instance's usage first, what to move by hand,
  "Export to React…" (or "Export to Vue…" while a Vue language is picked; the component's props and "Playground" follow
  the language too). CSS reads as code or as "List" of
  values that copy one by one. The gear holds units (px / rem), the colour format and "Use tokens"; the settings
  are remembered on the device (`settings.ts`).
- "Layout": the box model (stroke, padding, size, each side's value; a click copies the CSS), width and height with
  how they are set, position outside auto layout, radius, rotation, opacity, then auto layout. "Typography": a sample,
  the text style and its token, every value. "Styles and variables": fills, text, strokes and shadows in use, by token
  (suggested tokens marked), a layer's shadows as one `box-shadow`. "Assets": icons and pictures in the selection, an icon
  drawn the same in other colours counted once and named as the code names it (`button-icon.svg`, `currentColor`), SVG and
  PNG downloads; "Export": the layer's export settings.
- In "Code" the design is read, not edited: the store refuses any undoable change while `ui.devMode` is on (a nudge, a
  delete, a paste, a rename in the layers panel) with the reason `devMode`, and the editor says so with a "Back to Design"
  button; annotations and measurements (`{annotation: true}`) change and undo as anywhere.
- It regenerates only when something it shows changed: `scope.ts` lists what the tab reads for a selection (the layers in
  it, their parents and siblings, the components their instances use, the tables read whole), and while every entry is
  the same object the panel keeps its document, so a co-editor's edit elsewhere costs a pass over that list (0.1 ms
  instead of ~30 ms with a screen of the 20k-layer file selected, `scripts/bench/code-panel.ts`).
- Tests: `tests/design-codegen-*.test.ts` (the generator, the build test), `tests/design-code-inspect.test.ts` (the panel's
  reads and settings), `tests/design-code-scope.test.ts` (nothing the tab computes reads outside the scope), the store's
  case in `tests/design-store.test.ts`, `tests/e2e/design-code-panel.spec.ts`.

## Text on a path, annotations, measurements and drawing tools

Figma's Text group (Text on path), its Comment group's Dev Mode tools (Annotation, Measurement) and Figma Draw's stroke
width profiles, brush and lasso. Every tool is a `TOOLS` entry (`src/design/editor/chrome/tools.ts`), so its key is a
`tool-*` command (quick actions, "Keyboard shortcuts") and the toolbar shows it in its group. Keys were checked against the
registry (`tests/design-new-tools.test.ts`): Y, ⇧M, Q, B and ⇧Y were free; Figma binds no key to Text on path.

| Tool | Key | "Design" bar (`TOOL_GROUPS`) | "Draw" bar (`DRAW_TOOL_GROUPS`) |
|---|---|---|---|
| "Text on path" | — | Text | Text |
| "Annotation" | Y | Comments (also Dev Mode's bar) | — |
| "Measure" | ⇧M | Comments (also Dev Mode's bar) | — |
| "Lasso" | Q | — | Select, with Move and Hand |
| "Brush" | B | — | a button of its own, after Pencil |

The lasso and the brush are Figma Draw's, so only the "Draw" bar shows them; their keys switch the bar to it
(`modeForTool`).

A read-only file (a team's developer or viewer) has none of them (`READ_ONLY_TOOLS`): they all write the document. Its
viewers still see notes and measurements on the canvas and in "Code".

### Text on a path

`SceneNode.textPath` (TEXT only; Figma's TEXT_PATH): `{commands, startOffset 0..1, side}`, the path in the layer's local
box (resizing the layer scales it, as a VECTOR's paths). `shared/design/text-path.ts` lays the text out unwrapped and
carries each grapheme along the path (its middle at its distance, its baseline turned with the path); the canvas, PNG/JPG/
WEBP, SVG (a `tspan` per glyph with x, y, rotate) and PDF all draw from that one placement. Alignment along the path is
the text's horizontal alignment around `startOffset`; across it, its vertical alignment (BOTTOM, the default, stands the
text on the path). `side: 'RIGHT'` reads the path backwards: the text runs on its other side. On an open path glyphs
whose middle falls off an end are not drawn (SVG's rule); a closed path carries text round.

- The tool (`engine/tools/text-path.ts`): hover lights a rectangle, ellipse, polygon, star, line or vector; a click
  makes a TEXT just above it in the same parent, with its box and turn and a copy of the subpath nearest the click,
  starting where the click fell, and opens the text editor (caret, selection and IME across the path, the path outlined
  in place of the box). The shape stays. A click and Escape without typing leaves nothing. A click on a text on a path
  edits it.
- Selected with "Move": the path is outlined and a round handle sits where the text starts; dragging it moves
  `startOffset` along the path (one undo step, "Text start").
- "Design" → "Text on path": "Start" (%), "Other side of the path", "Detach from path" (an auto-width text
  where the box was). "Text" hides "Box size" for these texts (the box is the path's).
- Co-editing: `textPath` is one field (the later writer wins); the characters merge as any text's. Instances scale the
  path with their size; `textPath` can be overridden. The Figma import keeps a TEXT_PATH's path when the API sends it.
- "Code" writes the text as SVG and says why. Not built: turning a text on a path into outlines (no text is outlined
  yet, §Export).

### Dev annotations and measurements

`src/design/annotations/` (tools, canvas layer, "Code" list; the canvas layer and the list load on first use) and
`shared/design/annotations.ts`, `shared/design/measurements.ts`.

- "Annotation" (Y): `SceneNode.annotations` on any layer but a page: `{id, label, categoryId?, properties?}`. A click on a
  layer selects it and opens a note card beside its top-right corner: category ("Development", "Interaction",
  "Accessibility", "Content", Figma's four presets with their colours), the text, and "+ Property" — properties of the
  layer that apply to it (size, fill, stroke, radius, effects, opacity, text, auto layout, main component), read live
  from the layer every time they show, so "Width" always says today's width. Enter or "Done" saves (one undo step);
  an emptied note is removed. A click on a card edits it. Instances inherit their main's notes; a note added on an
  instance is its override.
- "Measure" (⇧M): `page.measurements`: `{id, start: {nodeId, side}, end: {nodeId, side}, offset, freeText?}`. The
  nearest edge of the layer under the pointer lights up pink; a drag to a parallel edge of another layer (or of the same
  layer: its width or height) pins the distance where the drag started. The line, its number and dashed extensions are
  worked out from the layers' boxes as they are now, so a measurement follows the layers as they move or resize; a
  rotated layer measures by its bounding box (as Figma's do). A click picks a pinned line (Delete removes it), a drag
  moves it across. A measurement whose layer was removed is not drawn (undo brings it back).
- On the canvas: notes and measurements show while "View → Annotations" (⇧Y, remembered on this device) is on, and always
  while one of the two tools is in hand. Cards follow pans and zooms without animation; the editor card fades in from
  its layer's side (160 ms ease-out), not at all when opened from the keyboard.
- "Code": "Annotations" (the selection's and its descendants' notes; with nothing selected, the page's) and "Measurements"
  (those touching the selection), each a click away from its layer; an editor edits and removes them there.
- Co-editing: both lists merge entry by entry by id (`shared/design/merge.ts`), and new ids are random, so two people
  pinning notes or measurements at once keep both; an entry both changed takes the later writer's; a removal wins over
  an edit. Limits: 100 notes per layer, 30 properties per note, 1 000 measurements per page.
- Not built: Figma's custom annotation categories, "Ready for dev", and a control for a measurement's own text
  (`freeText` is kept and shown when a Figma import brings it).

### Drawing

- "Width profile" (`SceneNode.variableWidthStrokeProperties`, Figma's variable width strokes): on a LINE or a VECTOR
  whose paths are all open. "Stroke" offers Figma's presets with a picture of each: "Uniform", "Wedge",
  "Taper", "Taper end", "Lens", "Taper both ends"; "Custom" (width points from an imported Figma file)
  shows only when a layer has it, and no control edits points yet. `shared/design/stroke-profile.ts` turns the stroke
  into filled pieces (a monotone curve through the points, round joins, the layer's cap); the canvas, SVG, PDF, PNG and
  "Outline stroke" all use them. A profiled stroke is centred; dashes and arrowheads are not drawn with it (the panel
  says so).
- "Brush" (B): a freehand stroke like "Pencil", smoothed (three [1, 2, 1] passes, the ends kept) and fitted to a few
  cubics, 6 px black, with the last preset picked in "Width profile" (at first "Taper both ends"). It ignores a
  pen's pressure, as Figma's brush does. The live stroke on the overlay is the outline the layer will have.
- "Lasso" (Q): a freehand loop selects the layers it touches, as the marquee does with a box (a frame on the canvas only
  when the loop holds it whole); Shift adds; a click picks the layer under it; Escape drops the loop. Not built: lasso
  selection of vector points in the vector editor, Figma Draw's stretch and scatter brushes, and the variable width
  tool that edits width points on the canvas.

## Teams

Companies with several designers, developers and others share one workspace. Built in two steps.

**Step 1 — workspaces and roles.**
- A team has an owner, members and projects (folders of files). An account can belong to several teams
  and keeps its personal files ("Personal files").
- Roles: Owner (everything, delete the team), Admin (members, projects), Editor (edit files),
  Developer (view, inspect, the "Code" tab, export, versions; no edits), Viewer (view and export only).
- Invites go by link only: the owner or an admin copies an invite link with a role (and, behind "Customize", an expiry and a
  number of people); the person enters a name and joins. Links can be revoked; a link is reusable by default, as Figma's: 30 days,
  up to 100 people (§"Invite links" below). Accounts are name accounts, so nothing is addressed by e-mail.
- Access: team files are visible to every member; one file can also be shared with people outside its place
  (§"File access" below), who view and comment, or edit when they were given editing.
  `fileAccess` (server/design/file-access.ts) is the only authorization function; viewers and developers open the editor
  read-only.
**Step 1 as built (SQL034, `034-design-teams.sql`).**
- Tables `design_teams` (owner, soft `deleted_at`), `design_team_members` (one `owner` per team), `design_team_invites`
  (only the SHA-256 of the token, role, `expires_at` ≤ 30 days, `max_uses` 1–100, `uses`, `revoked_at`) and
  `design_projects`; `design_files` gains the `team_id` foreign key and `project_id`, `design_images` a `team_id`.
- Holder: a team file's `user_id` is the team's owner (its versions and pictures follow), so per-account reads, erasure
  and cascades stay as they were; handing the team over ("Transfer team") re-holds the rows. `DesignScope` (`server/design/access.ts`) says whose rows a file's are.
- Authorization: `fileAccess` reads the member's role in the same query. `view` is any member, `edit` is Editor,
  Admin, Owner (else 403 `design_forbidden`), `admin` is Admin and Owner; non-members get 404.
  Team pictures are served by `/uploads` to members of the live team and count against the team's storage.
- Routes `/api/design-teams` (`team-router.ts`; flag, session and rollout as the files API, its own rate limits):
  `GET/POST /` (teams with the caller's role and projects; at most 20 owned, 50 memberships),
  `PATCH/DELETE /:teamId` (rename; delete moves every file to the team's trash, revokes the links; the
  sweep erases the team once its trash is empty), `GET /:teamId/members` (names and roles),
  `PATCH/DELETE /:teamId/members/:userId` (role, handover, removal; the last owner is never demoted),
  `POST /:teamId/leave`, `GET/POST /:teamId/invites`, `DELETE /:teamId/invites/:inviteId`,
  `POST/PATCH/DELETE /:teamId/projects[/:projectId]` (deleting a project trashes its files),
  `GET /invites/:token` (preview: team, role, whether the caller is already in) and
  `POST /invites/:token/accept` (idempotent; 410 `design_invite_expired` when spent, revoked or expired). A token is
  32 random bytes in base64url; telemetry and admin logs mask it.
- Invite flow: the link is `/?designInvite=<token>#designs`, shown once to its creator. The design chunk takes the
  token out of the address; a signed-out visitor's sign-in screen (`src/auth/SignIn.tsx`, in the same page) leaves the
  address as it is, keeps the token in the tab's `sessionStorage` too and says
  the name entry leads into the team; the design area opens after sign-in, where the invite screen names the team, who invites and
  the role before "Join". Joined (or dismissed), the invite screen does not come back on the way back from a file; the
  browser reads the team list before it shows the team. A signed-out visit to `#designs`, a file or a comment's link
  (`#design/<id>?comment=<thread>`) is remembered by the sign-in boot (`src/design-visit.ts`) and opened after sign-in.
- Refusals in "Members" are said inside the dialog, never in a toast under its backdrop; a
  revoked link leaves the dialog. A browser showing a team whose files answer 404 (the member was removed, the team
  deleted) says "You no longer have access to this team." and goes back to "Recent".
- Client: the browser's sidebar lists "Personal files" and each team (all files, projects, trash) with "New project" and
  the team menu; "Members" (roles, removal, handover, invite links), "Team settings", and a space switcher on a narrow window (`src/design/teams/`, `styles/teams.css`). A Developer or
  Viewer opens a file read-only: the store refuses every edit (`readOnly`, select and hand only), autosave and
  thumbnails stay off, panels are disabled, the title says "View only"; export works and the "Code" tab is the
  developer's.
- Account life: erasure removes the account's memberships and the teams it owns (their files with them); the export
  has `design.teams` (memberships with role) and each file's `teamId` (comments: below).
- Known gaps: old versions of a file moved between spaces may point at pictures of its old
  place; there is no e-mail for role changes.

**Invite links (as built; invites are by link only. The table `design_team_invites` serves the links; its `email` column
(SQL014) is a legacy that nothing writes or reads any more).**
- Rows of `design_team_invites` with an `email` (a legacy of the older schema) are inert: the list, the
  preview, the accept and the revoke routes work on links (`email IS NULL`) only.
- "Members" (and the same panel in "Share", `src/design/teams/People.tsx`): the members with their roles (names only),
  then "Invite link": a role and "Copy link", which makes the link and copies it in one click; "Customize"
  shows its expiry and number of people; the links that still work are listed with "Revoke". A new team opens "Members".
- "Share": see "File access" below.
- The sign-in screen, opened from an invite link, says "You were invited to a team. Enter your name to join it."

**File access — sharing one file, Figma's way (as built, SQL015 `015-design-file-sharing.sql`).**
- A file can have guests outside its place (the owner's personal files or a team): `design_file_members` (role `editor` or
  `viewer`; a NULL role is someone who opened it by its link, kept only so it stays in their list; nothing creates a guest with a
  role any more, such legacy rows still work) and `design_files.link_access` (`none` — only the people
  it was shared with; `view` / `edit` — anyone signed in with the link).
- One rule, `fileRoleJoins` in file-access.ts, used by `fileAccess`, collab's `/session` (`sql/session.sql` holds its text) and
  permission pushes, the picture reads, "Shared with me", favourites, libraries, comments and the MCP server's file list: the owner;
  the live team's members with their role; a guest's role or the link's, the higher one, never for a file in the trash or of
  a deleted team; a team member who is also a guest has the higher of the two. Guests
  view, or edit and share as editors; never trash, move, copy (403) or reach the team's libraries, members or projects
  (`access.team` is null, `access.guest` true): "Libraries" lists them only the libraries the file enabled, which they use,
  they enable no other, they do not publish or unpublish the file's own library, and in comments they mention nobody. Pictures and thumbnails of a shared file are served to its guests
  (`guestPicturesSql`); uploads by a guest editor count against the file's holder, as the owner's own.
- Who shares: whoever may edit the file (Figma's default). `GET/PATCH /:id/sharing`, `PATCH|DELETE /:id/sharing/guests/:userId`
  (`me`: leave). There is no invite by address: the file is given to people through its link (`link_access`); a person who opens
  it is kept in their "Shared with me" (`arriveAtFile` in `openDesignFile` and the big files' skeleton). The sharing shows
  names only (no addresses). Closing the link removes the rows of those who came by it, and every change of access (a guest
  removed or given another role, the link closed) is pushed to collab at once (ACL push, naming the people who lost it), as the
  SSE stream re-checks its connections.
- "Shared with me" (`GET /api/design-files?shared=1`): the files shared with the caller or opened by their link that they
  still have, newest first, with whose file it is and the role; menu: open,
  rename (editors), "Remove from Shared with me".
- "Share" (`src/design/teams/ShareDialog.tsx`, loaded on first use) is the editor's one blue button (top right; "Export"
  becomes an icon beside ▶; the header's spacing tightens so two avatars still fit) and the board's: "Who has access":
  "Link access" (only the people it was shared with, or anyone with the link to view or edit), the team's row (its
  managers open the team's people from it: "Members"), the owner, each guest with their role or "Remove access" (a guest:
  "Leave"); "Copy link" copies the file's address. A file the caller cannot open says "File not found" with
  a hint to ask whoever sent the link to give access in "Share".
- Account erasure removes the account's guest rows; the people it shared with keep their files.
- Not built yet: mentioning a file's guests in comments (team members only), "Request access", a guest's own copy of a
  shared file. A guest editor takes nothing from the sharer's limits beyond the pictures they upload.

**Step 2 — working together.** Real-time co-editing and presence (built: "Co-editing" below), comments
(built: "Comments as built" below), and shared libraries (publish components, styles and variables from a file; other
team files subscribe and accept updates).

### Co-editing (as built)

Several people edit one file at once, Figma's way: everyone's changes appear live, the cursors and selections of the
others show in their colours, and a click on an avatar follows that person's view. A team file and a personal file
open in two tabs of one account behave the same way (the old "File changed in another tab" message no longer happens to
autosave). No table: the order lives in `design_files.version`, the rest in memory.

**Order.** The server is the one order of changes. A save is `PATCH /:id/document` with the patch, its `baseVersion`, the
`before` copies of every entry it changes (what the editor believed the server held) and the editor's connection
(`client`). Saves of one file run one at a time in the process (`server/design/live/queue.ts`); each lands on whatever
version the file has now through `mergeChange` (`shared/design/merge.ts`), is checked with `checkPatchedDocument`, stored
as the next version (the version check of the write still guards against another process; a lost race merges again, up
to four times) and recorded in the file's change log. The answer carries what the editor must apply to catch up: the
others' `changes` after its `baseVersion` up to the version it merged onto, and `own`, the server's value of every entry
the save sent or the merge wrote, whenever that may differ from what was sent. When the log no longer reaches back that
far the answer says `resync`. Every guarantee of a save stays: account generation, `fileAccess` (viewers and developers
never write), the caps and the holder's room, automatic versions, rate limits and both slots.

**Merge rules** (`mergeChange`; the same function on the server and in every editor):

- *Fields.* A field the change did not touch keeps the target's value; a field it touched takes the change's value, so on
  the same field the later save wins. Records keyed by id merge one level deeper: `autoLayout`, `constraints`,
  `boundVariables`, `componentProperties`, `componentPropertyDefinitions`, `pluginData`, a variable's `valuesByMode`, a
  layer's mode choices. `overrides` merges as a set. Styles, pictures, collections and variables merge the same way.
- *Text.* A text layer's content (characters, runs, list types) merges when the two edits are single replacements in
  different places of the text (typing in two paragraphs keeps both; both typing at one place puts theirs first); when
  they overlap, or one side also restyled a range, the later save wins the content. The other text fields (base style,
  alignment, sizing, spacing) merge one by one. While someone else's edit lands in a text being typed, the caret stays on
  its characters and the typing goes on; the others' outline of a text they type in is thicker.
- *Structure.* `parentId` decides where a layer lives; each `children` list is rebuilt from it: the target's order stays,
  and what the change added or moved goes before the next layer the change kept in its own order (`mergeList`, linear).
  Two people adding layers to one frame both keep theirs. A move into a layer that no longer exists or that would make a
  cycle is refused (decided in id order, so both sides refuse the same one): the layer stays where the target has it.
  The page order and a collection's `variableIds` merge as lists the same way.
- *Removal.* An edit of a layer someone removed is dropped (removal wins). A removal takes what its author saw: a layer
  moved out of the removed part meanwhile survives, and one someone else added or moved into it moves up to the nearest
  surviving ancestor, keeping its place on the page. A new layer whose parent was removed moves up the same way. Instance
  copies never leave their instance: they go with it. A group or boolean left without layers is removed; the last page
  is never removed.
- *Layout.* With `DESIGN_SERVER_LAYOUT=1` the server lays out what it merged: after the merge it normalizes
  the layers the stored change writes (auto layout, group boxes, text sizes, instances) with its own measurer, crates/text's
  shaper over the catalogue's font files (`server/design/wasm-engine.ts`), and stores the result as part of the same
  change (`server/design/apply.ts` `layOutChange`: only the layers' own fields, never `id`, `parentId` or `children`).
  Every editor then receives the laid-out document and no editor corrects anything: the save's answer says
  `layout: 'server'` and so does the stream's hello, and `live-session.ts` skips its correction for both the merged save
  and unsaved changes rebased onto others' (those are laid out when they are saved). A save whose text needs a face the
  server does not have (a designer's local font), or a board, keeps the old rule for that save (no `layout` in the
  answer). Without the flag (the default until a bench says otherwise) the server does not measure
  text or lay out frames, so the editor that combined edits lays them out once, as its own correction (no undo step): the
  editor whose save the server merged (`own`), the editor whose unsaved changes were rebased onto someone else's, and a
  re-based undo or redo inside its step. The other editors only apply what arrives, so two editors never correct each
  other back and forth.

**The editor** (`src/design/realtime/`, loaded with `import()` after the editor shows; without it saving works as before).
`live-session.ts` keeps the version the editor shows. The others' changes arrive on the stream; while a save is on its
way they wait (its answer brings them), otherwise they apply in version order, at most every 50 ms (`REMOTE_APPLY_MS`: a
lone change at once, a burst from many people as one update, since each update copies the layer table and redraws what
changed); an update that took long makes the next wait ten times as long, up to 250 ms, so others' changes never hold
more than about a tenth of the main thread, whatever the file's size or the number of people. Each goes into the store with
`store.applyRemote`: no undo step, not saved back, waiting for a drag or an IME composition to end (`remotePending`;
autosave holds its next save meanwhile), and the unsaved changes rebased on top with `rebaseLocal` (the server's own merge
against autosave's copy of the server, `SavedState.changes`/`reset`). A gap in the versions that does not close in 2.5 s,
a `resync` or a replaced document reloads the stored file under the unsaved changes. Undo after others' changes reverts
only this person's fields (`store.setHistoryRebase`): the step is merged against the current document, so it never brings
back a layer someone else removed, and the step the other way restores what the document held when it ran (Figma's
rule). A changed role reopens the file with a toast (read-only or editable, or a developer made a viewer and the reverse,
for the "Code" tab); losing access, the trash or erasure leaves it.

**Presence** (ephemeral, never stored). The editor posts its pointer (page coordinates), page, selection (at most 200 ids
and the count), viewport and the text it types in, coalesced to one post per 60 ms and only what changed
(`presence.ts`). The server sends a file's presence changes at most every 40 ms, to each stream the others' (never its
own: the editor would drop it, after a roster rebuild, ~16 times a second while its cursor moves). The avatars (right panel header, beside
▶: as many as the header holds, at most five, the rest behind "+N" with each person's page) group a person's tabs, show
another page dimmed and the followed person ringed; a click follows. Cursors glide toward the last position on animation
frames (page space, so panning moves them with the canvas; no glide with `prefers-reduced-motion`), drawn as Figma draws
them: a 24 px arrow in the person's colour with a white edge and a soft shadow, the name in a pill of that colour just
below and to the right of the tip (12 px, white text, a white ring so it reads on any fill); selections are
outlined in the person's colour, rotation included (an outline is computed again only when that person's selection, the
document or this view changes, never for a cursor move). "Follow" shows their page and fits their view until this editor
pans, zooms, switches the page or presses Escape. Nothing re-renders a panel on a cursor move: the avatars read a roster
that changes only when people come, go or change page; the canvas layer draws into the DOM. Colours come from
`DESIGN_LIVE_COLORS` (bright, as in Figma: one per person in a file, never the selection blue); a name is
the account's display name or "Member" (never part of an e-mail).

**Many people at once** (`scripts/bench/multiplayer-canvas.ts`). The built editor on the laptop stand-in (CPU ×2) watches a
20 000-layer file while `--peers` simulated people, each with an account and a stream of their own, move cursors ~16 times
a second, change selections and move a layer a second; it reports frames, long tasks, renders and the main thread's busy
share per phase (`still`, `pan-alone`, `cursors`, `edits`, `pan`), with `--trace`/`--profile` for where the time goes. On
a machine without a GPU run it with `BENCH_GPU_PATH=1` (SwiftShader behind ANGLE): Chromium's software compositing copies
every canvas on each commit, which would swamp what the editor itself does.

**Stream** (`GET /:id/events`, `server/design/live/hub.ts`). Server-Sent Events over the Express app, read with `fetch` (not
`EventSource`, so the account header and refusals work) plus the existing PATCH: one long response per editor, plain HTTP
through every proxy and HTTP/2, no new dependency (there is no WebSocket server in the repo, and presence posts at ~16 a
second are cheap with keep-alive). Events: `hello` (connection, presence secret, version, role, peers), `change` (`id:` the
version; a connection is never sent its own), `resync`, `presence`, `leave`, `access`, `file` (renamed), `comments` (the file's comments changed; no payload), `meeting` (its timer or vote changed: "Meeting" below), `bye` (access,
session, trashed, erased, slow, shutdown). A heartbeat comment every 20 s; the editor treats 50 s of silence as a lost
stream and reconnects (0.5 → 20 s with jitter, and at once on the browser's `online`) with `?since=` its version: the log
replays what it missed, or `resync`.
Presence posts are authorized by the stream's secret and the same session cookie, without a database read each, and are
not recorded in the activity journal (`res.locals.notActivity`): each would have taken the account's lock, a global lock
and a count of the whole journal, and five people's cursors filled its 100 000 rows in about 20 minutes.
Every stream re-checks its session and `fileAccess` every 20 s (± a quarter): a removed member stops receiving within
that time even across processes, and at once when the change goes through the team routes of the process
(`revalidateLive`); a demoted editor gets `access` and its writes are refused anyway. Limits (environment overrides in
`limits.ts`): 16 streams per account, 50 per file, 2 000 per process, 60 stream opens a minute per account, 25 presence
posts a second per stream, a log of 512 changes or 8 MB per file and 64 MB in all, catch-up answers up to 2 MB, a stream
whose unsent output passes 16 MB is closed. `DESIGN_LIVE=0` turns the streams off: saves still merge and bring the
others' changes with their answers.

**Several processes.** The fan-out sits behind `LiveFanOut` (`fanout.ts`): one process passes nothing on (the default);
`DESIGN_LIVE_FANOUT=postgres` makes every process LISTEN on one channel and announce its changes, resets, renames,
closings, revalidations and presence with `pg_notify` through the pool. An event longer than one notification (under
8 000 bytes; a drag of 20 layers is ~9 KB) goes in numbered parts sent by one statement, so they reach every listener
together and in order with the sender's other events, and the receiver puts them back together (`fanout.ts`). Only a
change over 1 MB travels as its version, and the receiving streams reload the document (before the parts, every change
over 8 000 bytes did, so every editor in the other processes reloaded the whole file after almost every drag); a process
that lost its listening connection reloads every open file. Each process keeps its own log, so a save's catch-up from another process's
versions comes from the notifications it received. Peers of other processes are announced every 20 s and forgotten after
a minute without one.

**Proxies.** The stream answers `Cache-Control: no-store, no-transform` and `X-Accel-Buffering: no`. Caddy
(`deploy/caddy/morfa-routes.caddy`, imported by `Caddyfile.morfa`) sends `/api/*` to the app with
`flush_interval -1` (checked: events arrive within milliseconds) and a long `stream_close_delay`. The process ends every stream on shutdown (`closeDesignLiveStreams`) so a deploy is not held
up; the editors reconnect.

**Known gaps.** Names a layer gets when two people create one at once may repeat ("Rectangle 2" twice), as in Figma.
Comments and shared libraries are not built here. With the streams off an idle editor sees others' changes only when it
saves. The caret mapping and text merge treat a text as one string (no rich operational transform).

**Comments as built (SQL035, `035-design-comments.sql`).**
- Model (`shared/design/comments.ts`: wire types, limits, the text and mention rules both sides check, anchoring). A thread is pinned
  to a page of the file, on a layer or on the canvas: `{pageId, x, y, nodeId, offset}`. A click picks the innermost visible frame,
  component, variant set, instance or section under it (locked ones too; an instance is not entered) and keeps the point in that layer's
  own space, so the pin moves, resizes and rotates with it (`anchorPoint`); `x`/`y` is where the pin stood when it was written, used once
  the layer is gone or on another page. Text is plain (1–4000 characters, no control characters, rendered as text nodes only); a mention
  is a range of the text starting with "@" (`{userId, at, length}`, at most 20).
- Tables: `design_comment_threads` (file, anchor, author, resolved by/at, a tombstone's `deleted_at`, the file's change counter `seq`),
  `design_comments` (the first one opens the thread), `design_comment_mentions`, `design_comment_reads` (how far each account read each
  thread). The rows belong to the file (`ON DELETE CASCADE` from `design_files`), whoever wrote them.
- Routes `/api/design-files/:id/comments` (`server/design/comments.ts`, `comments-router.ts`, inside the files router: its flag, session,
  rollout and error shape): `GET ?since=<cursor>` (every live thread, or what changed after the cursor, tombstones included),
  `POST /` (a thread with its first comment), `POST /:threadId/replies`, `PATCH /:threadId/messages/:commentId` (the author only),
  `DELETE /:threadId/messages/:commentId` (the author, or the team's owner and admins; the first comment takes the thread),
  `DELETE /:threadId`, `PATCH /:threadId {resolved}` (the thread's author or an editor, as in Figma), `POST /read {threads}`.
  Every route reaches the file through `fileAccess(…, 'view')`: every member of the team comments (viewers and developers too), a
  personal file only its owner; writes refuse a file in the trash (404). Mentions must name members of the file's team (checked on the
  server; none in a personal file). Limits: 1000 live threads and 5000 comments per file, 500 per thread (409 `design_comment_limit`);
  120 reads, 60 writes and 120 read marks per minute per account; lists share the document reads' gate (four at a time per account,
  32 on the server); 32 KB bodies.
- Ordering: writes of one file take its comment lock (`design-comments:<fileId>`, project rank after the caller's account lock) and
  the next value of the file's counter, so the counter grows in commit order and `?since=N` never misses a change. A deleted thread
  becomes a tombstone (no comments, no author, no layer) so open editors drop it.
- Unread: comments of others newer than the account's read mark, and newer than when it joined the team (a new member does not inherit a
  backlog). Writing to a thread marks it read for its writer. The file browser's card shows the count of unread comments in open threads
  (`unreadComments` of the file list, one query per page of files).
- Client (`src/design/comments/`): the controller (`controller.ts`) holds a file's threads, cursor and the comment mode's state; the
  tool "Comment" (C, `tool.ts`) is in the toolbar for every role (the read-only store keeps it); the UI (`ui/`, its own lazy chunk)
  draws the pins over the canvas (the author's avatar; a blue dot when unread; resolved ones faded with a check; pins closer than 28 px
  merge into a counted bubble, transitively, and a click on one zooms in until they come apart), the field for a new pin, the thread's
  card (replies, edit and delete own, ✓ resolve, "Copy link", "Delete thread") and the left panel's "Comments" tab
  (open or resolved, only mine, only mentioning me, by date or by page, "Mark all as read", the unread count on the tab).
  Comment mode puts the threads on the left and replaces the right panel's design tools with a short note; Escape closes an open card,
  then goes back to "Move". `@` in a team file lists the team's members (`GET /api/design-teams/:teamId/members`).
- Links: `#design/<file>?comment=<thread>` opens the file in comment mode at the thread (`links.ts`); a thread that is gone says so.
- Live updates: the controller pulls `?since=` through a feed (`feed.ts`). The default feed polls every 20 seconds while the tab is
  visible and at once when the tab comes back or the window regains focus. Real time: after every committed comment write the server
  sends a bare `comments` event on the file's co-editing streams (`recordComments` in `server/design/live/hub.ts`, passed to other
  processes by the fan-out), and the live session calls `commentsChanged(fileId)`, which pulls every open view of that file at once
  (the event names nothing, so viewers get it too; the cursor fetch stays the one merge path). The poll remains the fallback when the
  stream is off (`DESIGN_LIVE=0`) or reconnecting.
- Account life: erasing a file, a team or the account that holds them takes their comments. An erased account's comments in files other
  accounts hold stay part of that file's discussion, detached from it (author `NULL`, shown as "Deleted account", editable by nobody,
  deletable by the team's managers), as an erased operator's replies in support threads; the mentions of it and its read state go. The
  export lists the account's own comments (`design.comments`: id, thread, file, whether it opened the thread, text, times). A member who
  leaves or is removed keeps their name on what they wrote.
- Honesty: SMTP is not configured, so nobody gets an e-mail for a mention or a reply; the mention shows in the list's "Mentioning me only"
  filter, the "You were mentioned" mark and the unread counts, and the comment mode's note says no letters are sent.
- Tests: `tests/design-comments.test.ts` (anchoring, rules, merging, filters, clusters, mention typing), `postgresql-design-comments-
  migration.test.ts`, `postgresql-runtime-design-comments.test.ts` (every route under each role, the cursor, unread, limits, the trash,
  erasure, export), `tests/e2e/design-comments.spec.ts` (pin with a mention, the pin follows its frame, a viewer replies from the link,
  the owner's open file picks the reply up and resolves).

**Shared libraries as built (SQL036, `036-design-libraries.sql`).**
- Places: a team file's library is offered to the other files of that team; a personal file's library to the same
  account's other personal files. Nothing crosses places: another team, another account or a personal file never sees
  it (404, as for a file it cannot open). A file never lists its own library among the ones it can enable.
- Model (`shared/design/libraries.ts`, additive): a file keeps what it uses from a library as read-only copies on a hidden
  page `morfa:library` (`LIBRARY_PAGE_ID`), never listed in `pages`, like Figma's internal canvas. A copied component (or
  set), style, variable collection and variable carries `remote: {libraryId, key, version}` (`key` is its id in the
  library's file, `version` the publication it was taken from). Copies get ids `r<16 hex of the library id>:<id>`, mapped
  per `;` segment, so the ids of instance copies inside a copied component keep naming their instance. The schema keeps
  `remote` nodes on the hidden page only, their roots must be components or sets, and the hidden page can't be listed as a
  page. Instances of a copy are ordinary instances (`componentId` points at the copy), so `syncInstances`, overrides,
  variants and properties work unchanged; library styles and variables are referenced by id like local ones.
- Read-only: the editor never opens the hidden page; pushing overrides to a library component and editing its properties
  are refused (`remote_component`, "A library component is changed in the library file"); a library style opens read-only
  ("Library style: changed in its file"), and a library collection opens read-only in "Variables". Local style
  lists and the local "Components" of "Assets" leave library copies out. "Go to main component" on an instance of a
  library component opens the library's file in a new tab at that component (the person needs access to that file).
- Publish: "File → Publish library…" in the main menu, or "Publish…" in "Libraries". The dialog lists the
  file's components and sets, styles and variable collections; names starting with `_` or `.` are private and unchecked
  by default (Figma's rule), and so are variables marked hidden from publishing. A republication starts from what was
  published, marks "New" and "Changed", and asks "What changed" (up to 1 000 characters). An editor of the file
  publishes; the browser saves first, then sends only the selection and the version it saved. The server builds the
  snapshot from the stored document at that version, never from a document the browser sends.
- Snapshot (`{format: 1, manifest, document}`): a valid document with one page (`morfa:snapshot`) holding the published
  components at 0,0 and everything they need: nested components, defaults of instance-swap properties, styles (including
  those of text runs), variables reached through bindings and aliases, their collections and pictures. The manifest lists
  every published asset with a content hash and `changedIn`, the version it last changed in. A republication keeps
  `changedIn` of an asset whose hash (canonical JSON of the asset and everything it uses) did not change, so only real
  changes reach other files. Copies of another library carried by a published component are published as the
  publisher's own. Limits: 5 000 assets, 20 MB a snapshot; the last 20 versions are kept.
- Unpublish ("Unpublish" in "Libraries"): the library is no longer offered and gives nothing new; files that took assets keep
  their copies. Publishing again resumes it with the next version. A library whose file is in the trash is likewise
  unavailable.
- Use: "Libraries" (the book button in "Assets", or "File → Libraries…") lists "<team name> team libraries" or "Your libraries" with a switch each; enabling and disabling need the edit role. "Assets" shows one section per enabled
  library: its components (folders, list or grid; click places an instance in the middle of the view, drag places it where
  dropped), its styles (click applies to the selection by reference) and its variable collections ("Add <name> to the file"
  takes the whole collection). The first use of an asset asks the server for that part of the current version
  (`POST …/import`) and puts the copies on the hidden page in the same undoable step that places or applies it. Disabling
  a library takes nothing away.
- Updates: on opening a file, any enabled library whose version is newer than the one the file was told about and that
  changed something the file uses greets with "Updates are available for the library <name>" and "View" (once per opening, and
  only for people who can edit). The book button shows a dot and the library's section a chip "N updates". "Library updates" shows each library's "version X → Y", its "What changed", and each changed asset with before and after
  thumbnails; "Update" takes one asset, "Update all" everything, "Later" closes and the greeting waits for the next
  version. An update replaces the copies under the same ids in one transaction, so instances keep their ids and
  overrides; layers using a changed style or variable are re-applied. A file that takes everything is marked as told
  about that version (`seen_version`).
- Tables: `design_libraries` (one per file: holder `user_id`, current `version`, `published_at`, `unpublished_at`),
  `design_library_versions` (immutable: `file_version` it was built from, description, manifest ≤ 8 MB, snapshot ≤ 20 MB,
  `bytes`, the pictures it references in `image_files`, who published it), `design_library_subscriptions` (a file's enabled
  libraries, who enabled them, `seen_version`) and `design_library_pictures` (a picture copied into a place for a library,
  and the picture it was copied from).
- Routes under `/api/design-files/:id` (`server/design/library-router.ts`, the files API's flag, session, rollout,
  origin check and rate limits; every route goes through `fileAccess`): `GET/POST/DELETE /library` (the file's own: read
  with view, publish and unpublish with edit; publishing is a whole-document request with the document slots and a 2 MB
  selection body), `GET /libraries` (the place's libraries and the file's state), `PUT/DELETE /libraries/:libraryId`
  (enable, at most 100 a file; disable), `PATCH /libraries/:libraryId` (`seenVersion`),
  `GET /libraries/:libraryId/versions/:version` (a stored snapshot, for thumbnails and the update review; view) and
  `POST /libraries/:libraryId/import` (the part of a version some assets need; edit, the library enabled and available).
  Errors: 409 `design_library_unavailable` (unpublished, trashed or not enabled), 409 `version_conflict` (the file or the
  library changed in another tab).
- Pictures: an import hands the file only pictures of its own place. A picture the library's file stores in the same
  place is used as is; a picture of another place (the library's file moved after that version was published) is copied
  into the subscriber's place once, outside the transaction, counted in its storage (413 when full), recorded in
  `design_library_pictures` and reused by later imports; a picture whose file is gone is left out. The document is then
  saved through the usual path, so `assertOwnedDesignImages` still checks every picture.
- Space: published versions count toward the holder's document room (`server/design/room.ts`); publishing makes room
  like a version does, and a move or a team handover counts the library's bytes in the new holder's room.
- Moving and copying: a library follows its file (its rows are held by the file's holder; a handover re-holds them). A
  file moved to another place loses the links to the place it left: its own subscriptions and other files'
  subscriptions to its library; every file keeps the copies it took. "Duplicate" starts with the source's enabled
  libraries. Erasing a file removes its library and versions; pictures referenced by another library's versions stay.
- Account life: erasure removes the libraries of every file the account holds, their versions and subscriptions; the
  data export has `design.libraries` (`published`, `versions` with manifest and snapshot, `enabled`).
- Design to code: an instance of a library component is written like a local one, from the file's read-only copy, into
  `src/components/`; its header says "A shared library component (version N): change it in the library file; this is a copy of it.", so the generated project builds without the library's file.
- Client: `src/design/libraries/` (the host, registered by the editor, is small; the session, the dialogs and the "Assets"
  sections load on first use), styles in `styles/libraries.css`.
- Known gaps: there is no per-asset "Detach from library" (detaching an instance works as for any instance);
  a library's variables can be used only after "Add <name> to the file" (variable pickers list the file's collections); versions
  older than the last 20 are dropped, so a file far behind updates straight to the current one; a file whose library
  was unpublished or moved keeps its copies but gets no more updates from it; there is no notification outside the
  editor.

### Meeting (as built, SQL040; details in docs/board-meeting.md)

A shared timer with music, voting sessions, emotes, cursor chat "/", "Get attention" and a high five, in design files and boards.
The timer and the vote are durable (`design_meetings`, `design_meeting_votes`; routes `/api/design-files/:id/meeting` through
`fileAccess`: everyone who opens the file reads, votes and reacts; editors run the timer and votes; 240 reads, 60 changes and 240 ballots
a minute per account; the trash reads only); the stream says `meeting {revision}` and each editor reads the state again, counting down
on the server's clock. Chat, emotes, waves and spotlight are presence (`DesignPresence.meeting`), never stored. Vote counts stay hidden
until the end (a ballot tells only its voter's tabs). Music is generated in the browser, plays only after a gesture and mutes per person.
Erasure removes an account's ballots and forgets it as a starter; the export has `design.meetingVotes`. The client
(`src/design/meeting/`) loads after co-editing in its own chunk: "Reactions and meeting" and the timer pill in the right panel's header, the
voting and emote bars in the toolbar's place; a board mounts the same module through its meeting slot (docs/board.md).

## Toolbar, Actions and modes (2026-10-07)

The bottom toolbar is Figma UI3's (`editor/chrome/Toolbar.tsx`, groups and modes in `chrome/tools.ts`, styles "Floating toolbar"
in `styles/editor.css`): 48 px tall, 32 px buttons with the tools' glyphs at 24 px (the icons' 1.5 px stroke), a 16 px chevron
per group that has a flyout, 8 px between groups, then Actions, a full-height divider and the
modes in an inset segment at the right end.

- Groups (Figma's): "Move tools" Move V, Hand H, Scale K · "Frame tools" Frame F, Section ⇧S,
  Slice S · "Shape tools" Rectangle R, Line L, Arrow ⇧L, Ellipse O, Polygon, Star, Image ⇧⌘K · "Pen and
  pencil" P, ⇧P · Text T · Comment C. Each button shows its group's last used tool; the flyout lists every tool of the
  group: a check on the current one, its icon in a 24 px box, the name, the key right-aligned, 32 px rows (`Menu` class
  `is-tools`). A flyout opened by a click grows from its chevron (opacity and scale 0.97, 120 ms ease-out); opened with Enter,
  Space or an arrow it is there at once; tool buttons and modes never animate (keys switch them all day).
- A tool appears only once its module is registered (`hasTool`; the bar listens to `onToolsChange`, so a lazily registered tool
  shows without a reload), and a group with none is left out: never a dead entry. Tools other work adds join their group by id:
  "Text on path" the text group; "Annotation" (Y) and "Measure" (⇧M) the comment group, which Dev Mode's bar shares
  (`DEV_TOOL_GROUPS` reuses it); Draw's "Lasso" the selection group and "Brush" a group of its own in `DRAW_TOOL_GROUPS`.
- Modes (`ModeSwitcher`, a radio group: one tab stop, arrows move): "Draw" shows `DRAW_TOOL_GROUPS` (selection with the lasso, shapes,
  pen, pencil, text) with the "Design" panel on the right; "Design", "Prototype" and "Code" are the right panel's tabs (choosing
  a tab is choosing the mode); "Code" is Figma's Dev Mode: the "Code" tab and a short bar (selection and hand, comments), ⇧D
  toggles it with "Design". A key that picks a tool the mode's bar has no button for goes to the mode whose bar has it (`modeForTool`: R in
  "Code" or F in "Draw" to "Design", a Draw tool's key in "Design" to "Draw"), so the bar always shows the tool in hand; entering a mode whose bar lacks the tool in hand returns to
  "Move". A person sees only their modes (`modesFor`): a read-only file has no "Draw", a team's viewer no "Code"
  (the panel's "Code" tab still says the code is a developer's). Commands `view.mode-*` ("Draw mode", "Design mode", "Prototype mode", "Dev Mode") are in Actions and "Keyboard shortcuts".
- The canvas in "Code" is inspected, not edited, as in Figma's Dev Mode (`ui.devMode`, which the editor sets with the mode): with
  "Move" a click and the hover reach the deepest layer (as ⌘-click does in "Design"), a drag draws a marquee and moves
  nothing, there are no handles, and a double click or Enter opens no editor; a key or a panel that would edit is refused
  with a toast (§Design to code); comments, "Annotation" and "Measure" work as anywhere. The variant set's "+" hides. With a selection, hovering another layer shows the red distances ⌥ shows in "Design" (⌥ still adds the parent
  frame); otherwise the hovered or selected auto-layout frame shows its padding and the gaps between its children in the flow
  (between its rows too when it wraps; SPACE_BETWEEN's real distances) as pink hatched bands with their values
  (`engine/spacing.ts`, loaded with the mode; a band under 4 px on screen or a turned frame shows none).
- Actions (`editor/ActionsMenu.tsx`, the model in `actions-model.ts`; Figma's Actions, which replaced Quick actions):
  ⌘K as in Figma, ⌘/ and ⌘P as before, or the grid-of-shapes button. It stands over the toolbar, as wide as it (at least
  480 px) and 480 px tall (the search field stays put while the results change); from the button it grows out of it (150 ms
  ease-out), from a key it is there at once. A search field and two tabs, "All" and "Assets" (Tab switches; there is no
  "Plugins" tab: we have no plugins). "All" with an empty search: "Recent" (five), then every command
  by name, greyed when it cannot run now; a search ranks commands and tools together by name (Figma's
  names are synonyms), also when typed in the wrong keyboard layout, what can run first, and Enter runs the top row. "Assets": the file's
  components (a click places one at the view's centre, a drag where it is dropped) and styles (a click applies one to the
  selection), and the libraries' assets.
- Keys checked against the registry (`tests/design-editor-commands.test.ts` fails on a collision): ⌘K (`app.quick-actions`;
  ⇧⌘K stays "Image", ⌥⌘K "Create component"), ⇧D (`view.mode-code`; ⌥D stays "Align right").
- Tests: `tests/design-actions-menu.test.ts` (groups, modes, the search), `tests/e2e/design-toolbar.spec.ts`
  (sizes in both themes, flyouts, motion, Actions and its assets, modes); the canvas in "Code":
  `tests/design-spacing.test.ts`, the move tool's case in `tests/design-commands.test.ts`, `tests/e2e/design-devmode-canvas.spec.ts`.

## Components and prototypes in use (QA sweep, 2026-10-07)

- Components: "Select all instances" (canvas menu, "Object", the ⋯ of "Component" and "Instance") selects a main's (a
  set's: every variant's; an instance's: its main's) instances on the page, or opens the first page that has some. A
  nested instance inside a main can be exposed (`isExposedInstance`, Figma's name; "+ → Nested instance properties" in
  "Component", or the nested instance's ⋯): the main's instances list its properties under its name and set them on
  their copy as overrides; the Figma import keeps the flag. Hiding or locking a layer of an instance with ⇧⌘H / ⇧⌘L is
  an override. A pasted instance whose main stayed in the file it was copied from (`ClipboardPayload.mains`) becomes a
  frame with a note, never an orphan that claims its main was deleted.
- Prototypes: a frame first chosen as an overlay starts with "Close when clicking outside" on. The player lists the
  page's flows (the flow's name in its bar), goes full screen, and a click or a key with an interaction during a
  transition ends it and acts on the new screen. "Mouse down" and "Mouse up" (Figma's Mouse
  down / up) are triggers; a press that already acted ends at its release. The "Mobile app", "Presentation" and
  "Website" templates are clickable prototypes (flows, devices, navigation, a deck's arrow keys, smooth scrolling).
- The player copies its address ("Copy prototype link", at the flow's start); it opens for the people who
  can open the file (a team's members), there is no public prototype link.
- Not built (Figma has them): variables and conditions in prototypes ("Set variable"), comments in the player,
  a public share link, video triggers.

## Board (`src/design/board/`, `shared/design/board/`)

A board is the FigJam alternative: a second file kind (`design_files.kind`, SQL039) next to design files, made with "New board"
in the file browser as a file. A board opens in its own frame (`BoardLayout`, a lazy chunk loaded only for
boards) on the design editor's session: the same store, document model, tiled renderer, saving, co-editing, comments, versions,
export, teams and roles. Board objects (stickies, shapes with text, connectors, stamps, stickers, tables, marker strokes) are
ordinary layers with one optional field, `SceneNode.board`; a design file never runs the board's normalization steps and draws,
saves, merges and exports exactly as before. FigJam's tools and single keys, the context toolbar, the "+" sheet with ten
templates, sorting and tidying. The whole contract: docs/board.md.

## Rules

- Bundle: the editor route's first-load JS is at its ceiling. The app graph may only gain `import type` and a lazy
  `import()` for this product; run `npm run build` (it checks the budgets). Never raise a ceiling. The design area has
  its own routes in `scripts/performance/budgets.mjs`: `designFiles` (the file browser, 203 KiB of gzip initial JS on
  2026-10-07, ceiling 230) and `designEditor` (an open file, 629 KiB, ceiling 700); co-editing, comments, libraries
  and export stay lazy chunks loaded when used.
- Security: stored images are only same-origin `/uploads/…` of the owner (or, in a team file, of the team); prototype URL actions are `http(s)`/`mailto`
  only and open with `noopener`; pasted SVG is parsed with `DOMParser` into nodes and never inserted into the DOM;
  Figma import calls Figma from the browser only. No `innerHTML` with document data.
- Honesty: never show a feature or integration as working when it is not.
- Verification for every change: `npm run check`, `npm test`, `npm run build`, and the e2e specs it touches.
