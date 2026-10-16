# Morfa for Marketplaces

Product cards for Wildberries, Ozon and Yandex Market, designed, built, published and measured in Morfa. The plan
has thirteen features in three modules; this file is how they
are built. Each module keeps its own section below.

## Shared base

- **Rules** — `shared/design/marketplace/specs.ts`: frames, formats, sizes, file limits, logo rules, banned words, badge zones per
  marketplace, versioned and dated (`MARKETPLACE_RULES_VERSION`). The editor shows the date beside the checks.
- **Card markers** — `shared/design/marketplace/meta.ts`: a card is an ordinary top-level frame whose `pluginData['morfa.mp.card']`
  holds its marketplace, slide, set (`group`), audience, SKU, variant and export settings. A layer's role on the card (product,
  logo, watermark…) is `pluginData['morfa.mp.role']`; the marketplaces it shows on, `pluginData['morfa.mp.show']`. pluginData is
  saved, synced, undone and validated like any field (≤ 100 keys, ≤ 10 000 characters a value) and the renderer never reads it.
- **Spec Lint** — `shared/design/marketplace/lint.ts`: pure checks over `CardFacts`; `facts.ts` reads them off the document.
- **Card Score** — `shared/design/marketplace/score.ts`: 50 points of Spec Lint, 50 of CTR against 5 %; under 2 % is flagged.
- **Editor** — "Card" in the "Design" tab (`src/design/marketplace/sections.tsx`, order 15): a plain top-level frame offers to
  become a card; a card shows "Check", "Export", "Generation", "Sales"; a layer inside a card shows its role. The canvas draws
  card overlays under the selection (`src/design/marketplace/overlay.ts`).
- **Server** — `/api/marketplace` (`server/marketplace/router.ts`, behind the session) and `/api/marketplace-media/<token>`, the
  public links marketplaces download published pictures from.
- **Database** — migration 027 (`server/postgresql/schema/027-marketplaces.sql`): brand kits, seller connections, card links,
  published pictures, publications, A/B tests and daily numbers.

## Card Canvas

### Frames and the new card

- **Frames** — "Marketplaces" among the frame sizes (F): "Wildberries", "Ozon", "Yandex Market" at 900 × 1200 and "Ozon fresh 1:1"
  at 1200 × 1200 (`src/design/panels/frame-presets.ts`). The frame is made a card at once: the marketplace, slide `main` and a new
  set (`group`), named "WB · Main photo". One undo step.
- **New file** — "New file ▾ → Marketplace card" asks for the marketplace and "One card" or "Set of six
  slides" (`src/design/marketplace/canvas/NewCardChooser.tsx`), then builds the starter
  (`shared/design/templates/marketplace.ts`, template id `marketplace`): the main photo with a headline, one line of benefit, a
  shadow and a product placeholder, each with its role, laid out to pass Spec Lint on all three marketplaces (the tests hold it to
  that). The set asks the slide kit (`buildSlideKit`) for six slides; while the kit gives none, the file has the main photo.
- **A plain frame** — a top-level frame offers "Marketplace card": WB / Ozon / YM (the last choice is remembered in the
  browser) and "Make card"; a frame of other proportions also gets "Fit to 900 × 1200", which scales it and its
  layers to fit inside 900 × 1200, grows it to that size with its layers' constraints and moves top-left-pinned layers to the
  middle of the new room (`canvas/card-ops.ts`). Proportions within 1 % count as right; Ozon also takes a square.
- **Moving a card** — the switch in "Check" moves a card to another marketplace (one undo step); a name in the "WB · …" pattern
  follows.

### Badge zones

- `src/design/marketplace/canvas/zones-overlay.ts` draws, for every card on the page that is on screen, its marketplace's
  `safeZones` (fractions of the frame in `specs.ts`, so they follow any size, rotation and zoom): a thin dashed red outline and a
  faint tint. A zone is named only on the selected card (or the card of a selected layer), only unrotated, and only when the zone
  is large enough on screen for its name.
- "View ▸ Marketplace badge zones" (`view.card-zones`) switches them (`ui.cardZones` in the store, on by default; not kept
  between visits yet). The overlay canvas is never exported.

### Spec Lint

