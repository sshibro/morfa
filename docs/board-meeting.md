# Meeting — meeting features of design files and boards

What people do together in an open file, a design file or a board (docs/board.md): a shared timer with music, voting
sessions, emotes, cursor chat "/", "Get attention" (spotlight) and a high five. FigJam has the same set; Figma Design has cursor
chat, spotlight and the timer. Everything rides on the co-editing stream (docs/design-tool.md §Teams "Co-editing") and
loads only after it, in a chunk of its own: none of it is in the editor's first load.

Code: `shared/design/meeting.ts` (wire types, limits, the rules both sides share), `server/design/meeting/` (routes and service),
`src/design/meeting/` (the client), `src/design/styles/meeting.css`, migration SQL040 (`server/postgresql/schema/040-design-meetings.sql`).

## Two kinds of state, never mixed

- **Durable** (PostgreSQL; survives reloads, reconnects and deploys): the timer and the voting session with its ballots. The server
  orders every change of a file's meeting (`revision`). The stream only says that something changed (`event: meeting {revision}`); each
  editor reads `GET …/meeting` again, a little spread out so fifty people do not ask in the same millisecond. An answer older than what
  an editor shows (a lower revision) never replaces it. Without the stream (switched off or reconnecting) a visible tab reads every
  15 s.
