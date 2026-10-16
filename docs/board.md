# Board — the whiteboard of Morfa

A board is the FigJam of Morfa: a file kind next to design files, opened in its own light, playful editor (stickies,
shapes, connectors, the marker, stamps, sections, tables, templates) on the same engine as design files: the same store,
document model, tiled renderer, co-editing, comments, versions, export, teams and roles. Read docs/design-tool.md first; this
file covers only what a board adds. The working name "Board" lives in one place (`shared/design/board/names.ts`), so it
can be renamed.

> Status: built and verified in the real app (unit, e2e, PostgreSQL runtime tests). What is not
> built yet is listed at the end ("Not built yet"). The "Meeting slot" API is final and is what the meeting module builds on.

## Meeting slot (for the meeting module)

The meeting features (timer with music, voting sessions, emotes and reactions, cursor chat "/", spotlight/follow, high five)
live in their own module, which mounts in both editors. The board gives it two places and an API about board objects; all
types are in `src/design/board/meeting.ts` (types and a registry only, safe to import statically).

**Mounting.** The board calls `loadBoardFeatures()` (`src/design/board/features.ts`) once it shows. Add one lazy line there,
e.g. `() => import('../meeting/board')`; that module calls

```ts
import {registerBoardMeeting} from '../board/meeting';
registerBoardMeeting({Controls: MeetingControls, CanvasLayer: MeetingCanvas});
```

- `Controls` renders inside the board's top-right pill, between the people here (avatars) and the board's own buttons
  (comments, "Share"). Keep it to pill-height (32 px) controls: the timer chip, a voting button, the spotlight menu.
- `CanvasLayer` renders in a full-size layer over the canvas, under the board's chrome. The layer's own box takes no pointer
  events; give interactive children `pointer-events: auto`. Cursor chat, emotes, the spotlight frame, high fives go here.

Both get `BoardMeetingProps`: `services` (the open file's `EditorServices`: store, `canvas()` with `view.pageToScreen` /
`screenToPage`, `toast`, `readOnly`...), `realtime` (`Realtime | null`: `realtime.live` has the peers and the presence channel,
null until co-editing loads or when offline), `board` (below) and `editor: 'board'`.

**Board objects** (`BoardObjectsApi`, valid while the board is open):

| Call | What it does |
|---|---|
| `objectAtPage(point)` / `objectAtClient(clientX, clientY)` | The board object under a page point or a pointer position, top-most, or null. An object is what a click selects as a whole: a sticky, shape with text, stamp, sticker, text, table, connector, marker stroke. A section is never answered (the object inside it is); a sticky's text answers the sticky. |
| `objectBounds(id, 'page' \| 'client')` | Its box in page coordinates or client px; null when it is not on the current page. |
| `votableObjects()` | What a vote can be cast on, on the current page: stickies, shapes, stamps, stickers, texts, tables (not connectors or strokes). |
| `setBadges(source, badges)` | Replaces one source's badges (`'voting'`, `'reactions'`); `[]` removes them. A badge `{id, count, label?, tone?}` is drawn at the object's top-right corner over the canvas and follows pans and zooms; `count: 0` hides it; `tone` `accent` (purple, default), `mine` (filled: the viewer voted) or `neutral`. Badges of several sources on one object stack left of each other. |
| `interceptClicks(handler)` | While registered, a primary click on the canvas (any tool) is offered to `handler({id, page, clientX, clientY, shiftKey, altKey, mod})` first; returning true consumes it (no selection, no drawing). The last registered handler is asked first. Returns the unregister function. Use it for "click a sticky to vote". |
| `pageId()` / `onPageChange(listener)` | Votes are per page. |

