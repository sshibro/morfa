# Morfa motion audit — 2026-10-07

Every animated or transitioned thing in the design area (`src/design/**`, mostly `src/design/styles/*.css` and the
components that drive motion), reviewed against two sets of motion rules: the first asks whether a thing should
animate at all (purpose, easing, duration, origin, exits, interruptibility, performance); the second covers press scale,
icon swaps, image outlines, motion restraint and the theme switch. Where a rule's value conflicts with the design tokens
(`src/design/styles/tokens.css`) or `src/motion/presets.ts`, the tokens win: `--dz-ease-out` (0.22, 1, 0.36, 1) for
enters and exits, `--dz-ease-press` (0.2, 0, 0, 1) for presses and state, 120–160 ms for menus and panels. The rules
fill the gaps: dialogs 200 ms (new `--dz-modal`), icon swaps 300 ms, wide strips 0.985.

Severity: **HIGH** breaks an interaction or leaves a state visible only while motion runs;
**MEDIUM** is a visible inconsistency in motion or surfaces; **LOW** is isolated polish. One row per root cause.


## How it was checked

In the real app (the e2e server, headless Chromium, 1440 × 900 and 1280 × 800, light and dark): a recorder on the CDP
`Animation` domain listed every CSS transition, CSS animation and WAAPI animation each interaction started, with the
element, property, duration and curve. Surfaces were replayed at 10 % speed (`Animation.setPlaybackRate` 0.1) and their
first frames measured; presses were held with the mouse button down and the element's box measured; reduced motion
(`emulateMedia({reducedMotion: 'reduce'})`), a theme flip from the menu and from the system, and a 4× CPU throttle were
run on the same paths. Lasting checks: `tests/e2e/design-motion.spec.ts`.

What the recorder showed before the fixes, per interaction: 9 tool keys started 32 transitions on the toolbar; drawing,
dragging, undo, zoom and select-all on the canvas started 16 (toolbar and align buttons); a menu opened with Enter
scaled in like a clicked one; a held comment pin 900 px from the canvas corner moved 28 px up and 24 px left. After:
0, 0, 0 and 0 px. Layer rows (hover sweep, click, arrows, caret, drag), find, quick actions, rulers, hide UI and both
theme flips started 0 before and after.

## Inventory