- **Facts** — `collectCardFacts` (`shared/design/marketplace/facts.ts`) reads what the marketplace's picture shows: visible layers
  that are shown on that marketplace, cut to the frame and to clipping frames, with boxes in the frame's space through the world
  matrices. Texts carry their largest font size (scaled with the layer) and its weight; layers with a role or a picture fill are
  listed. Export settings come from the card's meta. Pictures in the set: the cards with the same `group`, marketplace and SKU,
  one per slide — variants and WB's two covers of a slide count once, a card without a slide counts as its own.
- **Measurements** (`src/design/marketplace/canvas/measure.ts`), only while "Check" is open, 600 ms after the card's last edit,
  one at a time (`use-card-lint.ts`); the pure checks follow edits within 150 ms, and an edit outside the card wakes neither.
  - File size: `renderCardImage` (Card Canvas export). While it throws, "File size" says "No data".
  - Text contrast: the card copied out of the document (its subtree only, layers hidden for the marketplace hidden) and rendered
    twice at 450 px wide through `exportRaster` — with its texts and without. A text in known solid colours (its fill and its
    runs') is compared with every background pixel under its box; any other text is read off the picture at the pixels it
    changed. The answer is the 10th percentile, not the mean (`shared/design/marketplace/contrast.ts`). WB needs 4.5:1, or 3:1
    for large text (24 px, or 18.66 px from 600, at a 900 px card).
  - Product cover: the share of each "Product" layer's box under layers painted above it — boxes, not pixels, so it leans high;
    groups, masks, layers under 25 % opacity and the shadow, light and background roles cover nothing (`productCoverage`).
  - Proofing: `useCardProofing` (Card Canvas proofing); until it answers, "Spelling" waits.
- **"Check"** (`canvas/LintTab.tsx`): the verdict for the card's marketplace, the marketplace switch whose segments carry each
  marketplace's result ("WB ✓", "Ozon ✕ 2", "YM !"), the failing and waiting checks with their findings (a click selects and
  shows the layers), the passed ones folded into "Passed: N", and "Rules as of 22.09.2026". The other two marketplaces reuse
  the card's measurements (same file size and contrast), so their verdicts are close, not exact, for layers shown on one only.
- **On a layer** — the layer's own findings, from the card's last check (never measured there), with "Card check" back.

### Layer roles

- "Layer on the card" for any layer inside a card (`canvas/LayerRole.tsx`): "Role on the card" (None, Product, Brand logo,
  Store logo, Watermark, Headline, Badge, Benefit, Background, Shadow, Light) and "Show on" WB / Ozon / YM. Each
  change is one undo step; all three on drops the key. "Product" locks the layer; another role unlocks it again.

### One master, three exports

- **Reflow** — `reflowForMarketplace(doc, frameId, marketplace, measurer)` (`shared/design/marketplace/export.ts`) makes the
  marketplace's copy of a card without touching the file: layers whose "Show on" leaves the marketplace out are hidden;
  logo roles the marketplace refuses are dropped (WB: brand logo, store logo, watermark; Ozon and YM: store logo) unless the
  layer's "Show on" lists that marketplace explicitly — possible only for a subset, since all three on is the default; and
  a card of other proportions is re-boxed to the marketplace's (the width stays, the height follows 3:4; Ozon keeps a square for
  "Ozon fresh 1:1") through the layers' constraints, then laid out again by a commit (auto layout, text resizing).