Votes themselves (who voted on what, the session's limits, its timer) belong to the meeting module and its own storage or
presence channel; the board stores nothing about them. A stamp placed with the stamp tool (E) is an ordinary board object (see
"Stamps"), not a vote.

## File kind

`design_files.kind` (`'design' | 'board'`, SQL039, default `'design'`: every file made before is a design file). The kind is
fixed when the file is made (`POST /api/design-files` `{kind: 'board'}`) and copied by "Duplicate", a version's copy and a
board's `.rdesign` copy (`DesignPortableFile.kind`). `DesignFileSummary.kind` carries it to the file browser and the editor. A
board's stored document is marked `board: true` whoever made it (`asBoardDocument`). A board counts as a file everywhere: the
trash, the 5 GB of documents, versions, comments, rate limits, roles and `fileAccess`.

File browser: "New board" next to "New file" (top bar and both empty states) makes an empty board in the current place
(personal files or a team's project); a board's card has a purple "Board" chip and a sticky-note icon until it has a picture.

## The editor and its chunk

`DesignEditor` opens the file, sees `kind: 'board'` and loads `src/design/board/editor` with `import()` beside the first page's
fonts, before the session exists; `prepareBoard(store)` registers the board's tools for that store before the canvas mounts. The
session is the design editor's (saving, co-editing, comments, versions, export, conflict and save-guard dialogs, the canvas and
what goes over it); only the frame differs: `BoardLayout` in place of `EditorLayout`. Nothing of the board is in a design file's
first load: the board chunk holds the tools, chrome, edits and commands; the "+" sheet and the templates load with its first
opening. What the design editor's first load gained is glue only (measured 2026-10-07, gzip): DesignEditor +1.2 KiB (the kind's
wiring, hit testing and the text editor's guard below), the file browser +0.6 KiB ("New board", board cards), the schema +0.4
KiB (the board field), the label painter +0.2 KiB (coloured section chips).

A board's canvas stays light in both themes (its notes and ink are drawn for paper, as FigJam's); its chrome follows the theme.
Its canvas has FigJam's dot grid (`engine/render/dot-grid.ts`): dots 12 page px apart (about 2 device px), every other row and column dropped
while they would come closer than 10 CSS px, painted into each tile right after its background, so a pan costs nothing more (a 512 px
tile's dots cost at most 0.17 ms to raster in headless Chromium; pan and zoom frames on a four-template board were the same with
and without, p50 16.7 ms, p95 16.8 ms, measured 2026-10-10). The canvas only: export, thumbnails and the GPU renderer do not draw it.
A board never writes the design editor's view preferences (rulers, grids) and has none of them on.

## Objects

A board object is made of ordinary layers (frames, shapes, vectors, texts, groups), so the renderer, export, co-editing,
hit testing and Figma import need nothing new and every existing file draws exactly as before. One optional field,
`SceneNode.board` (`shared/design/board/types.ts`), says what the layers are (`kind`) and holds what cannot be read off them
(a connector's ends, a stamp's id). The factories in `shared/design/board/create.ts` make each object the same way for the
tools, the templates and paste.