- **Ephemeral** (presence; held in the stream's memory and passed between processes by the fan-out, never written to a table): cursor
  chat, the last emote burst, a wave, "Get attention". It is the `meeting` field of each connection's presence and goes out with the
  cursor's coalesced posts (at most one post per 60 ms, 25 per second per stream on the server).

## Who may do what

Every route reaches its file through `fileAccess` (server/design/file-access.ts), inside the files API's flag, session, rollout,
account-generation check (`captureCustomerAuthority`, `designRead`/`designWrite`) and error shape.

| | Owner, Admin, Editor | Developer, Viewer |
|---|---|---|
| See the timer and the vote, hear the music, set their own volume | yes | yes |
| Start, pause, "+1 min", stop the timer; change its music | yes | no (403) |
| Start, end a vote; clear its results | yes | no (403) |
| Vote (their own dots), emotes, a high five, cursor chat, "Get attention" | yes | yes |

Decided this way because a timer and a vote run a meeting for everyone (as editing does), while voting, reacting and talking are not
edits of the document: viewers comment in Figma and vote in FigJam. A personal file has only its owner. A file in the trash keeps its
meeting readable and takes no change (404). A stranger gets 404, as for a file that does not exist.

## Server (`/api/design-files/:id/meeting`)

| Route | Need | Answer |
|---|---|---|
| `GET /` | view | `DesignMeetingState`: `revision`, the server's `now`, `timer`, `vote` (the caller's own ballots; everyone's only once it ended), `canControl` |
| `POST /timer` `{action: start \| pause \| resume \| add \| stop \| music}` | edit | the new state |
| `POST /vote` `{action: start \| end \| clear}` | edit | the new state |
| `POST /vote/ballot` `{voteId, nodeId, delta: ±1}` | view, while the vote runs | the new state (409 `design_meeting_conflict` when it ended or no votes are left) |

- Bodies are JSON of at most 4 KB, read after the session check; the acting tab sends its stream `client`, so its own stream is not
  told what its answer already says.
- Rate limits per account and minute: 240 reads, 60 timer and vote changes, 240 ballots. Presence keeps the stream's limits.
- Ordering: writes of one file lock its `design_meetings` row (created on first use); ballots take it FOR SHARE so people vote in
  parallel while a start or an end waits for them. One person's ballots are ordered by their account lock (designWrite), so ballots
  sent at once never exceed their votes.
- Signals: after a commit the file's streams get `meeting {revision}` (`recordMeeting`, server/design/live/hub.ts), passed to other
  processes by the fan-out (`kind: 'meeting'`). A ballot changes no revision and tells only its voter's own tabs (`{revision, user}`):
  the counts of a running vote are nobody else's business.
- Times are the server's clock in ms; every answer carries `now`.
- SQL040: `design_meetings` (one row per file: `revision`, the timer columns, the vote columns, constraints that keep each half whole)
  and `design_meeting_votes` (file, vote, person, object, `count` 1–20). The rows belong to the file (`ON DELETE CASCADE`), so trashing
  for good, erasing a team or the account that holds the file takes them. They are a few hundred bytes per file and are not counted in
  the holder's 5 GB room.
- Account life: erasure deletes the account's ballots in every file and forgets it as the one who started a timer or a vote
  (`eraseDesignMeetingsOf`, `timer_by`/`vote_by` become NULL; the people still see the timer and the vote, named by nobody). The
  account's data export has `design.meetingVotes` (file, vote, object, dots).

## Timer

- Started by an editor from "Reactions and meeting" → "Timer" in a design file (the pill then shows in the right panel's header while it
  runs, is paused or just ended), or from the timer button that a board keeps in its top-right pill (FigJam's place). Presets 1, 3, 5,
  10 minutes, ± one minute, 5 s to 99:59. Pause, Resume, +1 min and Stop; "Started by" names the starter.
- Everyone counts down to the same `endsAt` on the server's clock: each editor estimates the offset from its answers (NTP's rule: the
  sample with the shortest round trip of the last eight wins, `clock.ts`), so a laptop a minute off still ends with everyone. At zero
  the pill turns the accent and says "Time is up" for ten seconds; a bell rings for those who watched it run.
- Music: "No music", "Lo-fi", "Ambient", "Rain" — generated in each browser with Web Audio (`music.ts`, oscillators, filtered
  noise and envelopes); no recording is shipped or fetched, so there is no licence to track. Loaded with the first track a person hears.
- Sound only after a gesture: no audio context exists until the person pressed a key or the pointer in the page, so someone who opens a
  file while a timer runs with music hears nothing until their first click. Volume and mute are each person's own ("only for you"),
  kept in this browser (`localStorage`); muted, the generator does not run at all.

## Voting

- An editor starts it from "Reactions and meeting" → "Voting…": votes per person (1–20, three by default) and, optionally, a timer
  that ends it (it pauses with the timer; stopping the timer leaves it running until an editor ends it). Everyone else is taken into
  voting at once unless busy with another tool, with a toast naming the starter; "Vote" in the bar enters it later.
- What a vote counts: in a design file the top-level frames (components, sets, instances, groups; frames inside sections count, the
  section does not; hidden ones never), `frameTargetAt`; on a board the votable objects of the board-objects API (below).
- A click gives one of your votes; your dots show on the object in your colour (up to three dots, then "×N"); a click on a dot takes it
  back. Counts stay hidden until the end: the server returns only your own ballots while it runs.
- It ends when an editor presses "End" or its timer runs out. Everyone then sees the results: a badge per object (the winners in
  the accent) and "Voting results" (who voted, how many votes, the ranking with shared places, a click shows the object). Editors
  "Clear results for everyone"; the next vote replaces the previous one and its ballots.

## Reactions, cursor chat, high five, spotlight

- **Emotes** (❤️ 👍 👎 🔥 😂 😮 🎉): choose one in "Reactions and meeting"; the canvas cursor becomes it and the emote bar takes the toolbar's
  place; pressing on the canvas bursts it at the pointer, again every 160 ms while held. Escape leaves. Each burst counts (`{id, n}`),
  so the others play every one, never one that was there before they arrived.
- **Cursor chat "/"** (Figma's key): a bubble at your pointer in your colour, the field focused; others see your words under your cursor
  as you type (one line, at most 100 characters, no control or direction characters, text only). Enter keeps it four seconds, then it
  fades; Escape closes it; it closes by itself after 15 s without typing. "Cursor chat" in quick actions does the same.
- **High five**: choose it and hold the button: a hand waves on your cursor for everyone. Two people waving with cursors
  within 72 screen pixels on one page meet: a big 🙌 with sparkles for both, once per pair of waves.
- **"Get attention"**: everyone else follows your view (page and viewport) until they pan, zoom, switch page or press Escape; then a
  pill "… is getting attention · Follow" brings them back. Your canvas gets an accent frame and "Everyone is following your view ·
  Stop". The latest to start wins; it ends when they stop, close the file or lose the stream.

## Motion and sound (the design tokens win)

- Nothing a key opens animates: cursor chat appears at once, the voting and emote bars swap with the toolbar at once.
- Popovers come from their trigger (the shared Popover). The results card fades in from 4 px above (`--dz-base`, ease-out) — a vote
  ending is rare. Emote bursts and the high five are the one delight (Web Animations on transform and opacity, at most 80 particles).
- With `prefers-reduced-motion` bursts only fade, the waving hand stands still, the results card only fades.
- Press feedback 0.96 (wide rows 0.985); hover only on a fine pointer; transitions name their properties.

## On a board

The board editor (docs/board.md §Meeting slot) loads `src/design/meeting/board.tsx` lazily through `src/design/board/features.ts`;
it registers `Controls` (the timer, always shown, and "Reactions and meeting", in the board's top-right pill) and `CanvasLayer` (bursts,
chat, bars, results, spotlight) with `registerBoardMeeting`. Both share one controller per open board (`board-adapter.ts`), made once
co-editing runs. The slot's board-objects API is used as is:

- `objectAtPage` and `votableObjects` decide what a click votes for (stickies, shapes, stamps, stickers, texts, tables; never
  connectors or marker strokes); a results row is named by the object's words (a sticky's text).
- `interceptClicks` takes the clicks of the two modes while one is on: voting (a click votes, ⌥-click takes a vote back — a board draws
  the badges itself, so there are no dots to click; a click on empty canvas stays the board's), reactions (a press bursts until the
  button comes up). Entering a mode switches the board to "Move"; Escape leaves.
- `setBadges('voting', …)` draws this person's votes (`tone: 'mine'`) while it runs and everyone's results after (`accent` for the
  winners, `neutral` for the rest); closing the board removes them.
- The meeting's accent is `--dz-meet-accent`; on a board (`.dz-board`) it is the board's purple `--bd-accent`. Its popovers are drawn
  in the editor's layer outside the board, so they take the accent where their trigger stands (`Accented` in `ui/Header.tsx`): the
  chosen preset and "Start" are purple on a board, blue in a design file; focus rings stay the editor's blue.
- In the pill the timer and "Reactions and meeting" are 36 px with the board's 8 px radius, like its own buttons. The board's chrome floats
  over the meeting's layer (its toolbar at the bottom, its pills in the top corners), so on a board the voting and emote bars stand at
  the top centre (FigJam's place for a vote), "Get attention" and the results under the pills.
- The design file's meeting (`DesignEditor`) never starts on a board: the board's slot is its only place there.

## Tests

- `tests/design-meeting.test.ts`: the timer on the server's clock, ballots and ranking, chat text, high fives, frame targets, the clock
  estimate, the session (signals, stale answers, ballots shown at once), presence fields, bursts, spotlight.
- `tests/design-meeting-board.test.ts`: the board against its slot API with a fake (targets, the surface's clicks, Escape, badges, one
  controller for two places through a vote), the lazy features line, sound waiting for a gesture.
- `tests/postgresql-runtime-design-meeting.test.ts`: every route under each role, hidden counts, timed votes, ballots at once, presence
  checks, the trash, erasure (ballots and starters), the export, the PostgreSQL fan-out. `tests/postgresql-design-meetings-migration.test.ts`.
- `tests/e2e/design-meeting.spec.ts`: three people on a team file — the timer and its music (no audio before a gesture, mute per
  person, viewers cannot run it, nothing fetched), a vote with a viewer (hidden until the end, results for all), cursor chat, emotes
  (reduced motion: fades only), a high five, "Get attention"; and on a real board (one person in the dark theme) — the 36 px pill
  controls, the purple in the popover, the timer, a vote on stickies (the board's badge in its purple, ⌥-click back, Escape leaves,
  selection untouched), results, cursor chat and an emote over the board.

## Known gaps

- On a board the hover of the board's own "Move" (outline, connector magnets) stays while voting; the vote goes to the object
  all the same.
- No FigJam "music library" beyond the three generated tracks; no per-person timer (FigJam has only the shared one too).
- Votes are per file, not per page: a results list names objects of every page, badges show on the current one.
- A spotlight follows the presenter's view, not their selection or open panels.