- **Render** — `renderCardImage(services, frameId, marketplace, settings): Promise<Blob>` (`src/design/marketplace/export/render.ts`;
  Spec Lint's file size and publishing use it): the reflowed copy through `exportRaster` at the card's scale and quality. Over the
  marketplace's 10 MB it steps the quality down by 10 and tries again, never under WB's 65 % nor 50 % elsewhere; a PNG
  stays as it is and is reported as too large.
- **"Export"** (`export/ExportTab.tsx`): format (from `specs.ts`), scale 1× / 2×, quality (slider and field, WB's 65 % marked on the
  slider; a lower value is warned about), the marketplaces WB / Ozon / YM. The format, quality and scale are the card's
  (`meta.export`, one undo step; a slider drag is one gesture). "Export" downloads one zip `<card>/WB.jpg, Ozon.jpg,
  YM.jpg`; "Whole set · N" downloads the set (the cards of the same `group`, in swiping order) as `<set>/01 Main photo.jpg …`,
  in a folder per marketplace when more than one is ticked. The files are listed with their sizes, a squeezed quality and any
  file still over 10 MB. Zips are stored (pictures are compressed already) with fflate; `export/run.ts` loads on the first export.

### Slide kits

- `buildSlideKit({marketplace, slides, origin, group, brand})` (`shared/design/marketplace/slide-kits.ts`) builds the six slides —
  "Main photo", "Benefits", "Specs and sizes", "How to use", "Reviews and trust", "In real life" — as vertical auto-layout
  frames of the marketplace's card size, side by side 120 px apart, each with its card meta `{marketplace, slide, group}`.
- Each has a neutral "Product photo" placeholder (role "Product") that fills the room left, and the parts its kind needs: headline,
  badges and benefits with their roles, a tick icon per benefit, a specs table of auto-layout rows, numbered steps, a rating with
  stars and two quote cards, a full-bleed "Lifestyle photo" behind a caption. Texts hug or fill their column, so a longer text
  wraps and the photo shrinks; the padding keeps everything out of every marketplace's badge zones (tests hold it to that).
- Colours and fonts come from a brand kit when one is chosen (fonts matched against the library, else Inter); without one, a quiet
  neutral palette in Inter. The sample texts pass the spelling check and every marketplace's banned words.
- "Slide set" in "Export" marks the slides the set has and offers "Add" for each missing one, or "Add missing · N",
  with an optional "Brand" (`useBrandKits()`): the new slides go to the right of the set, level with its top, in one undo step; a
  card without a set starts one under its own id.

### Russian text proofing

- **Spelling** — `POST /api/marketplace/proof` `{fileId, texts: [{id, text}]}` (≤ 60 texts of ≤ 2 000 characters; the file must be
  one the account can open; 120 a minute) → `{issues: {[id]: [{word, message, suggestions}]}}`, free
  (`server/marketplace/canvas/proof-router.ts`, `spelling.ts`). Words with digits, Latin words and short all-capitals abbreviations
  (≤ 5 letters) are skipped; hyphenated words are right when every part is; "ё" and "е" are both accepted. Suggestions are capped
  at 12 words a request, and answers are kept per word.
- **Dictionary** — Hunspell's Russian dictionary (`dictionary-ru` 3.0.0, BSD-3-Clause, © Alexander I. Lebedev) run by
  `hunspell-asm` 4.0.2 (MIT, Hunspell compiled to WebAssembly), loaded lazily once per process. Measured here: about 250 ms to
  load and +27 MB of memory, 0.2 ms a word, about 140 ms a suggestion; `nspell` with the same dictionary took 3.3 s and +250 MB, so
  it was not taken. `npm audit` reports the old `nanoid` 2 inside `hunspell-asm`; it only names its in-memory files and is never
  given an input, so the advisories (sizes that are negative, zero or not integers) do not apply.
- **Client** — `useCardProofing(frameId)` (`src/design/marketplace/proof/client.ts`) returns `Record<NodeId, ProofIssue[]>`, or
  undefined until the card's first check: 600 ms after typing stops it sends only the texts nobody has checked and keeps answers by
  text (the same text elsewhere or after an undo is not asked again). Spec Lint shows them as "Spelling".

## Catalog Generation

"Generation" of a selected card (`src/design/marketplace/generate/GenerateTab.tsx`): "Product", "Variants", "WB covers" (WB only),
"Brand kit" and "Catalog". Hidden in read-only files. Server: `/api/marketplace/generation`
(`server/marketplace/generation/router.ts`), 404 while the design tool is closed to the account; types and the route list in
`shared/design/marketplace/generation.ts`.

- **One job at a time** (`generate/runs.ts`) — a cut-out, batch or cover pair runs per editor with a progress bar and
  "Stop", and keeps running if the tab is closed. It ends in one line: "Show" selects what was made, "Dismiss". The card
  stays selected throughout, so the tab stays open. Each result is one undo step (`generate/apply.ts`), checked against the file's
  limits before it is committed, as a paste is.

### Brand kit

- **Kit** (`shared/design/marketplace/brand-kit.ts`, table `marketplace_brand_kits` of migration 027,
  `server/marketplace/generation/brand-kits.ts`) — a name, five colours (primary, secondary, accent, background, text), a headline and
  a body font, a brand logo and a store logo, up to 24 icons. Only its owner reads or changes
  it; at most 20 per account, counted under the account's lock. Routes: `GET/POST /brand-kits`, `PATCH/DELETE /brand-kits/:id`.
- **Dialog** "Brand kit" (`generate/BrandKitDialog.tsx`) — HEX fields with swatches and the colour picker, the editor's font picker,
  pictures uploaded into the open file. "Save and apply" saves and applies in one go.
- **Apply** — "Apply to card" restyles the card by role in one undo step (`brandKitChanges`): headlines take the heading font,
  benefits the body font (each at the nearest weight the face has), both the text colour; badges the accent, their text whichever of
  the kit's colours reaches 4.5:1 on it, else white or black; a plain background the kit's background; logo, watermark and store-logo
  layers the kit's logos. Layers the kit has nothing for are left alone. The chosen kit is remembered per editor; variants and covers
  use it too (without one, neutral defaults).
- **Pictures** — a file stores only pictures of its own place, so `POST /brand-kits/:id/pictures {fileId, urls?}`
  (`server/marketplace/generation/pictures.ts`) copies the kit pictures the card needs into a team file, or into a personal file of
  another place; the owner's own pictures in a personal file are used as they are. A picture that can no longer be read (its team
  left, the file it was uploaded into erased) is left out: the dialog shows "No file" and the apply says the logo is unavailable.