| Object | Layers | Notes |
|---|---|---|
| Sticky | vertical auto-layout frame (paper, shadow) → text (`part: 'text'`), author (`part: 'author'`, hidden until "Show author") | 240 × 240; wide 480 × 240 (`wide`). Its text takes the largest size of 24…10 px that fits (scaled with the note); then the note grows. A hand-resized note keeps that height as its least height. |
| Shape with text | auto-layout frame → figure (`part: 'shape'`, absolutely placed, stretched: rectangle, ellipse or a vector from `shapes.ts`) and centred text | 20 figures; the text keeps to the figure's inside (insets per figure) and the shape grows with it. |
| Connector | group → line (`part: 'line'`, a vector with arrowheads) and an optional label (`part: 'label'`: on the canvas in the line's colour, or with "Label background" a chip in the line's colour) | Ends `{node, magnet}` on an object (`auto` faces the other end, or a side, or the centre) or a free `{x, y}`. Straight, elbow (rounded corners, stubs) or curved. Each end has its own point style (none, arrow, filled arrow, triangle, diamond: the line's start and end markers). Runs again whenever an end's object moves; dragged alone it comes off its objects. A new connector takes the colour, weight, dash and point styles last set from the toolbar (kept with the trays' choices). |
| Stamp | round frame → icon vector or glyph text | FigJam's set plus "My stamp" (initials, a colour per name). |
| Sticker | group of vectors and ellipses | 16 drawn stickers (`art.ts`). |
| Table | vertical auto-layout frame → rows (`part: 'row'`) → cells (`part: 'cell'`, a frame with a text) | Rows take their tallest cell; rows and columns are added and removed in place. |
| Stroke | a vector (marker, highlighter: multiplied) or a group (washi tape) | Smoothed cubics fitted to the samples. |
| Section | an ordinary SECTION | On a board its name chip takes the section's colour. |

Plain text pasted on a board (not a copy of objects) becomes stickies: a line each, in a near-square grid in the middle of the
view, list bullets and numbers left off, at most 100; tab-separated rows (cells from a spreadsheet) become a table (`paste.ts`).

A click selects a board object whole, never a layer inside it (`liftToSelectable`); a layer selected inside one (after typing)
is lifted to the object; board objects are never drop targets; they have no frame titles. A text of a board object stays when it
is left empty (the text editor removes empty texts elsewhere). The schema validates the field and merge treats it as a record, so
two people moving a connector's two ends both land.

**Normalization.** A board's document (`doc.board`) runs two more steps, installed where boards open
(`shared/design/board/install.ts`, called by the board chunk, the templates and the tests; `shared/design/normalize.ts`
imports none of them): before layout, stickies fit their text and hand-resized notes and shapes keep their height; after layout,
connectors whose ends moved run again (indexed per node table and carried across commits). A design file never runs them.

## Tools and keys

By physical key (`KeyboardEvent.code`, so every keyboard layout works), in the capture phase before the design editor's commands
(`src/design/board/keys.ts`, `BoardLayout`'s `useBoardKeys`). Tools switch at once (no animation: they are pressed all day).

| Key | Tool | What it does |
|---|---|---|
| V | Move | Figma's move tool plus: double click types into a sticky, shape, cell or a connector's label; four dots around a hovered sticky or shape (drag: a connector from that side; click: a connected copy in that direction, open for typing); a selected connector's ends drag onto other objects. |
| H, Space | Hand | |
| M, ⇧M, ⇧W, ⇧⌫ | Marker, highlighter, washi tape, eraser | The tray: kind, thin/thick, colours and any colour. The tool stays for the next stroke. The eraser takes strokes only. |
| S | Sticky | A click places a note of the tray's colour, open for typing; ⌘↵ while typing makes the next one beside it. |
| R, O | Shapes | A drag draws (⇧ square, ⌥ from the centre), a click makes 200 × 200; the new shape is open for typing. The tray: 20 figures, connector lines, fills. |
| X, L, ⇧L | Connector, line, straight connector | A drag from an object (or anywhere) to an object (or anywhere); near a side's middle an end snaps to it; ⇧ straight. |
| T | Text | The design text tool; "Handwriting" face (Caveat, self-hosted with the catalogue) from the context toolbar. |
| ⇧S | Section | |
| ⌘↵ / ⇧⌘↵ on a text | Mind map: child / sibling node | A new text right of the node (under its last child) or under it, joined by a grey curve, open for typing; an empty one goes with its branch. "Start mind map" on a text's toolbar does the same; "Mind map" in the shapes tray places a topic with three ideas. |
| ⌘⌫ | Delete section, keep contents | On a selected section: the section goes, what was inside stays where it was on the board and is selected (⌫ deletes both). |
| — | Table | 3 × 3 with a header row. |
| E | Stamp | Toggles the stamp tool and its tray and opens "Stamp wheel" at the pointer (kept inside the canvas): a click on a stamp, 1–9, or releasing a held E over one picks it; Escape or a press elsewhere puts the wheel away. The tool stays for the next stamp. A click places it at 48 px; held and wiggled it grows (1 px per 10 px of travel, up to 144 px) where the press began; ⇧-click bursts it as an emote while a meeting runs. Hovering a placed stamp names who put it. |
| C | Comment | The comments sidebar (search, filter, threads) on the right. |
| ⌘K | Actions | Quick actions: the board's tools (with their keys), its commands and the design editor's commands its main menu offers; never the design editor's others (`actions.ts`). "Keyboard shortcuts" lists the same keys. |

Design tools a board does not offer (frame, slice, pen, pencil, scale…) are swallowed; ⌘-chords stay the design editor's.

## Chrome

FigJam's floating chrome on the design tokens plus one board-only token set (`.dz-board`: `--bd-accent` #9747FF, #A673FF dark):
top left the main menu (`BOARD_MENU`: the design editor's commands a board needs plus the board's), the name with its save state
and the pages; top right the people here, the meeting slot, comments and "Share" (who sees the board, copy the link);
bottom right zoom and help; at the bottom the bar as FigJam has it (64 px,
radius 14, three groups divided by full-height rules, Move and Hand in 44 px boxes, a large drawn marker, note stack and shapes
standing on its bottom edge that rise onto a grey plate, then text, section, table, stamp, actions and "+"; comments are in the
top-right pill) with its trays 12 px above it and 6 px wider on each side (52 px, choices on 32 px tiles in 40 px targets, ←/→
along them); "+" opens the sheet (search; templates, stickers, stamps, emoji). A new empty board opens the
sheet once. The **context toolbar** over the selection (dark, follows pans and zooms outside React, hidden while a drawing tool
is in hand) offers what the selection is (FigJam's order, `docs/figjam-parity.md`): a sticky's colour, "Aa" (the face), bold, strikethrough,
link, list and its author switch; a shape's figure, fill and outline, then its text ("Aa" holds the size); a connector's line,
arrowheads, colour, weight and dash; a text's colour, text and alignment; width, alignment and lock under "More"; a section's colour and
"Fit to contents"; a table's rows and columns; for several objects "Tidy up", for several stickies sorting by
colour or author; lock and "More". Motion follows the app's motion rules: trays, the sheet and the sidebar rise
from their trigger in 160 ms ease-out and appear at once from a key; press feedback scale(0.96); reduced motion keeps fades only.
The sticky hints ("Write something") draw on their own layer (`editor/Decor.tsx`), never exported.

## Templates

`shared/design/board/templates.ts`: Brainstorm, Crazy 8s, Mind map, Retrospective, Meeting notes, Icebreaker, Kanban, Customer journey
map, 5 whys, Flowchart — data built with the board's factories, so a template is ordinary board objects. The "+"
sheet places one in the middle of the view (one undo step) and zooms to it.

## Export

A design file exports the layers that carry export settings; a board has no such panel, so while a board is open "Export…"
(⇧⌘E, the main menu) opens "Export board" instead (`editor/ExportBoard.tsx`, registered over the design dialog's id): the
whole board (the page's visible objects) or the selection, PNG (on white, or transparent) or one PDF page holding the picture
losslessly, 1× or 2×, painted by the canvas's renderer. A board larger than a browser can encode (16 384 px a side, 256 Mpx) is
scaled down to fit and the toast says so. The vector PDF of design files (server Chromium) is not used for boards.

## Arranging

Sort stickies by colour or by author into tidy groups (`arrange.ts`), "Tidy up" (as Figma's), fit a section around what
it holds, align and distribute from the menu.

## Tests

Unit: `tests/design-board-fixture.test.ts` (a board made before the FigJam-parity pass opens unchanged), `design-board-parity.test.ts` (the FigJam-parity
fixes), `design-render-dot-grid.test.ts`, `tests/design-board-model.test.ts` (objects, normalization, connectors, merge), `design-board-templates.test.ts`,
`design-board-editor.test.ts` (keys, menu, ⌘↵, sorting, tables, context edits, the meeting slot's objects API),
`design-portable.test.ts` (a board's copy). E2E: `tests/e2e/design-board-parity.spec.ts` (the stamp wheel, quick actions, paste, the shortcuts list, focus, the four dots),
`tests/e2e/design-board.spec.ts` (the file kind,
stickies, shapes and connectors, marker and eraser, templates and the sheet, comments, export and versions, a team's board
edited by two people live and watched read-only by a viewer). PostgreSQL:
`tests/postgresql-runtime-design-boards.test.ts`, `tests/postgresql-design-boards-migration.test.ts`.

## Not built yet (ranked)

The three items listed here before the FigJam-parity pass (the dot grid, the stamp wheel, a board-only list in quick actions) are built. What a
board still lacks against FigJam, with sizes, is in `docs/figjam-parity.md` ("Looks different", "Larger missing features").
