# Admin console design system

The admin console (`#admin`, `src/admin/*`) is built from the primitives below and the `--mfa-*` tokens in `src/admin/admin.css`.
Do not add new colours, radii, shadows or one-off SVGs; name a role (`var(--mfa-text-2)`), never a hex. Every token is defined on `.mfa`
for light and dark (`AdminRoot` sets `data-theme` from the app's theme).

## The hierarchy rules

1. **One focal element per screen.** Answer "what needs me now?" first: the support inbox, a row of lead numbers (`Kpi` with `hero`),
   or the table. Everything else comes after it and is quieter.
2. **One accent.** The brand indigo (`--mfa-brand`) marks the current rail item, the selected segment and the primary action. Other
   actions are outline or ghost buttons. Do not use the accent in running text on white except links (`--mfa-link`).
3. **Warnings sit on the block.** A problem goes on the `Section` it concerns (`alert={{tone, text}}`), in a table row, or on the
   value. Never put a banner above the page.
4. **Numbers before words.** Show a count, sum or date, not a sentence about it: "2 waiting · 1 closed", not "You have two
   conversations without an answer".
5. **Caveats behind "?".** How something is counted, retention, limits: a `Section` or `Kpi` hint, or an `InfoTip`. Never a paragraph
   under a title, and never a subtitle repeated in the text.

A missing value says "No data" (or "—" in a table), never 0. Never describe a feature as working when its integration is off.

## Layout

- Frame: a dark rail (Overview, Support, Accounts, Usage) and a white workspace inside a dark frame. Content max width is 1320 px.
  The side gutter is `clamp(20px, 3.2vw, 44px)`.
- Top bar: context only (the period switch for the sections that take one, `PERIOD_SECTIONS` in `route.ts`: overview and usage;
  refresh; the way back on a detail route). The page title is never in the top bar.
- Page: `.mfa-page` is a flex column with a 36 px gap. Order: `PageHead` → the focal element → `Section`s.
- Sections are split by a hairline (`--mfa-line`). Side by side: `Section span={3..12}` on the 12-column grid; spans collapse at
  1180 px and 760 px.
- Radii: controls and pills 999 px; cards 20 px; hover wells 12 px.
- Phones (up to 760 px): the rail is replaced by a strip on top and a tab bar at the bottom, tables become cards and number rows
  show two per row.

## Type

Inter for everything (`--mfa-font`); Wix Madefor Display for page titles and hero numbers (`--mfa-display`); ids and codes in monospace
(`--mfa-mono`). Figures are tabular only where numbers line up (tables, KPI values). No uppercase eyebrows.

## Colour roles

| Role | Tokens |
| --- | --- |
| Surfaces | `--mfa-frame`, `--mfa-bg`, `--mfa-raised`, `--mfa-fog`, `--mfa-hover`, `--mfa-band`; hairlines `--mfa-line` / `--mfa-line-strong` |
| Text | `--mfa-text`, `--mfa-text-2` (secondary), `--mfa-text-3` (hints), `--mfa-link` |
| Accent | `--mfa-brand`, `--mfa-brand-hover`, `--mfa-brand-soft` (a selection on white) |
| Status | `--mfa-good-*`, `--mfa-bad-*`, `--mfa-warn-*`, `--mfa-info-*` (text and soft fill); dots use `--mfa-status-*` |
| Charts | categorical `--mfa-viz-1…8` (+ `--mfa-viz-other`), sequential `--mfa-seq-0…6`, ordinal `--mfa-ord-0…4` (`src/admin/palette.ts`) |

No gradients and no glow. Depth is `--mfa-shadow-card` (cards), `--mfa-shadow-lift` (hover) and `--mfa-shadow-float` (popovers).

## Primitives (`src/admin/ui.tsx`, charts in `src/admin/charts/`)

- **PageHead**: the only title on the screen: `title`, `fact` (one line, numbers in `<b>`), `leading` (an `Avatar`), `actions`.
- **Section**: a flat block under a hairline: `title`, `count`, `hint` (a caveat behind "?"), `aside` (a link or one small button),
  `alert={{tone, text}}`, `span`.
- **Kpi / KpiSkeleton**: a number that leads: label, value, the change against the previous window (`DeltaPill`), a sparkline or other
  `visual`, `foot` (one short fact), `href` (opens the list behind the number), `hero`, `tone="danger" | "warn"`.
- **InfoTip**: a "?" that opens one short paragraph on hover, focus or tap.
- **Avatar / SegmentPill / Chip / CopyId**: who a row is about (initials on a tint chosen by the id), an account's segment, a small
  label, an id in monospace with a copy button.
- **SearchBox**: a search field that writes to the address after a short pause.
- **Empty / Failure**: an empty state (one line, maybe one action) and the server's message with a retry and the HTTP status and
  request id. There is no box around them.
- **Charts**: `AreaLine`, `Bars`, `HBars`, `Funnel`, `Heatmap`, `CohortGrid`, `Meter` / `Gauge`, `Sparkline`. They take colours from the
  palette, never animate, and carry an `aria-label`.

## Motion

Rail navigation, tab switches, segment filters and row hover have no animation beyond a short colour change. Everything honours
`prefers-reduced-motion`; charts do not animate.

## Do and don't

| Do | Don't |
| --- | --- |
| `<Section title="Support" alert={{tone: 'danger', text: 'Reply not sent'}}>` | A yellow banner above the page |
| `<b>3</b> unanswered` in the PageHead fact | "Note: you have three unanswered conversations" |
| One accent button, on the primary action | The accent on every row's button |
| Hairline sections on white | Cards inside cards, a box around a table |
| `hint="How it is calculated…"` | A grey paragraph under every title |

## Checking a screen

Open `#admin/<section>` at desktop width and at 360 px, in light and dark, and look at both. Ask:

1. Can you tell in two seconds what needs you?
2. Is there at most one accent action?
3. Is there any paragraph that should be a number or a "?"?
4. Does a warning sit on its block?
5. Does it work at 360 px?
