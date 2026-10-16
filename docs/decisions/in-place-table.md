# The node table written in place

Written 2026-10-10. Decision, reviewed with the store's maintainers:
the editor's store commits into the document's own node table instead of copying it per commit.

## Why

Every commit copied the whole node table before its first write (`copyTable` in the transaction): 48–64 % of a commit on
the product file at 2× (7.1 of 14.9 ms for a resize, 5.9 of 9.3 ms for a move, 6.8 of 11.4 ms for a keystroke), and
~102 of ~106 ms a keystroke on `f100k`. The idle copy made ahead of time hid it only when the editor had idle time. After:
at `f100k` 1×, E1's commit p95 58–77 → 2.2–4.0 ms, E5's 50–61 → 2.5–3.1 ms; at 2× a keystroke's transaction 179 → 5.6 ms.

## What changed

- `beginTransaction(doc, {table: 'copy' | 'in-place'})` (shared/design/transaction.ts). The module default stays `copy`:
  the server, the scripts and the benches copy as before. The editor store's default is `in-place`
  (`DesignStoreOptions.table`; `MORFA_TABLE`, `__MORFA_TABLE__` or `?table=` override it; `MORFA_E2E_TABLE` and
  `BENCH_TABLE` force it for a run).
- In place, the recipe writes an overlay over the document's own table (`overlayView`, shared/design/table-cache.ts), so
  the published document is untouched until commit and `tx.base` is the base itself. The commit applies the overlay,
  normalization writes the same table, every write site logs the entry's original (`TableLog`), the inverse comes from
  the log, the patch is built against a view through the log, and the table's indexes are derived for the change. A
  recipe that throws leaves nothing to undo; a normalization that throws puts the table back.
- Gestures keep their shared copy in either mode: a drag's frames write a table of their own from the gesture's base,
  which stays as it was until the gesture ends.
- Undo, redo, remote and page applies go in place, with the inverse taken before the apply. `PatchEvent` carries
  `inverse` on every source. The store copies the document handed to `createDesignStore` once.
- Node objects stay copy-on-write per id: a `SceneNode` held is a moment; a `DesignDocument`'s `nodes` table is not.

## For code that reads the document

1. **A document object is a moment, its table is not.** `store.getState().doc` is a new object per commit, as before;
   its `nodes` table is the same object for the file's whole life and changes under you. Compare documents (`prev !==
   next`), never tables (`prev.nodes === next.nodes` now always says "same", and `Object.hasOwn(before.nodes, id)` says
   what is true now). To know what changed, use the store's change sets: `onDocument`'s `changed` ids, or `onPatch`'s
   `patch` and `inverse` (the inverse holds every entry's previous value — that is where "before" lives now).
2. **Node objects are still immutable per id.** Keeping a `SceneNode` and comparing `doc.nodes[id] === node` to see
   whether it changed stays right; `memo`s and `useMemo`s keyed on a node, on `doc`, or on `changed` are fine; a memo
   keyed on `doc.nodes` (the table) never recomputes — key it on `doc`. A `WeakMap` keyed on `doc.nodes` is stale forever
   — key it on `doc`.
3. **Work that spans time takes a snapshot.** Anything that reads `doc.nodes` after an `await`, a timer, an idle slice,
   a worker round trip or a later event (an export, a thumbnail, a long computation, a dialog's mount-time state) calls
   `snapshotDocument(doc)` (shared/design/table-cache.ts) once at the start and reads that: O(layers) once per job,
   never implicit. Take it before the first await, not after (a document held across an await and snapshotted later pairs
   the old other tables with the new nodes). Synchronous code needs nothing: inside a recipe the published document is
   still the one before the commit, and after `transact` returns the store already holds the new state.
4. **Readers of "the document before" read the inverse.** `event.inverse.nodes[id]` is the node before the change
   (null: it did not exist); `before.nodes[id]` from a kept document is the node after.
5. **Gestures are unchanged.** A drag's frames write a copy of their own; the base stays as it was until the gesture ends.
6. **Tests that kept the earlier document** to assert nothing changed compare values taken before
   (`JSON.parse(JSON.stringify(doc.nodes))`) or the patch, not the object. A test's own `doc` stays as built (the store
   copies it once) and may serve several stores; a test of the copy mode's own mechanism (the idle copy) asks for
   `table: 'copy'`.

## What the surveys found and fixed

The paint picker's palette cache keyed on the table; the `.rdesign` export, the big-file thumbnail, the export dialogs
and the inspector's rasters holding a live document across awaits; the vector editor comparing ancestors through the
shared table; the selection colours comparing the listed document with the new one; the shadow's idle preload reading
the table a part per idle callback. Left, noted for the store: the spatial index counts every recomputed node as moved
(correct, more repaint than changed; the old matrices are knowable from its `seen` map).