### Product cut-out

- "Remove background", free (`server/marketplace/generation/cut-out.ts`, `POST /cut-out`, one at a time per account) — flood-fills the
  colour at the photo's border in from the edges (tolerance from the border's own spread), drops specks and feathers the edge by a
  pixel or two. For studio photos on an even background; a photo whose border is not one colour is refused in words.
- The result is cropped to the product with a 3 % margin, stored as PNG, and placed over its photo where the product stood (the
  photo's crop, fill and mirror are followed) as a locked layer "Product" with role `product`, the photo hidden under it. Cutting the
  same photo again replaces the earlier cut-out.
- **"Product colour as in the photo"** (`productColorMatch`) — a pure check that the product layer is painted as shot: no picture filters,
  full opacity, "Normal" blend for it and the groups around it, and no layer above it that blends into it (a blend mode or background
  blur over a fifth of it) or tints most of it. Otherwise it lists what changes the colour.

### Variants and WB covers

- **Variants** — 2–12 (10 by default), all on the kit's colours (solid, linear and radial mixes). Each also gets its own badge
  (shape and a text allowed on the marketplace) and composition (scale, offset, a slight turn, a mirror, and which product layer when
  there are several) (`planVariants`). The headline stays the card's own.
- **WB covers** — "Pair of WB covers" makes "New buyers" and "Returning buyers" (a "New" badge, the second product
  layer or a closer crop), with `audience` in their meta.
- Copies are ordinary editable card frames in a row to the card's right, past anything standing there, named "Mug · variant 3",
  in the card's set (`group`; a card without one takes its id, which it joins), `variant` or `audience` in their meta. One undo step.
- **Stop** — "Stop" stops the job; a batch that has started building still lands in one step.

### Not done and tests

- **Not done** — a team file gets a fresh copy of the kit's logos on each apply; pictures of a kit go with the file they were
  uploaded into (re-upload in the dialog).
- **Tests** — `tests/design-marketplace-generation.test.ts` (the plan of a batch, the colour check, product placement, kit changes,
  cut-out mapping with crop and mirror, copies as undo steps on a real store, the cover pair),
  `tests/design-marketplace-generation-cutout.test.ts` (flood fill on even, gradient and noisy backdrops, refusals),
  `tests/postgresql-marketplace-generation.test.ts` (kit routes and ownership, 20 kits under concurrent creates, the gate, picture
  places and copies, the cut-out route), `tests/e2e/design-marketplace-generation.spec.ts` (in the app: cut-out, three variants, the
  WB pair, a brand kit made and applied, all saved).

### Catalog run

"Catalog from a table" in "Generation" (`src/design/marketplace/catalog/CatalogRunButton.tsx`): the selected card is the template, and
each row of the seller's table becomes an editable copy of it. The dialog is one of the editor's own (`marketplace-catalog`, loaded
on first open, `CatalogDialog.tsx`), so it stays open while the run adds a page under it. Hidden in read-only files.

- **Table** — a file dropped or chosen, or cells pasted from Excel or Google Sheets (they arrive as TSV). CSV with commas or
  semicolons (the most consistent per line wins, so Russian Excel's "12,5" does not fool it), quoted fields, doubled quotes, line
  breaks in cells, a BOM, CRLF; UTF-8, UTF-16 by BOM, otherwise strict UTF-8 and Windows-1251 when that fails
  (`shared/design/marketplace/catalog-table.ts`). XLSX: the first sheet in tab order, shared, rich and inline strings, formula
  results, numbers without float noise, booleans as "Yes"/"No"; opened with fflate and read by a small XML tokenizer that expands
  no entities or DTDs (`catalog-xlsx.ts`, no DOM). Dates stay Excel's serial number (styles are not read); the old binary .xls is
  refused with "save as .xlsx or .csv". Limits: 20 MB, 5 000 rows, 200 columns, 5 000 characters a cell; empty headers become
  "Column C", repeated ones "Price (2)". The dialog shows the first five rows.
- **Mapping** (`catalog.ts`) — the template's visible texts in reading order, then its pictures (an image fill, or a "Product" layer),
  each with a column, "Keep as is", "Fill into {{…}}" (a text holding `{{Column}}` placeholders) or, for a picture, "Files from the
  computer". Automatic: a SKU column by its header (Russian and English seller headers, such as Артикул, Артикул продавца, SKU, vendorCode, offer_id…); placeholders; a column
  named as the layer or as its sample text; then by role (headline ↔ a name column, e.g. Название/Наименование, benefits in order ↔ "Benefit 1, 2…" columns (Преимущество 1, 2…),
  badge ↔ a badge or promo column (Плашка/Акция)); the product picture ↔ the photo column (a header about photos whose cells are links, or any column that is
  mostly links). The first row with a SKU is previewed beside each layer. A SKU column is required; rows without a SKU are skipped
  and counted.
- **Photos** — a column of links (the first http(s) address of a cell; several may be listed) fetched by the server, or files
  dropped in the dialog matched to rows by the SKU in the name: "12345.jpg", then "12345_1.png", then "крем-12345-белый.webp" (Cyrillic file name: sample data); "123"
  never matches "1234.jpg". Dropped files go through the file's own upload (`POST /api/design-files/:id/images`, 60 a minute: the
  run waits and retries on 429).
- **Room** — before the run the dialog says how many rows fit under the caps in force (`documentCaps()`: 50 000 layers and 20 MB,
  or the big-files caps; 200 pages; 10 000 pictures), estimating each card as the template's JSON plus the mapped cells, and offers
  "Create N cards" for that many.
- **Run** (`catalog/run.ts`) — a new page "Catalog — 12.10.2026" ("(2)" when taken), cards in a grid about as tall as wide, at most ten
  across, 10 % of the card's side apart. Each card: `cloneSubtrees` of the template (fresh ids, instance children re-derived), texts
  replaced through `insertText` so they keep the style of the text they replace (a placeholder's style for its value), an empty cell
  hides its layer (no stray sample, no gap in auto layout); an auto-width text that no longer fits wraps — it fills its auto-layout
  frame when that frame does not hug its width, otherwise it gets a fixed width up to the card's side margin (the least distance of
  the card's other layers from its edges; a centred text keeps its centre) and grows down. Picture fills take the photo (a crop
  becomes FILL; a product place without an image fill gets a FIT one); a row without a photo keeps the placeholder. The card's meta
  gets `sku` and `group` = the template's group or id (`variant` dropped); the card is named by its SKU. Changes inside instances
  become overrides. Rows go in batches of up to 50 (fewer for a heavy template: ≤ 5 000 layers and ~3 MB a batch), each batch one
  undo step with its pictures' records; photos of a batch arrive before it. Progress shows photos, then cards; "Stop" ends after
  the current step and keeps what was made. The summary lists "Without a photo: N" with each SKU and why (no link, the site's answer, no
  file), and the rows skipped without a SKU; "Go to the catalog" opens the page on its first rows.
- **Server** — `POST /api/marketplace/catalog/fetch-images {fileId, urls ≤ 50}` (`server/marketplace/catalog/router.ts`) →
  `{results: [{url, ref, asset} | {url, error, code}]}` in the order asked. The caller must be able to edit the file
  (`fileAccess(…, 'edit')`). Each address: https only, no credentials or ports, the host resolved and every address checked public,
  the connection pinned to it, each redirect (≤ 3) checked again, ≤ 20 MB, 30 s (`fetch-image.ts`, the pattern of
  `server/hosting/https-request.ts`), four at a time, each address once; stored with `storeDesignImage` (re-encoded, counted against
  the picture storage limit). A full storage stops the rest of the request. Per account: 40 requests per ten minutes, one at a time.
- **Not done** — brand kits are not applied by the run (the cards keep the template's fonts and colours); dates and number formats
  of XLSX cells are not read.
- **Tests** — `tests/design-marketplace-catalog-table.test.ts` (CSV quirks, cp1251 against Node's own decoder, UTF-16, an XLSX built
  with fflate, the XML tokenizer), `tests/design-marketplace-catalog.test.ts` (slots, auto-mapping, photo matching, one row's card
  through real transactions, wrapping, caps, 300 rows in six batches), `tests/design-marketplace-catalog-route.test.ts` (the route
  with a fake download and store, the address checks), `tests/design-marketplace-catalog-run.test.ts` (the editor's run on a real
  store: batches as undo steps, each address fetched once, files by SKU, stop, refusals), `tests/e2e/design-marketplace-catalog.spec.ts` (a 5-row Windows-1251 CSV
  over a simple card makes five cards with the right texts, saved).

## Performance Loop

Publish a card to Wildberries or Ozon from the canvas, read its numbers back onto the canvas, and A/B test two covers. Code:
`server/marketplace/loop/` (server), `shared/design/marketplace/loop.ts` (types) and `loop-stats.ts` (the arithmetic both sides
share), `src/design/marketplace/loop/` (editor).

### Switches
- **`ENABLE_MARKETPLACE_API=1`** (with `ENABLE_DESIGN_TOOL=1`) turns it on (`config.ts`); off, every loop route is a 404 and "Sales"
  says it is off. **`HOSTING_ENCRYPTION_KEY`** must be set to save a connection (without it: 503 "The platform owner has not set up secure storage for connections yet", nothing is sent to the marketplace). **`APP_ORIGIN`** must be the public address: Ozon downloads
  the picture from it.

### Connections
- **Wildberries**: one token with the "Content" and "Analytics" categories. **Ozon**: Client-Id and Api-Key. `POST
  /api/marketplace/connections` checks the key with one cheap read (WB: one card of `content/v2/get/cards/list` and the analytics
  `ping`; Ozon: `v3/product/list`, limit 1), then stores it sealed with AES-256-GCM bound to `marketplace:<userId>`
  (`server/hosting/secrets.ts`). Answers carry the label, a hint (`…c2b4`, `Client-Id 123456`) and the status, never the key. Ten
  connections an account.
- A 401/403 from the marketplace, at any call, marks the connection `refused`: syncs and publishing stop, and "Sales" asks
  "Reconnect" (`POST /connections/:id/key`). `DELETE /connections/:id` removes it with its links, numbers and tests.
- Only the in-memory fakes are reachable under `NODE_ENV=test` (`fake.ts`, `useMarketplaceFake`); the real adapters (`wb.ts`,
  `ozon.ts`) load lazily otherwise. Every outside call has a 20 s timeout, refuses redirects and turns the marketplace's own error
  text into the message (`adapters.ts` `callMarketplace`).

### Link, publish
- **Link** (`POST /links`): a card frame stands for one product and one photo slot (1 = main, up to 30). The seller searches their
  catalogue by name, article or number (WB `cards/list` `textSearch`; Ozon `v3/product/list` + `v3/product/info/list`); the server
  checks the product exists before saving. One link a frame; `POST /links/:id/node` moves it (the next round of a test).
- **Publish** (`POST /publish`, multipart): the editor renders the frame with the Export's own renderer (`renderCardImage`); Spec
  Lint's errors ask "Publish anyway" first. The server keeps the picture as `marketplace_media` under a random 43-character
  token (only its SHA-256 is stored), served for 7 days at `/api/marketplace-media/<token>.jpg` (no index, private cache).
  - WB: `content/v3/media/file` multipart with `X-Nm-Id` and `X-Photo-Number` — live at once.
  - Ozon: `v1/product/pictures/import` with the product's other pictures kept in order and the slot replaced — `sent`; the worker
    polls `v2/product/pictures/info` until live or failed (failed after a day without an answer). Ozon refuses WebP.
  - A picture going live closes the previous live one's hours (`live_until`); that history is what numbers are attributed by.

### Numbers
- The worker's job `marketplace-loop` (`server/worker.ts`, every 15 minutes, `worker.ts` here) syncs each connection every 3 hours
  over the last 7 days, confirms Ozon pictures, runs rotations, deletes expired pictures and numbers older than 400 days.
- **WB** `api/v2/nm-report/detail/history` (seller-analytics-api): up to 20 nmIDs a call, 21 s between calls, by Moscow day. `openCardCount` → clicks
  (card opens), `addToCartCount` → carts, `ordersCount` → orders; impressions only when the answer has them (the funnel usually does
  not, so CTR shows "—"). **Ozon** `v1/analytics/data`, dimensions `sku`, `day`: `hits_view` → views, `hits_view_pdp` → clicks,
  `hits_tocart` → carts, `ordered_units` → orders; 61 s between pages. Each mapping is a small function in `mapping.ts` with tests.
- Rows are upserted into `marketplace_metrics` (connection, product, day). A 429 backs that connection off for 30 minutes.
- **Attribution** (`loop-stats.ts`): the marketplaces count by Moscow day (UTC+3), so a day's numbers belong to the frame that was the
  slot's live picture for more than half of it; a day split in two belongs to neither. Before anything was published from Morfa the
  product's numbers show as the product's ("for the product").

### On the canvas and in "Sales"
- Under each linked frame: "Impressions 12,400 · CTR 3.1% · Add to cart 410 · Orders 96" in the frame titles' grey, shortened to "CTR ·
  Orders" or "CTR" as the frame narrows; "—" for what the marketplace does not report; a red dot when CTR is under 2 % (with at least
  200 impressions); a green "Winner" above the frame that won its last test (`metrics-overlay.ts`). The numbers are read for the
  open file (`GET /files/:fileId/cards`, the caller's own links only) when a card is on screen, every 10 minutes after, and at once
  after a publish or a test change (`cards-store.ts`).
- "Sales" (`SalesTab.tsx`): connect, link, then the numbers larger, conversion, a 14-day sparkline (CTR, or card opens without
  impressions), Card Score, "Publish" with its status and history, the A/B test, "Unlink from product".

### A/B tests
- **"Rotation in Morfa"**: A goes live at once; the slot swaps to B at the next Moscow midnight, then every 24, 48 or 72 hours, for 1–60
  days (14 by default), so every day counted is whole. The server cannot render frames, so both pictures are uploaded when the test
  starts (`media_a`, `media_b`, kept a week past its end). Six hours after the end (one more sync for the last day) it is judged: a
  two-proportion z-test on CTR when both variants have impressions, else on orders per card open (WB); the better one wins at p <
  0.05, otherwise "no clear winner". The winner (A on a tie) is left live. "Stop" puts A back.
- **"Test in the seller account"**: the marketplace's own test, which has no API. Morfa downloads A and B, says where to start it, and the seller
  marks the start day and enters the winner.
- One test at a time per card; "Tests in this file" lists the file's running ones with days left, the live variant and "Stop". A
  finished test offers "Next round from the winner": the link moves to the winner and a copy of it becomes the next variant B.

### Account erasure
`eraseMarketplaceOf(tx, userId)` (`erasure.ts`, called by `eraseAccount` beside `eraseMcpOf`) deletes the account's rows in every
table of migration 027 (brand kits included) and the published picture files.

### Not verified, not built
- The WB and Ozon request and answer shapes follow their published documentation as of 2026; the build machine could not reach
  dev.wildberries.ru or docs.ozon.ru, so `mapping.ts` reads leniently (older and newer field names) and must be checked against the
  live APIs with a real key before the switch goes on: WB's analytics `ping`, the nm-report field names, Ozon's picture info v2, and
  which Ozon analytics metrics need a Premium subscription.
- The account's "Connections" screen (the assistants' dialog) does not list marketplace connections; they are managed from "Sales".

### Tests
`tests/design-marketplace-loop-stats.test.ts` (Moscow days, attribution, the z-test, the rotation's clock, the strip's words),
`tests/design-marketplace-loop-mapping.test.ts` (every WB and Ozon field mapping, the fakes), `tests/postgresql-marketplace-loop.test.ts`
(the switch, a key sealed and never returned, link, publish and the public picture, sync and upsert, refused and 429, a
rotation swapped at midnight and judged, a cabinet test, sweeping, erasure), `tests/e2e/design-marketplace-loop.spec.ts` (connect the
fake WB, link, publish, the CTR on the canvas, a rotation to its winner and the next round). The e2e server's `/__e2e/marketplace` sets
the fake's numbers and moves the loop's clock (`clock.ts`) ahead.
