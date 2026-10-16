# FigJam parity — the board ("Board") on a desktop

The checklist of 2026-10-10. One row per thing FigJam does: what FigJam does, what the board does,
how it was checked, what was done. Checked by running a board in Chromium through the e2e harness at 1440 × 900 and
1280 × 720, light and dark (Playwright; screenshots looked at, not committed), against five FigJam reference
screenshots, then the rest. FigJam itself cannot be opened from the
container, so the rows were checked against FigJam's help centre
(help.figma.com, its text and pictures fetched into a scratch directory, never committed): the row names the article. Where a
row still says "from memory", no article shows it.

**State:** `same` — does what FigJam does; `differs` — does it another way (said how); `missing` — not there;
`fixed` / `built` — was wrong or missing and is now right (the test that failed before is named).

**How checked:** `e2e:board` = `tests/e2e/design-board.spec.ts`; `e2e:parity` = `tests/e2e/design-board-parity.spec.ts`;
`unit:editor`, `unit:model`, `unit:parity`, `unit:templates` = `tests/design-board-*.test.ts`; `unit:meeting` =
`tests/design-meeting-board.test.ts`; `e2e:meeting` = `tests/e2e/design-meeting.spec.ts`; `run` = done by hand in the running
board through a Playwright script (probe), with what was seen.

## 1. Chrome

