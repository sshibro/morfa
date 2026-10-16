# Figma Design parity — the desktop editor

Started 2026-10-10. One row per thing Figma Design does: what Figma does, what Morfa does
today, how it was checked, and what this pass did. Figma's reference is its current interface (UI3).

**Status**: ✅ same · ≠ differs · ✗ missing · 🔧 fixed by this pass (was wrong or different).
**Checked**: **run** = driven in the running editor by this pass (Playwright, Chromium, 1440 × 900 and 1280 × 720, light
and dark; the probes read the store and the saved document); a spec name = an e2e spec of the suite, run green on this
branch; a unit-test file name = `tests/<name>.test.ts`; **code** = read in the source only; **from memory** = Figma's
behaviour as remembered, not confirmed in Figma's help centre. Where a row cites help.figma.com, its article (text and
pictures, fetched through the help centre's public API and looked at) is the reference.

The baseline: the whole e2e suite (`npx playwright test`) ran green on the base branch apart from the two
`design-engine.spec.ts` cases that need the wasm build (the gate builds it).

## 1. Chrome

| # | Figma | Morfa | Status | Checked | Done |
|---|---|---|---|---|---|
| 1.1 | Bottom floating toolbar (UI3): Move/Hand/Scale · Frame/Section/Slice · Shapes · Pen/Pencil · Text · Comment, a chevron flyout per group showing the last used tool, Actions, the Dev Mode toggle at the right | The same groups and order, flyouts with keys and a check, "Actions", modes segment ("Draw / Design / Prototype / Code") at the right end | ✅ | run; design-toolbar.spec | — |
| 1.2 | Tool keys V H K F/A ⇧S S R L ⇧L O ⇧⌘K P ⇧P T C; the bar lights at once | Same keys (physical keys, so they work on any keyboard layout); a key that picks a tool of another mode switches the mode | ✅ | run (cmds dump); design-toolbar.spec | — |
| 1.2a | With nothing selected the arrows pan the canvas, ⇧ further (help.figma.com "Use Figma products with a keyboard") | The arrows did nothing without a selection | 🔧 | design-arrow-pan, design-figma-parity-panels.spec | 40 screen px, ⇧ 240; a focused list or panel keeps its arrows |
| 1.2b | A drawing tool and Return place the object without a pointer (help.figma.com "Use Figma products with a keyboard") | Not built | 🔧 | design-figma-parity-panels.spec | Shapes, lines, frames, sections, slices: Enter places the click size in the middle of the view; the text tool starts a text there, typing at once |
| 1.2c | F6 / ⇧F6 (Ctrl+F6 on Windows) move the focus between the toolbar and the panels (help.figma.com "Use Figma products with a keyboard") | Not built | 🔧 | design-figma-parity-panels.spec | Canvas → toolbar (the pressed tool) → left panel (the layers tree) → right panel (the selected tab) → canvas; F6 and Ctrl+F6 both work |
| 1.2d | Keyboard box selection ⌥Space / Ctrl+Space: a cursor the arrows move, Enter selects, ⌘ + arrows draw a box (help.figma.com "Use Figma products with a keyboard") | Not built | 🔧 | design-figma-parity-panels.spec | "Keyboard selection": a pink cursor; 8 px a step, ⇧ 40; Escape leaves |
| 1.3 | Navigation bar along the left edge (help.figma.com 360039831974, updated 2026-10): the Figma menu, File, Agents, Assets, Tools, Variables as labelled icons; beside it the file name, Pages (collapsible), Layers | Was the previous UI: the main menu and "File / Assets / Comments" tabs inside the left panel | 🔧 | run; design-figma-parity-panels.spec | `chrome/NavRail.tsx` on desktops: menu, "File", "Assets", "Comments" (Morfa's own), "Variables". No Agents or Tools (no plugins). Phones keep the tabs (PH) |
| 1.4 | Layers: icon per kind, nesting, hover shows lock and eye, selection highlight, collapse all ⌥L, rename by double-click, ⌘-click toggles, ⇧-click range, search | All of it | ✅ | run | — |
| 1.5 | Layers: drag to reorder and to reparent (absolute position kept) | Same | ✅ | run | — |
| 1.5a | The Pages section folds behind a chevron (help.figma.com "Layers 101" pictures: "› Pages", "⌄ Layers") | Always open | 🔧 | design-figma-parity-panels.spec | Folds; folded, the header names the current page; remembered per browser |
| 1.5b | ⌘R with several layers: Rename layers — one name, the current name, numbers up or down, find (regular expression) and replace, a preview (help.figma.com 360039958934) | ⌘R renamed only the last layer | 🔧 | design-batch-rename, design-figma-parity-panels.spec | "Rename layers" from ⌘R and the row menu; numbered in the panel's order, top first |
| 1.5c | Page dividers: an empty page whose name starts with "-" (help.figma.com "Create and manage pages") | A page like any other | 🔧 | design-page-divider, design-figma-parity-panels.spec | A line in the list; not opened by a click or the arrows; renamed, moved and deleted as a page |
| 1.6 | Right panel header: avatars (click follows), Present ▶, Share; then "Design / Prototype" tabs and the zoom % | Avatars, ▶, export, "Share"; "Design / Prototype / Code" tabs and the zoom menu. "Code" is a tab as well as the toolbar's mode (Figma: only the toggle) | ≠ | run | Kept: "Code" as a tab is the base's Dev Mode design |
| 1.7 | Design panel sections in UI3 order (help.figma.com 360039956914, 360050986854, 360041065034 — their pictures): selection header, **Position** (alignment row, X, Y, rotation and flips, constraints), **Layout** (flow: freeform / vertical / horizontal / grid, W, H, sizing, clip content; titled **Auto layout** while on, with the alignment box, gap and padding), **Appearance** (eye and blend droplet in the header; opacity and corner radius in one row; Independent corners → Corner radius details with the smoothing), Fill, Stroke, Effects, Layout guide, Export | Was UI2's grouping: "Position" held X Y W H, sizing, rotation, radius, constraints and clip; the alignment row sat in the header; "Auto layout" was a section of its own with a direction control; "Layer" held blend and opacity under captions | 🔧 | run; design-figma-parity-panels.spec | "Position" with the alignment row, "Layout" with "Flow" and auto layout ("Auto layout" while on), "Appearance" as UI3 (§9); "Grid" in "Flow" (3.4a) |
| 1.7a | Property labels: captions over the fields are off; the zoom/view menu's "Property labels" turns them on (help.figma.com 360041065034) | Captions were always shown | 🔧 | run; design-figma-parity-panels.spec | "Property labels" in the zoom menu, off by default, remembered |
| 1.7b | Inside auto layout W and H show the sizing in the field ("W 63 Hug ▾"), its menu: fixed, hug, fill, min and max | A separate row of two selects and a min/max button | 🔧 | run; design-figma-parity-panels.spec | the chip "Hug" / "Fill" (short: the field is narrow), full names ("Hug contents", "Fill container") in the menu and tooltip |
| 1.7c | Selection header names the layer's kind ("Frame ▾", "Rectangle"), components by name; the Frame dropdown switches presets (help.figma.com 360041539473) | The layer's own name | 🔧 | run; design-figma-parity-panels.spec | "Frame ▾" with the preset groups |
| 1.8 | Text selection: Typography section between Appearance and Fill | "Text" after "Appearance" | ✅ | run | — |
| 1.9 | Nothing selected: page colour, local variables, styles | "Page", "Variables", styles | ✅ | run | — |
| 1.10 | Panel resizing by dragging the panel edge | Both panels resize | ✅ | run | — |
| 1.11 | ⌘\ hides the UI; ⇧\ minimizes the panels into floating bars | Same; ⌘. too, Escape brings it back | ✅ | run | — |
| 1.12 | Rulers ⇧R; drag a guide out of a ruler; select, move and delete a guide | Same | ✅ | run; design-canvas-sweep.spec | — |
| 1.13 | Main menu: Back to files, Actions, File, Edit, View, Object, Text, Arrange, Help, Preferences | "Back to files", "Actions", File, Edit, View, Object, Text, Arrange, Help, Preferences, Theme | ✅ | run | — |
| 1.13a | Edit ▸ Select all with same fill, stroke, effect, text properties, font, instance | Only "Select matching layers" (⌥⌘A) | 🔧 | design-select-same, design-figma-parity-panels.spec | Edit ▸ "Select all with same" ▸ six kinds; styles match through the style |
| 1.14 | Canvas context menu on a layer: copy/paste group, copy as, order, group/frame, flatten/outline/mask, auto layout, component, copy/paste properties, flip, rename, hide, lock, delete | Same items and keys | ✅ | run; design-canvas-menu | — |
| 1.15 | Context menu on the empty canvas: paste here, select all, show/hide UI, rulers, zoom | Same | ✅ | run | — |
| 1.16 | Context menu on a page: rename, duplicate, copy link to page, delete | Rename, duplicate, delete; no link to the page | 🔧 | run; design-figma-parity-panels.spec | Added "Copy link to page" (the layer links' `?node=<page>`) |
| 1.17 | Actions ⌘K (search commands, assets) | "Actions" ⌘K, ⌘/, ⌘P | ✅ | design-toolbar.spec | — |
| 1.18 | Keyboard shortcuts sheet ⌃⇧? | "Keyboard shortcuts" Ctrl+Shift+/ with search | ✅ | run | — |
| 1.19 | Platform keys: mask ⌃⌘M on a Mac / Ctrl+Alt+M elsewhere; layout grids ⌃G / Ctrl+Shift+4 | Same, chosen by platform | ✅ | code; design-editor-commands (collision test on both platforms) | — |
| 1.20 | Multiplayer cursors toggle (⌥⌘\\) in View | Was missing | 🔧 | design-multiplayer.spec | Added View ▸ "Multiplayer cursors" ⌥⌘\\: hides the others' cursors, keeps their selections, remembered |

## 2. Canvas

| # | Figma | Morfa | Status | Checked | Done |
|---|---|---|---|---|---|
| 2.1 | Click selects; a click on a child of a top-level frame picks the child; groups, instances and nested frames are picked whole | Same (`liftToSelectable`) | ✅ | run; design-hit-test | — |
| 2.2 | A click on the empty area of a top-level frame or its title selects the frame; a drag from that empty area draws a marquee | Same | ✅ | run | — |
| 2.3 | ⇧-click adds and removes | Same | ✅ | run | — |
| 2.4 | ⌘-click deep select; double-click goes one level down, then into the vector editor; Escape and ⇧↵ go up; ↵ selects children; Tab / ⇧Tab siblings | Same | ✅ | run | — |
| 2.5 | ⌘A selects the siblings of the selection | Same | ✅ | run | — |
| 2.6 | Move; ⇧ locks the axis; resize by edges and corners, ⇧ keeps the ratio, ⌥ from the centre; rotate just outside a corner, ⇧ in 15° steps | Same | ✅ | run; design-canvas.spec | — |
| 2.7 | Smart guides, snapping to objects and equal spacing, red distances | Same | ✅ | design-snapping; design-devmode-canvas.spec | — |
| 2.8 | ⌥ hover shows distances to the hovered layer | Same | ✅ | design-devmode-canvas.spec ("Design" needs ⌥) | — |
| 2.7a | Frame tool (help.figma.com "Frames in Figma Design"): a click on the canvas takes the last top-level frame's size; "+" beside a frame duplicates it and moves the frames beyond over | 100 × 100 always; no "+" | 🔧 | design-frame-quick-add, design-figma-parity-panels.spec | Both; the "+" shows on hover beside the middle of a left or right side, the gap is the one to the next frame (else 100) |
| 2.8a | Edit in bulk (help.figma.com "Edit objects on the canvas in bulk"): ⇧ with an alignment button aligns each layer to its own frame; a paste into several selected frames puts a copy in each; several texts edited as one (Enter) | None of the three | 🔧 | design-align-parents, design-paste-target, design-figma-parity-panels.spec | All three; layers copied from several frames go out in the frames' order (the first frame's into the first target, round again), one frame's copy goes whole into each; "Multi-edit text" has no button, Enter does it; "Edit all variants" (Q inside a component set, the header button, Object ▸) selects the same layer in every variant, so edits reach them all (no dotted outlines around the variants) |
| 2.9 | Equal-spacing handles on a selection (drag the pink handle to change all gaps, drag a layer to swap) — "smart selection" | Not built | ✗ | code (`snapping.ts` snaps to equal gaps, no handles) | Listed (§10): about one day |
| 2.10 | Nudge ← → ↑ ↓ 1 px, ⇧ 10 px (settable); in auto layout the arrows reorder | Same; nudge steps in "Preferences" | ✅ | run; design-commands | — |
| 2.11 | ⌘ arrows resize from the right/bottom | Same | ✅ | design-canvas-sweep.spec | — |
| 2.12 | ⌥-drag duplicates; ⌘D duplicates (a top-level frame goes to its right); ⌘D after moving the copy repeats the offset | Same | ✅ | run | — |
| 2.13 | ⌥-drag, ⌘D or paste of a main component gives an **instance** (help.figma.com "Create and insert component instances") | ⌥-drag gave an instance; ⌘D and paste gave a second main component | 🔧 | run; design-main-copies | Fixed: `engine/main-copies.ts`; a variant's copy stays a variant, a cut main pastes back as the main |
| 2.14 | A drag into a frame nests the layer; Space held keeps it out | Same | ✅ | design-figma-parity.spec | — |
| 2.15 | Paste into the selected frame (offset kept when it fits, centred otherwise); paste in place ⇧⌘V; paste over ⇧⌘R | Same | ✅ | run; design-commands | — |
| 2.15a | With nothing selected, a copied frame pasted back on its place lands beside the original, never inside it | It nested inside its own original (the frame under the copy was the original) | 🔧 | run; design-paste-target | Fixed: the copied layers are left out of the search for the frame under the copy |
| 2.16 | Frame and section titles: click selects, drag moves, double-click renames | Same | ✅ | run; design-canvas-sweep.spec | — |
| 2.17 | Zoom: ⌘ / Ctrl + wheel and pinch, + and −, ⌘+ ⌘−, ⇧0 100 %, ⇧1 fit, ⇧2 selection; pan by wheel, ⇧ wheel horizontally, Space-drag, middle button, H | Same | ✅ | run | — |
| 2.18 | N / ⇧N next and previous frame | Same | ✅ | code (`view.next-frame`) | — |
| 2.19 | Pixel grid ⇧', snap to pixel grid ⇧⌘', pixel preview, outline mode ⌘Y | Same | ✅ | code; design-editor-commands | — |
| 2.20 | Drawing: ⇧ square, ⌥ from centre, a click makes 100 × 100, Space held while drawing moves the shape | Same | ✅ | run | — |
| 2.21 | Multiplayer cursors, selections, following a person from the avatars | Same | ✅ | design-multiplayer.spec | — |
| 2.22 | Opacity by number keys (1 = 10 %, 0 = 100 %) | Same | ✅ | design-canvas-sweep.spec | — |

## 3. Layout

| # | Figma | Morfa | Status | Checked | Done |
|---|---|---|---|---|---|
| 3.1 | Frame tool: presets in the right panel (phones, tablets, desktop…) | Same, current devices | ✅ | run | — |
| 3.2 | Constraints widget and selects; resizing a frame moves children by them; ⌘ while resizing ignores them | Same | ✅ | design-constraints; code | — |
| 3.3 | ⇧A adds auto layout (wraps a lone layer, turns a frame into one); ⌥⇧A removes | Same | ✅ | run; design-panels.spec | — |
| 3.4 | Flow (freeform / vertical / horizontal / grid) and wrap, gap (and Auto), padding by field (one, two or four), alignment box, clip content, strokes in layout, canvas stacking (help.figma.com 5731482952599, 31289464393751) | Same, the flow now as UI3's row in "Layout" | ✅ | run; design-panel-properties.spec, design-figma-parity-panels.spec | "Flow" with "Grid" (3.4a) |
| 3.4a | Grid auto layout (help.figma.com 31289469907863): the rows × columns picker, column and row gaps, track sizes (fixed, fill, hug), automatic or manual placement; a child's column and row span, its cell under manual placement, its alignment in the cell from the alignment row | Same; the document and both layout engines support it | ✅ | run; design-figma-parity-panels.spec (two grid cases), design-grid-panel.test | "Grid: 2 × 2" opens "Grid size"; "Row and column sizes"; "Column span", "Cell column". Gap handles on the canvas stay with 3.5 |
| 3.5 | Gap and padding by handles on the canvas | Not built on the canvas (fields only; "Code" shows them) | ✗ | code | Listed (§10): about one day |
| 3.6 | Hug / Fill / Fixed per axis; min and max | Same | ✅ | run; design-layout | — |
| 3.7 | Absolute position inside auto layout | Same (button beside X Y) | ✅ | run | — |
| 3.8 | Reorder in auto layout by dragging, with the blue insertion line | Same | ✅ | design-canvas-sweep.spec | — |
| 3.9 | Layout guides (columns, rows, grid), styles | Same | ✅ | run; design-panel-layout | — |

## 4. Properties

| # | Figma | Morfa | Status | Checked | Done |
|---|---|---|---|---|---|
| 4.1 | X Y W H fields: maths (100+20*2), ↑ ↓ and ⇧, scrub on the label, Escape leaves | Same | ✅ | run; design-ui-number | — |
| 4.2 | Percent in W/H ("50%" of the current size) | "50%" is read as 50 | ≠ | run; from memory (not found in the help centre) | Left as is |
| 4.3 | Rotation field, rotate 90°, flip H/V (⇧H ⇧V) | Same | ✅ | run | — |
| 4.4 | Corner radius in Appearance's row; Independent corners opens Corner radius details: four corners and the smoothing slider with "iOS" (help.figma.com 360050986854) | The four fields opened inline under the radius; smoothing was a field of its own | 🔧 | run; design-figma-parity-panels.spec | "Individual corners" → "Corner radius" popover |
| 4.5 | Opacity, blend modes behind the droplet in Appearance's header (Pass through for containers), the eye beside it | The blend mode was a select under a caption | 🔧 | run; design-figma-parity-panels.spec | the droplet's menu, grouped as in Figma |
| 4.6 | Fills: solid, linear/radial/angular/diamond gradients edited on the canvas, image (fill, fit, crop, tile), stacked, hidden, styles and variables | Same | ✅ | design-paint, design-paint-gradient, design-render-image | — |
| 4.7 | Colour picker (help.figma.com 360041003774, its picture): Custom / Libraries tabs, "+" to create a style, ×; fill kinds; the blend droplet; contrast check; the area, eyedropper, hue and alpha; Hex/RGB/CSS/HSL/HSB; the colours on the page | No "+", the blend mode a "Normal ▾" select, no contrast check | 🔧 | run; design-figma-parity-panels.spec, design-paint-contrast | "+" "Create color style", the droplet, "Check contrast" (ratio, AA/AAA, a click on a missed level fixes the colour). Pattern and video fills are not built |
| 4.8 | Strokes: position, weight, per side, dashes, caps, joins, miter | Same | ✅ | run; design-render-stroke | — |
| 4.8a | Remove fill ⌥/, remove stroke ⇧/, swap fill and stroke ⇧X, in the Object menu too | Only ⇧X, and in no menu | 🔧 | design-remove-paints | Object ▸ "Remove fill", "Remove stroke", "Swap fill and stroke"; styles go with the paints; locked layers keep theirs |
| 4.9 | Effects: drop and inner shadow, layer and background blur, styles | Same | ✅ | run; design-render-shadow-bytes | — |
| 4.9a | Effects: glass, noise, texture (help.figma.com 360041488473) | Not built | ✗ | code (`Effect` is shadows and blurs) | Needs the document model and the renderers (render/, crates/): listed (§10) |
| 4.10 | Masks (alpha, vector, luminance), booleans ⌥⇧U/S/I/X, flatten ⌘E, outline stroke ⌥⌘O | Same | ✅ | run; design-boolean, design-flatten, design-outline-stroke | — |
| 4.11 | Vector editing: pen, bend with ⌘, points and handles, Enter / Escape; the selected points' X and Y in the Design panel | Same; the point's X and Y were missing | 🔧 | run; design-vector-edit, design-pen, design-vector-points, design-figma-parity-panels.spec | Added "Point" / "Points" (`panels/design/layout/PointSection.tsx`) |
| 4.12 | Export settings: scale, suffix, format, preview | Same | ✅ | run; design-export-pdf.spec, design-handoff.spec | — |
| 4.12a | Export settings "…": ignore overlapping layers, include bounding box; SVG: outline text, simplify stroke (help.figma.com "Export formats and settings") | Only "Add layer ids" | ✗ | code (`ExportSetting` has `svgIdAttribute` only) | Needs `ExportSetting` fields and both exporters: listed (§10) |
| 4.13 | Selection colours | Same | ✅ | run | — |

## 5. Text

| # | Figma | Morfa | Status | Checked | Done |
|---|---|---|---|---|---|
| 5.1 | T and click: auto width; drag: fixed width; Escape selects the layer; Enter edits; double-click selects a word, triple-click the paragraph | Same | ✅ | run | — |
| 5.2 | Font family and weight pickers, size, line height and letter spacing (px / %), alignment, auto width / height / fixed / truncate with max lines | Same | ✅ | run; design-text-editor-panel | — |
| 5.2a | UI3 Typography: font, face and size, line height and spacing, alignment, then type settings; resizing in Layout beside W and H, paragraph spacing in type settings | Paragraph spacing and resizing sat in "Text" | 🔧 | help.figma.com "Explore text properties" pictures; design-figma-parity-panels.spec | Resizing (with "Max lines", since our truncate is a resize mode) in "Layout"; "Paragraph spacing" in "Text settings" |
| 5.3 | ⌘B ⌘I ⌘U ⇧⌘X, ⌥⌘L/T/R/J, ⇧⌘> <, ⌥⌘> <, ⌥> <, ⌥⇧> <, lists ⇧⌘7/8 | Same | ✅ | code; design-figma-parity.spec | — |
| 5.4 | Text styles | Same | ✅ | design-panels.spec | — |
| 5.5 | OpenType features (tabular figures, ligatures…), variable font axes | Small capitals and indent only | ✗ | code | Listed (§10): medium, needs the text engine (both sides) |
| 5.6 | Find and replace ⌘F | Same, across pages | ✅ | run; design-commands-extra.spec | — |
| 5.7 | Links in text (help.figma.com "Add links to text"): ⌘K while editing links the selected words; an address pasted over selected words links them; a caret in a link shows its card (open, edit, remove) | Only a field in "Text settings" | 🔧 | design-figma-parity-panels.spec (failed before) | "Link" opens at the caret; the card "Text link" with "Open link", "Edit link", "Remove link". A layer link of the file (⌘L) links to the layer: the card names it and has "Go to layer" |
| 5.8 | Vertical trim (cap height to baseline) and hanging punctuation and lists in "Text settings" (help.figma.com "Explore text properties") | Not built | ✗ | code (`TextStyle` has neither) | Needs the text model and both text engines: listed (§10) |

## 6. Components, styles, variables, libraries

| # | Figma | Morfa | Status | Checked | Done |
|---|---|---|---|---|---|
| 6.1 | Create component ⌥⌘K, multiple, combine as variants, add variant | Same | ✅ | run; design-components.spec | — |
| 6.2 | Properties: boolean, text, instance swap, variant; nested instances exposed | Same | ✅ | design-components.spec | — |
| 6.3 | Instances: overrides, reset, detach ⌥⌘B, swap, go to main, push to main | Same | ✅ | design-components-ui | — |
| 6.4 | Copies of a main are instances (see 2.13) | Fixed | 🔧 | design-main-copies | — |
| 6.5 | Styles: colour, text, effect, grid | Same | ✅ | design-styles | — |
| 6.5a | Libraries picker: colour styles in round swatches, colour variables in square ones | The other way round | 🔧 | help.figma.com "Apply variables to designs" | Swapped |
| 6.6 | Variables: collections, modes, aliases, binding in fields | Same | ✅ | design-variables | — |
| 6.6a | "=" in a number field opens its variable list | Only the hexagon opened it | 🔧 | help.figma.com "Apply variables to designs"; design-figma-parity-panels.spec | "=" opens the list |
| 6.6b | A boolean variable on the visibility: right-click the eye in Appearance (help.figma.com "Apply variables to designs") | No way to bind it from the panel | 🔧 | design-figma-parity-panels.spec | A right click on "Appearance"'s eye opens the variables; once bound, the hexagon shows beside it to change or detach |
| 6.6c | Variables on text: "Apply variable" for the content in Text, font family, weight and size, line height, letter spacing; ⇧-click or a right click on a number field opens the list (help.figma.com "Apply variables to designs") | Not offered in "Text"; number fields opened it only from the hexagon or "=" | 🔧 | design-figma-parity-panels.spec | The hexagon in "Text"'s header binds the content; font, face, size, line height and letter spacing open the list on a right click (⇧-click, "=" in the number fields) and show the chip once bound; every bindable number field also opens on ⇧-click and a right click |
| 6.6e | Variable scoping (which fields offer a variable) and code syntax (Web, iOS, Android names) in the variable's settings (help.figma.com "Create and manage variables") | Not built | ✗ | code (`Variable` has neither) | Needs the document model (`Variable`): listed (§10) |
| 6.6f | The variables table (help.figma.com "Guide to variables in Figma", "Create and manage variables", "Modes for variables"): "Add mode" pinned at the head's right edge, the head row and the name column fixed, "Create variable" at the foot, only the modes scroll sideways; a mode's menu (rename, duplicate, delete, move), modes dragged to reorder; column widths dragged; groups from "/" as section heads (parents greyed), folding; rows selected with ⇧ and ⌘, dragged to reorder or into a group, "New group from selection"; a row's menu (edit, duplicate, delete); Enter down a column; an alias as a pill from a cell's menu; search; full size | "Add mode" scrolled away with the modes (a designer's report at 17 modes); groups were plain labels; no row selection, drag, search or full size | 🔧 | design-variables-table.spec (failed before), design-variables-table.test | All of it; a narrow dialog (a phone) puts the collections in a strip over the table. Scoping and code syntax in "Edit variable" wait for 6.6e |
| 6.6d | Colour variables on shadow colours and gradient stops (help.figma.com "Apply variables to designs") | Not offered | ✗ | code (`ShadowEffect` and gradient stops have no variable binding) | Needs the document model: listed here, not built in this pass |
| 6.7 | Libraries: publish, use, update with overrides kept, missing | Same | ✅ | design-libraries.spec | — |

## 7. Prototype

| # | Figma | Morfa | Status | Checked | Done |
|---|---|---|---|---|---|
| 7.1 | Drag the connection handle onto a frame: On click → Navigate to, Instant | Same | ✅ | run | — |
| 7.2 | Flows and starting points; triggers incl. mouse down/up, hover, while pressing, after delay, key; actions navigate, overlay, swap, back, scroll to, URL; animations incl. smart animate | Same | ✅ | design-prototype, design-prototype.spec | — |
| 7.3 | Overlays (position, close on outside click), scrolling, fixed layers | Same | ✅ | design-prototype | — |
| 7.4 | Noodles on the canvas | Same | ✅ | design-prototype-noodle | — |
| 7.5 | Player: flows list, restart, full screen, keys | Same | ✅ | design-prototype-player.spec | — |
| 7.5a | Interaction details: the trigger heads the popover with "+" (add action) and "×"; the action with its glyph, then destination, animation, state; no group titles for one action | A "Interaction" title, titled groups, "Add action" at the bottom | 🔧 | help.figma.com "Connect your prototype" pictures; design-figma-parity-panels.spec | Laid out as Figma's; several actions keep "Action 1, 2" to tell them apart. "Reset component state" has no field in the model: not added |
| 7.5b | Interactions in bulk (several layers, the same interaction) and "Select matching interactions" in the details (help.figma.com "Connect your prototype") | One layer at a time | 🔧 | design-proto-matching, design-figma-parity-panels.spec | Several layers with the same interactions are edited together; differing ones offer "+" to replace them all; "Select matching interactions" selects the same layer (names down from its frame) with the same interaction in the other screens |
| 7.5c | Copy and paste an interaction: ⌘C / ⌘X on it, ⌘V on another layer (help.figma.com "Connect your prototype") | Not built | 🔧 | design-reaction-clipboard, design-figma-parity-panels.spec | ⌘C / ⌘X in the interaction details; ⌘V adds it to the selected layers (actions to layers the file lacks are dropped) |
| 7.5d | A text link plays in the prototype: a click on linked words opens the address in a new tab, the pointer shows it (help.figma.com "Add links to text") | Links were dead in the player | 🔧 | design-player-text-links, design-figma-parity-panels.spec (failed before) | On the linked characters' ink only; interactions on the layer come first; a link to a frame navigates to it |
| 7.6 | Set variable, conditionals, video triggers, public prototype link | Not built | ✗ | docs/design-tool.md | Listed (§10) |

## 8. Around the file

| # | Figma | Morfa | Status | Checked | Done |
|---|---|---|---|---|---|
| 8.1 | Comments: C, pin, thread, mention, resolve, list | Same | ✅ | run; design-comments.spec | — |
| 8.1a | The comment list: search, sort by date or unread, only your threads, show resolved; in the right sidebar in comment mode | No search, no unread sort; the list is in the left panel (comment mode switches to it) | 🔧 / ≠ | help.figma.com "View and manage comments"; design-comments | Search and "Unread first" added; the list stays on the left (kept: one list, the base's design) |
| 8.1b | Comment pins show on the canvas in every mode; ⇧C hides and shows them (help.figma.com "View and manage comments") | Pins showed in comment mode only | 🔧 | design-comments.spec (failed before) | As Figma: pins in every mode, View ▸ "Comments on the canvas" ⇧C; a pin clicked while designing opens comment mode with its thread |
| 8.1c | Emoji reactions on comments (help.figma.com "Guide to comments in Figma") | Not built | ✗ | code (`design_comments` has no reactions) | Needs a table and the comments API (server/design/comments.ts): listed (§10) |
| 8.2 | Version history: named versions, preview, restore | Same | ✅ | design-handoff.spec, design-figma-parity.spec | — |
| 8.3 | Dev Mode (⇧D): inspect, code, assets, measurements, annotations | "Code" | ✅ | design-code-panel.spec, design-devmode-canvas.spec | — |
| 8.4 | Import from Figma | Same (mocked API only) | ✅ | design-figma-import | — |
| 8.5 | Export, copy as PNG / SVG / CSS / text / link | Same | ✅ | design-handoff.spec | — |
| 8.6 | Copy and paste between files, copy/paste properties ⌥⌘C / ⌥⌘V | Same | ✅ | design-commands-extra.spec | — |
| 8.7 | Undo and redo ⌘Z ⇧⌘Z, one step per gesture | Same | ✅ | design-canvas-sweep.spec | — |
| 8.8 | "Set as thumbnail" on a frame: the file card shows that frame (help.figma.com "Set a thumbnail for a file") | Not built: the card shows the first page | ✗ | code (`thumbnails.ts` and the editor's scheduler draw the first page) | Needs a file field and both thumbnail makers: listed (§10) |

## 9. What this pass changed

| Row | Commit subject | What a Figma user notices |
|---|---|---|
| 2.13, 6.4 | `fix(editor): copy a main component as an instance` | ⌘D and paste of a main give instances, as ⌥-drag did (`engine/main-copies.ts`) |
| 2.15a | `fix(editor): never paste a copy into its original` | a frame copied and pasted with nothing selected no longer nests inside itself |
| 1.7 | `feat(panels): group properties as figma ui3 does` | "Position" (X, Y, rotation, constraints), "Layout" (W, H, sizing, min/max, clipping), "Appearance" (blend, opacity, corner radius) |
| 1.16 | `feat(pages): copy the link to a page from its menu` | the page menu's "Copy link to page" |
| 1.20 | `feat(editor): toggle the other people's cursors` | View ▸ "Multiplayer cursors" ⌥⌘\ |
| 4.11 | `feat(panels): show the selected points while editing` | "Point" X and Y in the vector editor |
| 1.7b | `feat(panels): hug and fill inside the w and h fields` | "W 400 Hug ▾": the sizing and min/max in a chip inside the field |
| 1.7c | `feat(panels): head the panel with the layer's kind` | the header reads "Rectangle", "Frame ▾" with the presets |
| 4.7 | `feat(panels): figma's colour picker header and blend droplet` | "+" and the droplet in the picker |
| 4.7 | `feat(panels): check a colour's contrast in the picker` | "Check contrast" |
| 3.3 | `feat(editor): suggest auto layout for a whole frame` | ⌃⇧A lays out a whole frame |
| 3.3 | `feat(editor): remove all auto layout in a selection` | Object ▸ "Remove all auto layout" |
| 7.x | `feat(prototype)…` (in the status commit) and `fix(prototype): restore the flows list in the panel` | "Prototype settings" first, then "Flows" |
| 2.7a | `feat(editor): a frame-tool click takes the last top-level frame's size`, `feat(editor): the frame tool's quick-add "+"` | as the row says |
| 2.8a | `feat(components): multi-edit variants` | as the row says |
| 2.8a | `feat(editor): spread a paste from several frames over several frames` | as the row says |
| 2.8a | `feat(editor): edit in bulk — align to each frame, paste into each frame, several texts as one` | as the row says |
| 6.6c | `feat(panels): variables on text, and ⇧-click or right click to apply one` | as the row says |
| 6.6b | `feat(panels): bind visibility to a variable from the eye` | as the row says |
| 7.5c | `feat(prototype): copy and paste an interaction` | as the row says |
| 7.5b | `feat(prototype): interactions in bulk and select matching` | as the row says |
| 1.2d | `feat(editor): keyboard box selection` | as the row says |
| 1.2c | `feat(editor): f6 moves the focus between the regions` | as the row says |
| 8.1b | `feat(comments): pins on the canvas in every mode, ⇧c hides them` | as the row says |
| 1.2b | `feat(editor): place a shape with enter` | as the row says |
| 1.2a | `feat(editor): pan the canvas with the arrows` | as the row says |
| 1.5c | `feat(pages): page dividers` | a line in the pages list |
| 1.13a | `feat(editor): select all with the same fill, stroke, effects, text, font or main` | Edit ▸ "Select all with same" |
| 1.5b | `feat(layers): rename several layers at once` | "Rename layers" |
| 1.5a | `feat(pages): fold the pages section` | "› Pages · Page 1" |
| §10.5 | `feat(editor): the shape builder` | "Shape builder" |
| 6.6f | `feat(variables): the variables table as figma's` | "Add mode" pinned, fixed head and names, groups, selection, drag, search, full size |
| 4.8a | `feat(editor): remove the fill or the stroke` | ⌥/ and ⇧/, Object ▸ "Remove fill" |
| 5.7, 7.5d | `feat(text): link words to a layer of the file` | a pasted ⌘L link, "Go to layer", the player goes to the frame |
| 7.5d | `feat(prototype): open text links in the player` | a click on linked words opens them |
| 5.7 | `feat(text): links with ⌘K, a pasted address and the link card` | "Link" at the caret, the link card |
| 3.4a | `feat(panels): grid auto layout` | "Grid" in "Flow": the size picker, gaps, track sizes, placement; a child's span and cell |
| 5.2a, 6.5a, 6.6a, 7.5a, 8.1a | `feat(design): UI3 interaction details, "=" for variables, comment search, text resizing in Layout` | as the rows say |
| 1.3 | `feat(editor): add figma's left navigation bar` | the views as a labelled rail along the left edge |
| 1.7, 1.7a, 3.4, 4.4, 4.5 | `feat(panels): lay out the design panel as ui3` | captions off until "Property labels"; the alignment row in "Position"; "Flow" and auto layout in "Layout"; "Appearance" with the droplet, one row, "Corner radius" |

Tests: `tests/design-main-copies.test.ts`, `tests/design-paste-target.test.ts`, `tests/design-vector-points.test.ts`, the
page-link case in `tests/design-commands-extra.test.ts`, the cursors case in `tests/design-editor-commands.test.ts` and
`tests/design-editor-session.test.ts`, `tests/e2e/design-figma-parity-panels.spec.ts`, the ⌥⌘\ step in
`tests/e2e/design-multiplayer.spec.ts`. Each failed before its change.

## 10. Missing, ranked (not started)

Ranked by how soon a designer from Figma meets them. Sizes are rough.

1. Equal-spacing handles on a selection ("smart selection", 2.9) — about one day: a handle model in the move tool, the
   overlay, tests; no document change.
2. Gap and padding handles on the canvas for auto layout (3.5) — about one day: the move tool and the overlay.
3. Done: Figma's grid auto layout flow — the model and both engines, then the panel (3.4a).
4. Done in this pass: "Remove all auto layout" (Object ▸ "Remove all auto layout") and "Suggest auto layout" (⌃⇧A,
   Object ▸ "Suggest auto layout": rows and columns wrapped, nested frames first).
5a. Done in this pass: the colour picker's contrast check (WCAG AA/AAA against the colour behind, a click fixes it).
5. Done in this pass: the shape builder ("Shape builder", help.figma.com 31616004109847): from the boolean menu and
   Object ▸ Boolean operations; a click extracts a region, a drag merges, ⌥ takes away; curves stay curves. Figma opens it
   from vector edit mode on several layers; Morfa's vector editor edits one layer, so it opens from the selection.
6. OpenType features and variable axes (5.5) — several days: the text engine on both sides (TypeScript and Rust), the
   schema stays.
7. Prototype variables and conditions, video, public prototype link (7.6) — large: the player, the document, the server.
8. Glass, noise and texture effects (4.9a) — several days: the document model (`Effect`), both renderers and export; outside this
   pass's files.
9. Variable scoping and code syntax (6.6e) — about a day once `Variable` carries `scopes` and `codeSyntax` (the document
   model): the variable settings dialog, the pickers filtered by scope, "Code" using the Web name.
10. Vertical trim, hanging punctuation and hanging lists (5.8) — several days: `TextStyle`, the text layout on both sides,
   then three controls in "Text settings".
11. Emoji reactions on comments (8.1c) — about a day: a table, the comments API and the thread card.
12. "Set as thumbnail" (8.8) — about a day: a file field, the editor's thumbnail scheduler and the server's thumbnails.
13. Export options (4.12a) — about a day: four `ExportSetting` fields, the exporters on both sides, the "…" menu.

## 11. Figma has it, Morfa does not build it at all

Plugins and widgets, Figma Slides, Figma Sites, Figma Make, Figma Buzz, Figma Draw's full set beyond the pencil, brush and
lasso Morfa has, FigJam inside Design files (Morfa's board is its own file kind, `docs/figjam-parity.md`), Code Connect, branching and
merging, Dev Mode's "Ready for dev" and "Compare changes", iOS and Android code.
