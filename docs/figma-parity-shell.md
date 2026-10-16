# Figma parity: the file browser and its dialogs

2026-10-09. One row per thing Figma's file browser and its dialogs do, with what Morfa
does: **same**, **differs** or **missing**. The reference is Figma's own pictures in its help centre, looked at on 2026-10-10: [FB] "Guide to the file browser" (help.figma.com/hc/en-us/articles/14381406380183),
[TOUR] "Tour the file browser and customize your profile" (…/30926159906967), [SEARCH] "Search for files, folders, and
people" (…/4422774037271), [TRASH] "Delete and restore files" (…/360047512294), [SHARE] "Share files and prototypes"
(…/360040531773), [MOVE] "Move a file" (…/360038511573), [STAR] "Star your favorite files and folders" (…/360038511513).
A row without a source is still "from memory". "Fixed" marks what this pass changed; a
missing thing that takes more than half a day carries a size and stays for later. Morfa keeps its own marks, tokens and
wording.

## The sidebar
| Figma | Morfa | State |
|---|---|---|
| Account at the top: avatar, name, chevron, a bell on the right; its menu: theme, settings, log out [FB, TOUR] | `files/AccountMenu.tsx`: avatar initial, name, chevron; menu: "Theme", "Sign out" (and "Admin console" for an operator); Morfa's lockup sits above it | same — **fixed** (was a "Sign out" button and a separate theme icon); no bell |
| The place shown now: a full-width light-blue row [FB, TOUR, TRASH] | the selection's blue tint (`--dz-selected-row`), medium weight — **fixed** (was grey and bold) | same |
| The page's title at the top of the main column in a bar with a rule under it; the ways to make a file at its right ("Create new", "Share") [TOUR, TRASH] | the title heads the top bar; "Import", "New board", "New file" at its right; filters, sort and view in the row under it — **fixed** (the title was under the bar, the search in it) | same |
| Recents: "Recently viewed", the files opened lately from every team, shared ones too [FB] | "Recently viewed" first in the sidebar: the files this browser opened (`files/viewed.ts`), from the personal files, "Shared with me" and every team (their existing list reads), the last opened first, at most 50 — **fixed** (slice 10) | same, but per browser, not per account (an "opened at" on the server: **1 day**) |
| Drafts (personal files) | the same list as "Recent" | differs (see the row above; with an "opened at" list, today's "Recent" becomes "Drafts") |
| Shared with me / Shared files | "Shared with me" | same |
| Teams with their projects, "+" for a project, a team menu | team sections with "New project" and "⋯" (`teams/TeamWorkspace.tsx`) | same |
| "Starred": "Add to your favorites" in a file's menu or a star on hover; starred files and folders in the sidebar's "Starred", seen only by you [STAR] | "Add to favorites" / "Remove from favorites" in a file's menu, "Add project to favorites" in a project's; the sidebar's "Favorites" lists them and opens them (SQL018, `server/design/favourites.ts`, `files/useFavourites.ts`, `files/Starred.tsx`) — **fixed** (slice 7) and a star on the card's hover (yellow while starred), a card dragged onto "Favorites" is starred (the section shows as a place to drop while a card is dragged) — **fixed** (slice 14) | same |
| Trash (per team too) | "Trash", a team's "Trash" | same |
| The search field in the sidebar under the account, full width, "Search for anything" [FB, TOUR]; results with tabs Files / Projects / People, filters and sort [SEARCH] | the field sits in the sidebar under the account (on a phone in the top bar); it filters the current view's files by name, and the projects of every team the caller is in whose name or team matches show above them and open with a click (`files/search.ts`) — **fixed** (slices 2 and 11) | place same; scope differs: files of other views and people are not searched (a server search: **1–2 days**) |
| Create a team | "Create team…", and in the space switcher | same |

## The files
| Figma | Morfa | State |
|---|---|---|
| Grid and list views; the list with a large picture (about 112 px), the name in 13 px, rows about 88 px apart, quiet headings without a rule [FB, measured at about 2.6×] | "Grid" / "List", remembered per browser; the list's picture 112 × 70, the name 13 px, rows 84 px, headings without a rule (sortable by a click) — **fixed** (slice 12; the list had 48 px pictures and 48 px rows) | same |
| Sort: last viewed, last modified, alphabetical, date created; in the trash "Date trashed" [TRASH] | "Last modified", "Last viewed" (opened in this browser), "Name", "Created"; in the trash "Deleted"; a list heading sorts by its column — **fixed** (slice 6) | same; "last viewed" is per browser, not per account (an "opened at" on the server: **1 day**) |
| Filter by kind "All files", beside the sort and the grid/list switch, right-aligned [SEARCH, TRASH] | "File type": "All files", "Design", "Boards", remembered per browser, in the same place | same — **fixed** (was missing) |
| The card: picture, then the kind's coloured mark beside the name and "Edited …" [TOUR] | the kind's 24 px mark (blue for a design, purple for a board) beside the name and "Modified …" — **fixed**; a board keeps its "Board" pill in the picture | same |
| Thumbnails | server thumbnails, a mark for a board, unread comments in the corner | same |
| "Edited 5 minutes ago" under the name | "Modified 5 min ago", live | same |
| File kinds told apart | a board's card carries "Board" in its picture | same |
| Empty and loading states | skeleton cards; empty views with their actions | same |

## A file card
| Figma | Morfa | State |
|---|---|---|
| A click selects the file, ⌘/Ctrl-click adds to the selection, a double click opens [MOVE: "Hold Command (Mac) or Control (PC) while selecting multiple files"] | a click selects, a double click or Enter opens; on a touch screen a tap opens | same (question closed 2026-10-10: Figma selects on a click too) |
| Open in new tab | "Open in new tab", ⌘-click, middle click | same |
| Rename in place | "Rename", F2 | same |
| Duplicate | "Duplicate" | same |
| Move to a project / team | "Move" (projects, "No project", "To personal files"), "Move to team" | same |
| Copy link | "Copy link" | same — **fixed** (was only in the editor) |
| Share from the card | "Share…" opens the editor's share dialog | same — **fixed** (was only in the editor) |
| Delete, restore, delete forever | "Move to trash" (with "Undo"), "Restore", "Delete permanently" with a confirmation | same |
| Right click and "⋯" show the same menu: Open, Open in new tab · Copy link, Share, Duplicate · Rename, Move file…, Move to trash [TRASH, the menu picture] | the same items from both, in that order (and "Save to computer (.rdesign)") — **fixed** order (sharing was after opening, duplicate after rename) | same; Figma has no icons in this menu, Morfa's menus keep theirs (one menu for the whole tool) |
| Several files selected with ⌘/Ctrl-click, acted on together; the right-click menu says "Move [X] files" [MOVE] | ⌘/Ctrl-click adds or removes a file, Shift-click selects a run, ⌘A all, Escape or a click between files none; a right click inside the selection shows "Selected: N", "Duplicate N", "Move N" (where every one may go), "Move N to trash"; in the trash "Restore N", "Delete permanently N"; Delete trashes them all with one "Undo" (`files/selection.ts`, `files/bulk.tsx`) — **fixed** (slice 4); ⌘-click no longer opens a tab (middle click and the menu still do) and a box drawn with the mouse from the empty space between files selects every card it touches, Shift or ⌘/Ctrl adds them (`files/marquee.ts`) — **fixed** (slice 15) | same |
| Drag files onto a folder in the sidebar; drag a file into "Starred" [STAR: "Drag a file directly into the Starred section"] | cards drag onto a project or "All files" of their team (the whole selection when the card is in it), onto "Recent" back to personal files (managers), onto "Trash" into the trash; a place that cannot take them stays dark (`files/drop.ts`) — **fixed** (slice 5) and onto "Favorites" — **fixed** (slice 14) | same |
| Duplicate a trashed file to drafts [TRASH: "Duplicate to drafts"] | "Duplicate to personal files" first in the trash menu: `POST /api/design-files/:id/duplicate-to-drafts` from `files/trash-api.ts`; the copy opens from the toast, the trashed file stays — **fixed** (slice 9) | same |
| Download a copy (.fig) | "Save to computer (.rdesign)" when the portable module is in | same (Morfa's own format) |

## New files
| Figma | Morfa | State |
|---|---|---|
| "+ Create" / new design file | "New file" | same |
| New FigJam board | "New board" | same |
| Templates | the arrow beside "New file": "Start from a template" | same |
| Import (.fig) | "Import" → "Import from Figma…" (by link and token), "Open .rdesign file…", drop a file | same: the dialog takes a .fig file from disk or a link and token (Figma's API); the other two entries open a Morfa file |

## Share
| Figma | Morfa | State |
|---|---|---|
| "Copy link" at the top right of the dialog beside ×, in the accent; "Who has access" with a role at each row's right [SHARE] | "Copy link" in the header beside × in the accent — **fixed** (was in the footer); the rest as Figma's; Morfa keeps "Done" in the footer | same |
| Who has access, with roles | the owner or team, guests with "Can edit" / "Can view", "Remove access" | same (`teams/ShareDialog.tsx`, `docs/design-tool.md` §Teams) |
| Link access: anyone with the link can view or edit, or only invited | "Link access": invited people only / anyone with the link can view / anyone with the link can edit | same |
| Copy link | "Copy link" | same |
| Pending invite links | listed, can be revoked | same |

## The team's pages
| Figma | Morfa | State |
|---|---|---|
| Members with roles, change and remove | "Members": roles, "Remove from team", invites by link | same |
| Team settings: name, leave, delete | "Team settings" | same |

## Ranked fixes made in this pass (slice 2, from Figma's pictures)
1. Seen on every visit: the sidebar's order (lockup, account, search, places), the selected place's blue tint, the title in the
   top bar with the actions at its right and the filters under it.
2. Seen on every file: the kind's mark beside the name; the file menu in Figma's order.

## Ranked fixes made in this pass (slice 1)
1. Wrong or broken: none found on a desktop; the phone layout was fixed separately.
2. Looks different: the account at the top of the sidebar with the theme and "Sign out" in its menu.
3. Small missing: the kind filter; "Copy link" and "Share…" in a file's menu.

Tests: `tests/e2e/design-files-parity.spec.ts`, `tests/design-file-browser.test.ts`; `tests/e2e/design-files.spec.ts` now signs
out through the account menu.