| FigJam | Board | State | How checked | Done |
|---|---|---|---|---|
| Light grey canvas with a dot grid, small quiet dots | #F5F5F5 canvas in both themes; dots 12 page px apart (2 × 2 device px, never fewer, black at 15 % ≈ #D0D0D0), every other row/column dropped below 10 CSS px; painted into tiles under the content | built | run at 50/100/200 % at 1× and 2× beside the reference picture (dots ≈13 CSS px, ≈2 px, #D4D4D4) and FigJam's (help article attachment 29051798853015); `tests/design-render-dot-grid.test.ts`; frames measured | "Not built yet" 1; spacing and size from the reference picture |
| Top-left pill as FigJam's pictures (its board picture; "Find and use FigJam templates"): logo ▾, the name in bold on one line, a rule, the pages icon (its number when there are several) and the page's name | the name with "Saved" under it, a pages icon alone | fixed | e2e `tests/e2e/design-board-pills.spec.ts`; run (light, dark) | pills slice; saved is announced, not shown; saving, offline and unsaved still show |
| Top-right pill: people (avatar ▾: follow), reactions, comments, the timer with music, a violet "Share", in that order | avatars, timer, reactions, comments, "Share" | fixed (order) | e2e:pills; FigJam's pictures | pills slice; FigJam's layout button in the pill is not built |
| Layout/sidebar toggle in the top-right pill | comments button opens the comments sidebar; no other sidebar | differs | run | nothing else to toggle |
| Bottom bar as the reference FigJam picture: white, ≈710 × 64, radius 14; full-height rules; Move/Hand in 44 px boxes (chosen: filled violet, radius 6); large drawn tools standing on the bottom edge; 24 px icons ≈53 px apart: T, section, table, stamp, actions (sparkle), "+" in a 32 px grey circle | it differed: 614 px, radius 16, 32 px rules, 40 px boxes radius 10, small drawn tools, a comment button, actions as shapes | fixed | e2e `tests/e2e/design-board-bar.spec.ts` (sizes, order, rules, 40 px targets) | bar slice |
| Drawn tools: a tall marker with a cone tip in the ink's colour, a stack of plain notes (two sheets peeking lower left) in the chosen colour, shapes (outlined square, a circle the edge cuts, a curved arrow); under the pointer or in hand one rises onto a grey plate, the marker's tip ≈5 px over the bar | small drawings, filled blue square and red circle, lines on the note, no plate | fixed | e2e:bar (the tip takes the chosen colour); shots | bar slice |
| A tool clicked leaves no focus ring and the next key goes to the board | the button kept focus: the next key drew a blue ring around it | fixed | e2e:parity "should leave focus on the board…" | 2 |
| The bar and trays work from the keyboard: Tab in, ←/→ along, Home/End, Enter; the state is announced (aria-pressed) | Tab only | fixed | e2e:bar "should move along the bar with the arrows…" | bar slice |
| The bar never covers the selection's context toolbar | below a tall selection the context toolbar sat on the bar | fixed | e2e:bar "should keep the context toolbar off the bar…" | bar slice |
| Marker tray as the reference picture: ≈720 × 52, radius 12, 12 px over the bar and 6 px wider on each side; full-height rules; kinds and weights on 32 px tiles (chosen: pale violet, violet drawing); 24 px colour discs ≈43 px apart, chosen with a ring and a white gap; a rainbow for any colour | narrower than the bar, 8 px over it, 32 px rules, discs ringed in violet, kinds on tall tiles | fixed | e2e:bar (position, 40 px targets, one click keeps the tool, the colour on the marker's tip, Escape and V back to Move); shots | bar slice; follow-up: the kinds' drawings fill 36 px tiles, and the palette icon after the rainbow opens "Board colors", the colours already drawn with on the board (a board has no colour styles) |
| Shapes tray: figures, connector lines, fills | 20 figures (5 × 4), elbow/curved/straight connector, 12 fills | same | run | — |
| Sticky tray: colours | sticky colours (large swatches) and a hint | same | run | — |
| Stamp: the toolbar's button opens the stamp wheel (no tray) | it opened a tray of 9 stamps | fixed | e2e:parity "…the stamp wheel above the toolbar's Stamp button…"; "Stamps, emotes, and high-fives" (picture of the wheel over the toolbar) | 3 |
| "+" opens a big sheet; "+" becomes a purple × | same; search ("We cannot read minds, but if you type it, we will find it"), tabs All / Templates / Stickers / Stamps / Emoji | same | run; e2e:board | — |
| "+" sheet's "All" tab grouped by use, as the reference screenshot: each use a section with its templates and a sticker that goes with it | one grid of six templates, then stickers, stamps and emoji | fixed | e2e `tests/e2e/design-board-sheet.spec.ts` | sheet slice; FigJam's "Create custom templates" card is not shown (custom templates are not built) |
| "+" tabs Widgets and Plugins | none | missing | run | larger feature (see "Larger missing features") |
| A new empty board opens the template browser | the sheet opens once on an empty board | same | e2e:board | — |
| Zoom − / % / + and "?" bottom right | same; "?" opens "Help" (shortcuts, guide, support) | same | run; "Pan and zoom in FigJam" | — |
| "Recenter" over the toolbar when the view has left everything | none | built | e2e:parity "…Back to board…"; unit:parity; "Pan and zoom in FigJam" | 4 |
| A board opens zoomed to fit | opens where it was left | differs | "Pan and zoom in FigJam" | kept: the editor's per-file view; listed |
| "Keyboard shortcuts" lists FigJam's keys | listed the design editor's (F frame, S slice, P pen) | fixed | e2e:parity "should list the board's keys…" | 2 |
| ⌘K / ⌘/ quick actions list board actions | listed every design command (annotations, libraries, text case) | built | e2e:parity "should list only what a board does…"; unit:parity | "Not built yet" 3 |
| Context toolbar per kind, as help.figma.com "Sticky notes in FigJam" and "Visualize information using shapes with text" show it: a 48 px dark pill with full-height rules; sticky: colour \| Aa \| bold, strikethrough, link, list \| author (a filled violet tile when on) \| ⋯; shape: figure \| fill, outline \| text \| ⋯ | a 44 px pill; sticky: colour, author, width, handwriting, bold, alignment, lock, ⋯; no strikethrough, link or list | fixed | e2e `tests/e2e/design-board-context.spec.ts` (order per kind, each control saved, width and lock under "More") | context slice; FigJam's sticky size ▾ not built (a sticky fits its own text, docs/board.md §Objects); width, alignment and lock moved to "More" |
| Context toolbar follows pans, hides while dragging or a drawing tool is in hand | same | same | unit:editor; run | — |
| ⌘\ hides the chrome | same; Escape brings it back | same | run (code) | — |
| Dark theme | chrome dark, canvas stays light (as FigJam) | same | run (screenshots dark) | — |
| Comments sidebar: search, filter, ⋯, × | a header "Comments" with ×; open/resolved tabs, search; closed by × or the comments button | fixed | e2e:pills "…close it with its ×" | no ⋯ (its items are the tabs) |
| Zoom and help bottom right, as FigJam's own board picture (help article attachment 29051798853015, measured at 1440 and 1920 beside the board): a small fully round − / + pill and a round "?" of the same height (about 30 px), their bottoms on the bar's bottom line | a 40 px pill with "100%" and a 40 px "?", 4 px higher than the bar | fixed | e2e:pills "…zoom and help…" | 32 px each (a comfortable target); the percentage stays between − and + with hairline rules, since it opens the zoom menu. The pills (48 vs FigJam's 46) and their 12 px insets already matched; the bar follows the reference picture (710 × 64) |

## 2. Objects

| FigJam | Board | State | How checked | Done |
|---|---|---|---|---|
| Sticky 240 × 240, wide sticky | same | same | unit:model | — |
| Sticky colours | 10 colours (yellow, orange, red, pink, violet, blue, teal, green, grey, white) | same | run | — |
| Author name at the foot of every new sticky; a button hides it | hidden until "Show author" | fixed | e2e:parity "should show the author's name…"; "Sticky notes in FigJam" ("Your stickies automatically include your name at the bottom") | 2 |
| Text fits: font shrinks, then the note grows | 24…10 px, then grows | same | unit:model | — |
| Placeholder in an empty sticky | "Write something"; it drew through anything lying on the note (a sticky placed over another showed the hint over it) | fixed | unit:parity "should hide an empty sticky's hint…"; run (screenshot before/after) | 2 |
| ⌘↵ makes the next sticky beside | same | same | e2e:board; unit:editor | — |
| Four dots: drag a connector, click a connected copy | the dots vanished while the pointer crossed the gap out to them, so a click did nothing | fixed | e2e:parity "should add a connected sticky…" | 2 |
| Pasted text makes stickies (several lines: one each) | nothing happened | built | e2e:parity "should turn pasted lines into stickies…"; unit:parity (from memory: the help centre says only that text can be pasted) | 4 |
| Shapes with text: square, ellipse, rounded, diamond, triangle, parallelogram, cylinder… growing with text | 20 figures, text inside, shape grows | same | unit:model; e2e:board | — |
| Shapes (help.figma.com "Visualize information using shapes with text"): dashed or solid outline | an outline colour or none | fixed | unit:quick "…dashed outline…" | "Dashed" under "Stroke"; kept when the figure changes |
| Shapes by name in quick actions ("Type the shape name like rectangle or diamond") | only "Square" and "Ellipse" | fixed | unit:quick | all 20 figures; R and O stay |
| FigJam's other flowchart shapes: horizontal cylinder, file, folder, multiple documents, predefined process, shield, manual input, internal storage, or, summing junction | 20 figures | built | e2e:diagrams "…other flowchart figures…"; unit:quick | "More shapes" at the end of the tray's grid unfolds them in the tray (FigJam's "More shapes"), the figure menu on a shape, "Actions"; their values and outlines |
| FigJam's "advanced" shapes (cloud, server, user…) and third-party sets (AWS, Azure…) | none | missing | "Visualize information…" | listed |
| Corner drag keeps a shape's proportions, a side drag stretches; rotation in 15° steps only | the editor's handles (free corners, ⇧ keeps proportions; free rotation, ⇧ in 15°) | differs | "Visualize information…" | the canvas's handles are shared with the design editor: listed |
| Connectors (help.figma.com "Create diagrams and flows with connectors" and its picture of line types): bent, curved, straight; snap to sides and follow their objects; free ends; the tool stays until V or Esc | same | same | unit:model; e2e:board; e2e:context | — |
| Connector start and end point styles, each its own: none, line arrow, solid arrow, triangle, diamond | "Arrows": none, at the end, at both ends (line arrows only) | fixed | e2e:context "…start and end styles…"; unit:editor | connectors slice: "Start point" and "End point" menus with the five styles |
| Connector label: text on the path; Enter adds a row; background off by default (text in the connector's colour), on: a chip in the connector's colour | a white chip with dark text, whatever the colour | fixed | e2e:context; unit:quick (labelBackgroundOf, setLabelBackground) | "Label background" under "Line color"; a new label is written in the line's colour; recolouring keeps the choice |
| Connector colour, solid or dashed, thin or thick | colour, "Thin / Medium / Thick", "Dashed" | same | e2e:context; unit:editor | a middle weight more than FigJam's two |
| Drag a connector's label along its path | the label stayed in the middle | built | e2e:diagrams "…slide a connector's label…"; unit:quick (labelFractionAt) | on a selected connector the label drags along the path to the nearest share of its length (`labelAt`, a connector field) |
| ⌘ while dragging an end puts it anywhere on an object, not only a side | ends went to a side's middle, the centre or "auto" | built | e2e:diagrams "…an end anywhere with ⌘"; unit:quick | ⌘ (Ctrl) while drawing a connector or dragging its end keeps it at that point of the object (`{node, at}`, a connector field) |
| Drag a path handle to reshape a bent or curved connector (adds a segment at the ends) | the route was computed from the ends | built | e2e:diagrams "…reshape a connector…"; unit:quick (pathHandles) | a selected connector shows a hollow handle in the middle of each stretch (drag: a new waypoint) and its waypoints (drag to move, ⌥-click to take away); "More → Reset bends" (`points`, a connector field) |
| FigJam remembers the last connector style used in a file | each new connector starts plain | fixed | unit:quick "…style last set from the toolbar" | the colour, weight, dash and point styles last set are kept per browser with the trays' choices (FigJam keeps them per file) and given to the next connector, drawn or quick-added |
| Text tool, handwriting face | T; "Handwriting" (Caveat) from the context toolbar | same | unit:editor | — |
| Text: lists | the design editor's lists (unordered/ordered) on board texts | same | code (`ListType`), from the design editor | — |
| Text: links | the design editor's links inside text | same | code | — |
| Sections as FigJam's board picture (help article attachment 29051798853015): a tinted fill, 16 px corners, a thin border a shade deeper, the name chip in the section's colour inside the top-left corner | the same without the border | fixed | `tests/design-board-quick.test.ts` (the border and its colour); run (template screenshot) | sections slice: a 1 px border inside the edge in the chip's colour at 35 %, following "Section color"; sections made before keep none (fixture test) |
| Sections: hide contents | none | built | e2e:diagrams "…hide what a section holds…"; unit:quick | "Hide contents" on a section's toolbar: what it holds is neither drawn nor clickable (`hidden`; the canvas's hidden set and `paintChildren`); exports still draw it (FigJam exports hidden contents hidden: listed) |
| Sections: lock all / lock background only; delete without contents (⌘⌫); templates from the section's title | lock all (the editor's lock); "More → Lock background only" (the section takes no clicks, what it holds does; `backgroundLocked`); ⌘⌫ deletes the section alone; templates from its toolbar | fixed | "Organize your FigJam board with sections" | listed |
| Tables (help.figma.com "Tables in FigJam" and its pictures): ⇧T or the toolbar, then click and drag out the columns and rows | a click put a 3 × 3 table | fixed | e2e:diagrams "…drag a table out…"; unit:quick (draggedTable) | a click still gives 3 × 3 |
| Tables: cells, rows and columns; add a row or column; delete a row or column | same | same | unit:editor | — |
| Tables: add above / to the left; move a row up or down, a column left or right | rows and columns added after only; no moving | fixed | unit:quick "…move rows and columns…" | "Object → Table" and "Actions"; on the cell being typed in |
| Tables: cell background colour; font, bold, strikethrough, links, lists, alignment from the toolbar | face and bold only | fixed | e2e:diagrams; unit:quick (setCellColor) | "Cell color" (the cell being typed in, or every cell), the text controls and alignment as on a text |
| Tables: export as CSV | export as a picture or PDF only | built | e2e:diagrams; unit:quick (tableCsv) | "Export table as CSV" (UTF-8 with a BOM, so spreadsheets read non-Latin text) |
| Tables: merge cells | none | built | e2e:diagrams "…merge a table cell…"; unit:quick "…merge a cell…" | on the cell being typed in: "Merge with the cell to the right" / "Merge with the cell below", "Unmerge cells" (toolbar, "Object → Table", "Actions"); `colSpan` / `rowSpan`, laid out by the table's normalization (covered cells leave the flow or keep the place invisibly; typing and Tab go to the merged cell). FigJam merges any adjacent selection; the board grows a merge one cell at a time |
| Tables: select one cell, a row or a column (grabbers, ⌘ / ⇧ click); drag a border to resize a row or column; the blue bars and dots to add at the end or in the middle; ⌘D duplicates rows; paste between tables | a click selects the whole table, a double click types in a cell | missing | "Tables in FigJam" | the canvas's selection and handles (the canvas's hit-test and overlays): listed |
| Tables: paste from a spreadsheet | nothing happened | built | e2e:parity (pasted cells); unit:parity; "Import spreadsheet data, images, and designs" | 4 |
| Tables: Tab / ⇧Tab to the next / previous cell | Tab did nothing useful in a cell | built | unit:parity; "Tables in FigJam" | 4 |
| Tables: "Convert to stickies" quick action | none | built | unit:parity; "Import spreadsheet data…" | 4 |
| Tables: import a CSV from the menu | "File → Import table from CSV…" (and "Actions"): a table in the middle of the view; comma or semicolon, quoted cells | built | e2e:together; unit:quick (parseCsv, csvPlan); "Import spreadsheet data…" | 50 rows × 20 columns, as a paste |
| ⌘↵ on a shape: a blank shape beside, open for typing | only stickies | built | tests/design-board-quick.test.ts; "Visualize information using shapes with text" | 4 |
| Stamps; your avatar stamp | 9 stamps incl. "My stamp" | same | e2e:board | — |
| Stamp wheel at the pointer (E): a disc of slices with a stamp each, a middle with "+" for more; E again opens more; Esc or a click elsewhere leaves the stamp tool | E showed the tray only; then a ring of badges, E again left the tool | built | e2e:parity (wheel, held E, Escape/click elsewhere); unit:parity; "Stamps, emotes, and high-fives" | "Not built yet" 2, then 3 (looks and keys as the article's picture) |
| Stamps attach to the sticky or shape they are put on and move with it | stayed on the page when the note moved | fixed | e2e:parity "should attach a stamp…"; unit:parity; "Stamps, emotes, and high-fives" | 2 |
| Hover a stamp to see who added it | the name is stored (`by`), not shown | built | unit:quick (hoveredStampAuthor); "Stamps, emotes, and high-fives" | small, listed |
| Hold and wiggle to grow a stamp; resize a placed stamp | fixed 48 px; resized by its handles like any layer | built | e2e:together "…grow a stamp held and wiggled…"; unit:quick (grownStampSize); "Stamps, emotes, and high-fives" | held and wiggled, a stamp grows up to 3× where the press began; a placed one still resizes by its handles |
| Shift-click with the stamp tool bursts emotes | emotes were only in "Reactions and meeting" (hold on the canvas) | fixed | e2e:together; unit:quick (boardEmote); "Stamps, emotes, and high-fives" | listed |
| Stickers and emoji | 16 drawn stickers, emoji tab | same | e2e:board | — |
| Marker, highlighter (multiplies), washi tape, eraser (strokes only) | same | same | e2e:board; "Doodle and highlight in FigJam with drawing tools" | — |
| ⇧ while drawing makes a straight marker or highlighter line | the stroke followed the pointer | fixed | e2e:parity "should draw a straight marker line…"; "Doodle and highlight…" | 2 |
| Highlights stick to the objects they touch and move with them | stayed on the page | fixed | e2e:together; unit:quick (highlightHolder); "Doodle and highlight…" | a highlight lying wholly on a sticky or a shape with text is placed in it, as stamps are; one that runs off it stays on the board |
| Marker draws thin grey by default | thin black | differs | "Doodle and highlight…" | kept: black reads better on the light canvas; the tray's first colour |
| Custom washi tape from an uploaded picture | 9 colours of drawn tape | built | e2e:diagrams "…washi tape with a picture…" | "Tape from picture" in the marker tray (washi): the picture is uploaded into the board (as any picture) and tiled along new tape, the tape's width high; a colour puts it back |
| Images pasted in | the design editor's image paste | same | code (`pasteImages`) | — |
| Links pasted in become a preview card | a pasted link was a sticky with the link text | built | e2e:diagrams "…a pasted link into a card…", "…as a sticky when…"; unit:quick | one pasted web address asks `GET /api/design-files/:id/link-preview` and becomes a card (picture, the title as the link, three lines of description, the site), a group of ordinary layers; a page with no preview stays a sticky with the link |
| Code blocks | none | missing | — | listed |
| Mind maps (help.figma.com "Create mindmaps in FigJam" and its pictures): from the shapes picker; "Start a mind map" on a selected text; ⌘↵ a child, ⇧⌘↵ a sibling; texts joined by soft grey curves from the right of a node | a "Mind map" template of ordinary shapes; no quick keys | built | e2e:diagrams; unit:quick "…grow a mind map…" | "Mind map" in the shapes tray (a topic and three ideas), "Start mind map" on a text's toolbar, ⌘↵ / ⇧⌘↵ on a text, each new node open for typing (an empty one goes with its branch). Nothing new stored: nodes are texts, branches curved connectors |
| Mind maps: + beside a node | none | built | e2e:diagrams "…from the + on its right" | the move tool's dot on the right of a text already in a map (children grow rightwards; FigJam also grows left) |
| Mind maps: drag an object onto a node to join it | none | built | unit:quick "…dropped on a mind map text…" | a + shows on the node while a sticky, shape or text is dragged over it; dropped, a branch joins them (a node of a map moves from its old parent) |
| Mind maps: colour a whole map | none | missing | "Create mindmaps in FigJam" | listed |
| Mermaid text pasted becomes a diagram | none | built | e2e:diagrams; unit:quick "…Mermaid flowchart…"; "Create diagrams and flows with connectors" | flowcharts (`graph` / `flowchart`, any direction): node shapes, labelled, dashed and thick edges, chains and `&`, laid out in layers with loops left out of the layering; other Mermaid diagrams (sequence, ER…) are pasted as text |

## 3. Working together

| FigJam | Board | State | How checked | Done |
|---|---|---|---|---|
| Cursors with names | co-editing cursors | same | e2e:board (two people live) | — |
| Cursor chat ("/") | same | same | run (focuses the chat field); e2e:meeting | — |
| Reactions and emotes | "Reactions and meeting": 7 reactions, hold on the canvas | same | run (screenshot); unit:meeting | — |
| High five | "High five" | same | run (menu) | — |
| Follow a person | a click on an avatar | same | code (PresenceUI) | — |
| Spotlight | "Get attention" | same | run (menu); unit:meeting | — |
| Timer: start, +1 min, sound, music | presets, −/+, music, start; "+1 min" while running; volume | same | run (screenshot); unit:meeting | — |
| Timer (help.figma.com "Stay on track with the timer in FigJam"): type minutes and seconds up to 99:59; ↑ / ↓ a minute or a second, ⇧ five; Return starts; the clock flashes while paused; everyone sees it shake at 00:00 | whole minutes from −/+ and presets; no keys; a still clock when paused or done | fixed | e2e:together "…timer's minutes and seconds…" | the shake and the blink are left out when motion is reduced |
| Voting: "End for everyone" asks first | ended at one press | fixed | e2e:meeting (updated) | — |
| Voting: a prompt ("Pick your 3 favourite ideas"); how each person voted; a "Results" tab of past sessions to reopen or delete; others' cursors hidden while voting | none | built | e2e:together "…vote with a prompt and hidden cursors…" | on the meeting routes: "Voting question" and "Hide participants’ cursors" in the setup (an editor switches the cursors from the vote bar), the prompt in the bar and over the results, who voted how under each result, "Past votes" in "Reactions and meeting" (the last twenty, an editor deletes one). The cursors hide by a mark on the editor's root (meeting.css), the co-editing layer untouched |
| Voting | "Voting…" with badges on votable objects | same | unit:meeting | — |
| Comments and the comments sidebar (C) | same | same | e2e:board | — |
| Who can edit and view; viewers read-only | "Share"; roles as design files | same | e2e:board (viewer) | — |
| Audio call | none | missing | — | listed |

## 4. Arranging

| FigJam | Board | State | How checked | Done |
|---|---|---|---|---|
| Select, marquee, shift | the design editor's | same | run | — |
| Lock | context toolbar and menu | same | unit:editor | — |
| Group | ⌘G | same | menu | — |
| Align and distribute (help.figma.com "Select, move, and order objects in FigJam": six alignments from the selection's toolbar) | "Arrange" in the main menu only | fixed | e2e:diagrams "…align several objects…" | "Align" on the toolbar of a multiple selection: the six alignments and even spacing |
| Tidy up's spacing lines and reorder dots inside the selection (drag to change spacing, drag a dot to swap places) | tidy up into a grid; no lines or dots | missing | "Select, move, and order objects in FigJam" | the selection's handles are the canvas's (the canvas's overlays): listed |
| Tidy up | "Tidy up" | same | unit:editor | — |
| Sort stickies by colour / author | same | same | unit:editor | — |
| Bring to front, send to back | "Object" menu and keys | same | menu | — |
| Duplicate by ⌥-drag | same | same | run (probe: a second sticky 300 px below) | — |
| Duplicate ⌘D | a copy beside | same | run (probe) | — |
| Copy and paste between boards, and into design files | the editor's clipboard (objects as ordinary layers; connector ends follow copies) | same | unit:editor (copied connector) | — |

## 5. Keys (by physical key, so every keyboard layout types the same codes)

| FigJam | Board | State | How checked |
|---|---|---|---|
| V move, H hand, Space hand while held | same | same | unit:editor |
| M marker, ⇧M highlighter, W washi tape, ⇧⌫ / ⇧Delete eraser | ⇧W for washi tape | fixed (W added, ⇧W kept) | unit:parity; "Doodle and highlight…" |
| S sticky, ⇧S section | same | same | unit:editor; run |
| R rectangle, O ellipse | same | same | unit:editor |
| X or ⇧L bent connector, L straight connector | L drew a plain line, ⇧L a straight connector | fixed | unit:parity; "Create diagrams and flows with connectors" |
| ⇧T table | no key | fixed | unit:parity; "Tables in FigJam" |
| T text, C comment, E stamp wheel | E opens the wheel at the pointer; again: more | same | e2e:parity; "Stamps, emotes, and high-fives" |
| ⌘/ (and ⌘P) quick actions | ⌘K, ⌘/ and ⌘P | same | e2e:parity; "Sticky notes in FigJam", "Import spreadsheet data…" |
| ⇧1 fit, ⇧0 100 %, ⌘= / ⌘− zoom | same | same | run (probe: 100 %, 149 % fit, 200 %) |
| ⌘D duplicate, Delete, ⌘G group, ⌘Z / ⇧⌘Z | same | same | run (probe) |
| Design tools a board does not have (F, P, ⇧P, K, A) | swallowed | same | unit:editor |
| 1–9 pick a stamp while the wheel is open | same | built (Morfa's own; the help centre shows none) | e2e:parity |

## 6. Templates

| FigJam | Board | State | How checked |
|---|---|---|---|
| Template list; one placed in the view as one undo step, zoomed to | 10 templates in groups; same placing | same | e2e:board; unit:templates |
| Templates from a section's title (help.figma.com "Find and use FigJam templates", "Organize your FigJam board with sections") | none | built | e2e:diagrams; unit:quick "…template's content in a section…" |
| Turn off the template picker for new files (Preferences → "Show templates for new files") | the "+" sheet always opened on a new board | built | e2e:diagrams |
| Custom templates ("Create custom templates"): publish a board as a team template (name, description, picture), publish its changes, use it from the picker's team tab | none | built | e2e:templates-team (publish meets the server's limit answer; insert from the team list) | "File → Publish as template…" (and from "+" → "Templates"): name, description, "Team" or "All of my teams"; "Team templates" in "+" → "Templates" inserts one in the view (the template routes; the picture is the board's thumbnail). A team keeps up to five (the server's rule) |

## 7. Export

| FigJam | Board | State | How checked |
|---|---|---|---|
| PNG, PDF of the board or the selection | "Export board": PNG (white or transparent), one PDF page, 1×/2× | same | e2e:board |
| JPG; backgrounds per format (help.figma.com "Export your FigJam board"): PNG transparent, solid or grid; JPG solid or grid; PDF solid | PNG and PDF; white or transparent | fixed | e2e:diagrams "…JPG on the dotted canvas…" | "Background": "White", "Transparent", "Grid" as FigJam's table allows |
| Stickies and tables to CSV (a sticky's content and "Created by" when its name shows) | none | built | e2e:diagrams; unit:quick (tableCsv) | "CSV" in "Export board": "Stickies" (Text, Author) or "Tables" (a file each); and "Export table as CSV" on a table |
| The dot grid is not exported | export paints through the renderer's export path, which never asks for dots | same | code (`dotGrid` only in the canvas's options) |

## Looks different (ranked; what is left)

1. Comments sidebar header: FigJam has search, filter, ⋯ and × in one row; the board's has tabs and a filter, no ×. ~1 h,
   but the sidebar belongs to the comments module: listed.
2. Section "hide contents" toggle in the context toolbar (with the rule above). ~half a day with the document rule.
3. Timer chip in the top-right pill while running: checked only idle here (unit:meeting covers the running chip).

## Larger missing features (not started; sizes ±50 %)

| Feature | Size | Needs |
|---|---|---|
| Widgets and plugins ("+" tabs) | weeks | a sandboxed runtime, an API, a catalogue |
| Audio call | 1–2 weeks | WebRTC (SFU), the meeting module, server signalling |
| Link preview cards | 2–3 days | a server fetch of a page's title and picture (SSRF guard), a board object kind |
| Code blocks | 2 days | a board object kind (monospace text in a frame, syntax colours), the context toolbar |
| Highlights attached to objects | half a day | as stamps (absolute children), the eraser and the marker's hit test |
| Mermaid paste | 3–4 days | a Mermaid parser for flowcharts, laid out with the board's factories |
| Mind maps with Tab / Enter | 3–4 days | a mind-map object (auto-laid branches), keys, the context toolbar |
| Custom templates | 2–3 days | saving a selection as a team template, the "+" sheet's tab |
| Section "hide contents" | half a day + review | a per-section field (`SceneNode.board`), a document change |
| Sections drawn as FigJam's newer pictures (help "Organize your FigJam board with sections"): a 2 px border in the section's colour, the name chip above the section | half a day | the section chip and border are painted in `src/design/engine/render/overlays.ts` (the canvas's): listed; FigJam's own board picture keeps the chip inside, as the board does now |