Frequency is Emil's scale: **100+/day** no animation; **tens/day** remove or drastically reduce; **occasional**
standard; **rare** may delight. "Keyboard: none" means the surface appears at once when the keyboard opened it (the
root's `data-input`, `src/design/ui/layer.tsx`).

| Surface | Motion now | Frequency | Location |
| --- | --- | --- | --- |
| Menus (main menu, context menus, selects and dropdowns, toolbar flyouts) | Opacity and scale 0.97 → 1, 120 ms ease-out, origin at the trigger (or the pointer); keyboard: none; submenus none; exit instant | tens/day | `styles/overlays.css:35-42`, `ui/Menu.tsx` |
| Tooltips | 500 ms delay, opacity and scale 0.97, 125 ms ease-out, origin at the anchor; a neighbour within 600 ms and keyboard focus: instant | tens/day | `overlays.css:86-101`, `ui/Tooltip.tsx` |
| Popovers (colour picker, gradient stops, font picker, styles, rename, "New file ▾" gallery, export settings) | Opacity and scale 0.97, 160 ms ease-out, origin at the anchor; keyboard: none; exit instant | occasional | `overlays.css:111-121`, `ui/Popover.tsx`, `ui/ColorPicker.tsx` |
| Dialogs (all, through `ui/Dialog.tsx`) and their dimmer | Opacity and scale 0.96, 200 ms ease-out, centred; keyboard: none; exit instant | occasional | `overlays.css:124-145` |
| Toasts | In: opacity and 8 px up, 160 ms ease-out. Out: opacity and 4 px down, 120 ms ease-out | occasional | `overlays.css:183-207`, `ui/Toast.tsx` |
| Comment card | Opacity and scale 0.97 from its pin's side, 160 ms ease-out; keyboard: none | occasional | `comments.css:81-101` |
| Comment pins, clusters | Follow the canvas with no motion; hover shadow 120 ms; press 0.96 | tens/day in comment mode | `comments.css:15-36` |
| Mention list | None (it opens while typing) | 100+/day | `comments.css:212` |
| Presence avatars | Arrive: opacity 160 ms ease-out, scale 0.96 → 1 120 ms; press 0.96; follow ring 120 ms | rare | `live.css:15-46` |
| Remote cursors | A per-frame exponential glide in JS (≈ 90 % in 120 ms), transform only; show and hide fade 120 ms; reduced motion snaps | continuous | `realtime/PresenceUI.tsx:158-265`, `live.css:91-99` |
| Version history panel, "Save version" form, preview, banner | Opacity with an 8 / 4 px shift, 160 ms ease-out (preview: opacity 120 ms); keyboard: none | rare | `versions.css:8-19`, `:155-164`, `:197-204`, `:222-237`, `:267` |
| "Saving stopped" banner | Opacity and 6 px, 160 ms, once | rare | `save-guard.css` |
| Save state ("Saved" / "Saving…") | Text swap, no motion | 100+/day | `editor/chrome/FileTitle.tsx` |
| Toolbar tools, flyout chevrons, the modes segment (Draw / Design / Prototype / Code), "Actions" lit while open | None | 100+/day | `controls.css:61-77`, `editor.css` (Floating toolbar) |
| "Actions" (⌘K, Figma's Actions menu) | From its button: opacity and scale 0.97 → 1, 150 ms ease-out, origin at the button; ⌘K / ⌘/ / ⌘P: none; reduced motion: opacity only; exit instant; steps aside (opacity 120 ms) while an asset is dragged out | tens–100+/day | `styles/actions.css`, `editor/ActionsMenu.tsx` |
| Icon buttons (panels, headers, the player bar, dialogs) | None | 100+/day | `controls.css:61-77` |
| Panel tabs, segmented controls | None | tens–100+/day | `controls.css:157-220` |
| Text buttons | Colour 120 ms; press 0.96 (wide strips 0.985) | occasional | `controls.css:13-48` |
| Fields (hover, focus ring) | Box-shadow and background 120 ms | tens/day | `controls.css:80-101` |
| Checkboxes, switches | Fill 120 ms, thumb slide 120 ms, only under the pointer that flips them | tens/day | `controls.css:232-271` |
| Section and disclosure chevrons | Rotate 120 ms (pointer); keyboard: none | tens/day | `controls.css:418-420`, `panel-layout.css:407-409` |
| Layer rows, page rows (hover, select, expand, drag, drop line) | None | 100+/day | `panel-left.css` |
| Paint rows while one is dragged | The others slide 160 ms ease-in-out (0.77, 0, 0.175, 1); the dragged row follows the pointer; reduced motion: none | occasional | `panel-paint.css:26`, `:178` |
| Hover reveals (row grips, "…", variable hexagon, remove buttons) | Opacity 120 ms | tens/day | `panel-paint.css`, `panel-layout.css:109-121`, `files.css:177-186`, `prototype.css` |
| Asset tiles, templates, swatches, library chip, composer send, variant "+", prototype handle | Press 0.96, 120 ms | occasional | various |
| Prototype handle hover | Scale 1.15, fine pointer only | occasional | `prototype.css:133-157` |
| Easing preview dot | WAAPI with the designer's own curve and duration; none under reduced motion | occasional | `prototype/EasingCurve.tsx` |
| Player chrome | Device fades in 200 ms once fonts and pictures are in; frame transitions are the designer's (engine) and untouched | occasional | `prototype.css:200-206` |
| File browser | Skeleton pulse 1.6 s, 60 ms stagger; a picture fades in 160 ms once it arrives; card hover outline and "…" 120 ms; drop zone 120 ms | occasional | `files.css` |
| Template pictures | Fade in 160 ms once painted | occasional | `templates.css:68-75` |
| Copy tick, Figma import steps | Icon swap: scale 0.25 → 1, opacity, blur 4 px → 0, 300 ms (0.2, 0, 0, 1) | occasional | `panel-code.css:157-168`, `figma-import.css:88-91` |
| Figma import progress | Fill scale-x 200 ms ease-out | rare | `figma-import.css:97-104` |
| Spinners | 0.7 s linear turn; static under reduced motion (the app's global rule) | — | `controls.css:346`, `src/styles/motion.css:52` |
| Theme flip (menu or system) | Transitions off for one frame (`.dz-theme-swap`); recorded: 0 transitions on both paths | rare | `ui/layer.tsx:24-33`, `base.css:126-129` |

## Findings and what was applied

### Transforms compose about the element (popover origin, press feedback)

| Severity | Location | Before | After | Why |
| --- | --- | --- | --- | --- |
| HIGH (fixed) | `src/design/comments/ui/CommentsLayer.tsx:87`, `:93`, `:104`; `src/design/panels/design/components/ComponentCanvasOverlay.tsx:48` | Pins, the draft pin, the thread card and the variant set's "+" placed with `style.transform = translate(x, y)` and pressed / scaled in with the `scale` property | `style.translate = 'x y'` | `scale` applies after `transform`, so it scaled the offset too: a pin 900 px from the canvas corner jumped 28 × 24 px on press, a slow click released off it and the thread did not open, and the card slid in from the corner instead of growing from its pin. Now 0 px drift (pins and "+" measured). |

### Should it animate at all (keyboard, 100+/day)

| Severity | Location | Before | After | Why |
| --- | --- | --- | --- | --- |
| MEDIUM (fixed) | `src/design/styles/controls.css:61-77`; `src/design/styles/editor.css:154-166` | Icon buttons and toolbar chevrons faded background and colour 120 ms: every tool key (32 transitions for 9 keys) and every selection change (align buttons) replayed it | No transition: instant | Rule: 100+/day and keyboard-initiated get no animation; instant feedback first for high-frequency controls |
| MEDIUM (fixed) | `src/design/ui/layer.tsx:34-50`; `styles/overlays.css:41-42`, `:121`, `:144-145`; `comments.css:101`; `versions.css:267`; `controls.css:420`; `panel-layout.css:409` | A menu opened with Enter, arrows or the context-menu key, a popover opened with Enter, a dialog from its shortcut, version history from ⌥⌘S, the thread card that replaces the draft after Enter, chevrons toggled with Enter: all ran their pointer entrance | The root records the last input (`data-input="keyboard" \| "pointer"`); under `keyboard` these have `transition: none`; the pointer keeps the origin-aware entrances | Rule: never animate keyboard-initiated actions |
| LOW (fixed) | `controls.css:157-220` | Tabs and segments crossfaded 120 ms on every switch, by click, Alt+1/2 or arrows, and segments re-faded when another layer was selected | Instant | Rule: every tab switch in a work tool is high-frequency |
| LOW (fixed) | `controls.css:232-271` | Checkbox fill and switch thumb animated also when Space or a new selection flipped them | They fade and slide only under the hovering fine pointer that flips them | Keyboard and canvas-driven state changes at once |
| LOW (kept) | `controls.css:80-101`, `versions.css:166-180`, `comments.css:156-168` | A field's focus ring fades 120 ms, also when Tab moves focus | — | Colour-only and ≤ 150 ms, within the allowance for high-frequency state; listed for a later call |

### Exits

| Severity | Location | Before | After | Why |
| --- | --- | --- | --- | --- |
| MEDIUM (fixed) | `src/design/ui/Toast.tsx:24-29`; `styles/overlays.css:199-207` | A toast left the DOM in one frame, on its timer or on × | `.is-leaving`: opacity 0 and 4 px down, 120 ms ease-out, then removed; reduced motion fades only | Rule: a toast leaves the way it came; exits softer and faster than enters (in 160 ms / 8 px, out 120 ms / 4 px) |
| LOW (kept) | `src/design/ui/Toast.tsx` | A removed toast lets the ones above it drop with no motion | — | Rare (three toasts at most); a FLIP of the stack is not worth its code yet |

### Durations and curves

| Severity | Location | Before | After | Why |
| --- | --- | --- | --- | --- |
| LOW (fixed) | `styles/overlays.css:135`, `:140`; `tokens.css:88` | Dialog and dimmer 160 ms (`--dz-base`), `transform: scale(0.96)` | 200 ms (`--dz-modal`), the `scale` property like every other surface | Rule: modals 200 ms and up; the tokens only fix menus and panels |
| LOW (fixed) | `panel-code.css:162`; `figma-import.css:89`, `:144` | Contextual icon swaps at 160 ms and 200 ms | 300 ms on (0.2, 0, 0, 1), scale 0.25 → 1, opacity, blur 4 px → 0 | The standard icon-swap values |
| LOW (fixed) | `live.css:33` | An arriving avatar's fade ran on the press curve at 120 ms (its comment said 160 ms) | Opacity 160 ms ease-out, scale 120 ms press curve | Enters ease out |

### Press feedback and hover

| Severity | Location | Before | After | Why |
| --- | --- | --- | --- | --- |
| LOW (fixed) | `panel-layout.css:390`; `panel-paint.css:146`; `teams.css:32`; `panel-components.css:201` | Full-width strips (export 208 px, "Open variables" 215 px, "Create team" 223 px, the variables picker's foot) pressed to 0.96 | 0.985 | Wide strips give less (the app's `--press-wide`): 4 % of 220 px is a lurch |
| LOW (fixed) | `prototype.css:153` | The handle's hover growth (scale 1.15) gated by `(hover: hover)` only | `(hover: hover) and (pointer: fine)` | Hover motion only for a real pointer; colour-only hovers stay under `(hover: hover)` |

### Loading and surfaces

| Severity | Location | Before | After | Why |
| --- | --- | --- | --- | --- |
| LOW (fixed) | `files.css:136-138`; `files/FileGrid.tsx:135-145` | A lazy thumbnail popped in when it arrived | Fades in 160 ms ease-out once loaded; one already cached is marked before the first paint and shows at once | No jarring changes; same as the templates gallery |
| LOW (fixed) | `panel-layout.css:452` | Export dialog thumbnails: the box's inset ring painted under the picture and vanished where it filled the box | 1 px outline on the picture (`--dz-outline`: oklch(0 0 0 / 0.1), dark oklch(1 0 0 / 0.1)) | The image-outline rule |
| LOW (reported) | `editor/chrome/FileTitle.tsx:23` | "Saving…" and "Saved" swap on every edit | Show "Saving…" only when a save takes longer than a moment | Not motion: a status that flickers on every keystroke draws the eye like one |
| LOW (reported) | `src/styles/motion.css:52` (the app's global rule) | Spinners stop under reduced motion | An opacity pulse, or keep them still | Every spinner carries a label, so state is not lost; app-wide rule, outside this area |

### What was already right

Origin-aware menus, tooltips and popovers (`ui/position.ts` computes the origin at the anchor); instant submenus and
warm tooltips; dialogs centred; no `transition: all` anywhere; only transform, opacity and colours animate; layer rows,
pages and canvas work never animate; cursors glide in JS on frames instead of a CSS lag; the theme flip suppresses
transitions for one frame on both the menu and the system path; reduced motion keeps fades (the app's global rule plus
per-surface overrides); concentric radii on menus (12 / 8), the toolbar (12 / 8), the version banner and the composer;
shadows for elevation and borders for structure; 1 px neutral outlines on thumbnails, swatches and template pictures;
1.5 px icon strokes beside 450-weight text.

## Verdict

**Approve.** The one HIGH is fixed and covered by `tests/e2e/design-motion.spec.ts`; the LOW rows marked "kept" or
"reported" are work to schedule.

## Not verified

- Safari and Firefox: only Chromium (Playwright's build) was driven.
- Touch and hybrid devices (`pointer: coarse` with hover): the gating was checked by reading, not on a device.
- Frame pacing on a 120 Hz display; a 4× CPU throttle was run (a menu still opens with its compositor fade).
- Gradient stop handles, the mention list, the font picker's rows, pages and assets drags, the paint-row reorder slide,
  the drop zone, the "Saving stopped" banner and the follow pill: code read (no motion beyond what is listed),
  not replayed. Layer rows, the colour picker, menus, dialogs, toasts, tooltips, comments, presence, version history and
  the file browser were replayed.
- The prototype player's frame transitions: they are the designer's and were not changed; only its chrome was checked.
