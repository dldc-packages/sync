# Architecture

This document describes how `@dldc/sync` keeps data consistent on the client,
even when several tabs run in parallel. It is the reference for the data model
and for the storage/rebuild rules the code must follow.

The big idea in one sentence: **the disk is the single source of truth shared
by all tabs, and every tab derives its live view from it by replaying its own
local changes on top of the last content the server sent.**

## The three layers

```
┌───────────────────────────────┐
│  Main thread  (per tab)       │   UI, reads/writes the live snapshot
│  createWorkerClient           │
└──────────────┬────────────────┘
               │ postMessage (zero-copy ArrayBuffer transfer)
┌──────────────▼────────────────┐
│  Worker  (per tab)            │   owns all the logic: reducer, rebase,
│  createWorkerEngine           │   sync loop, send loop, dispatch
└──────────────┬────────────────┘
               │ OPFS (files + navigator.locks)
┌──────────────▼────────────────┐
│  OPFS  (shared across tabs)   │   the only persistent, cross-tab state
└───────────────────────────────┘
```

- **OPFS** is shared by every tab of the origin and guarded by a lock
  (`navigator.locks`). Anything that must survive a restart or be visible to
  another tab lives here and nowhere else.
- **Worker** is per tab. It is the only layer that reads/writes OPFS, runs the
  reducer, and talks to the server.
- **Main thread** is per tab. The worker sends it *snapshots* (already-computed
  bytes) and it sends the worker *actions* to dispatch. It never touches OPFS
  or the server.

## The data model

Three kinds of data flow through the system:

| Kind     | What it is                                        | Synced to server?           | Stored where                      |
| -------- | ------------------------------------------------- | --------------------------- | --------------------------------- |
| **State**| The file content — an opaque `ArrayBuffer` (JSON, a SQL db, …). | Yes — it *is* the synced file. | OPFS **db file** (server content). |
| **Outbox**| The ordered list of actions this client produced but the server hasn't applied (and acknowledged) yet. | No — each entry is *sent* to the server until it's acked. | OPFS **meta file** (Bookkeeping JSON). |
| **Derived**| A second value computed from the state, never synced (an index/cache/aggregate). | No. | OPFS **derived file** (server-content derived). |

### State

One opaque `Uint8Array`. The server is the source of truth; every content the
client holds ultimately comes from a server patch (rsync delta). OPFS stores
only the **committed** content — the last one the server sent — never the live
optimistic one.

### Outbox

Actions the user produced locally that the server hasn't applied yet. Stored in
HLC order (each entry carries its `ts`), append-only in normal operation, JSON
in the meta file (the engine's `Bookkeeping`). Each entry has a `sent` flag: it
starts `false`, flips to
`true` once the HTTP dispatch returns 200, and the entry is dropped entirely on
the next sync when the server acknowledges it (via `clientLastApplied`).

Because it lives in OPFS, the outbox:
- survives restarts (offline-first: actions flush when back online), and
- is shared across tabs (one tab's dispatch is added under the lock and is
  visible to every tab).

The `sent` flag is also shared, which is what prevents two tabs from
double-sending the same action.

### Derived

A second `Uint8Array` computed from the state by the `derive` function (or
maintained incrementally by the reducer). It is used for things like an index
you don't want to rebuild from scratch on every change. It is **never** synced
to the server. Derived is **always on** — every app supplies a `derive` (client
and server alike), and the derived value is never null in the pipeline.

Derived obeys exactly the same storage/rebuild rule as the state:

- OPFS holds the derived **for the committed server content** (its own file,
  written in the same critical section as the db file, keyed by `serverVersion`).
- The live derived is **rebuilt by rebasing the outbox on top of it**, in
  memory, in the worker.

### The core identity

Every snapshot (state **and** derived) the UI sees is always:

```
live       = lockstep state + derived for the same (server content + outbox)
committed  = server content      + its derived                ← what's on disk
```

These are two lockstep layers. There is **no** case where the live derived
corresponds to a different content than the live state.

## Storage & locking

Three files under OPFS. `Storage` (`src/client/storage.ts`) is a deliberately
**dumb, lock-free** file layer — it just reads and writes the three files. All
locking and consistency decisions live one level up, in the **store**
(`src/client/store.ts`), which owns the OPFS lock and composes the three files
into consistent transactions.

| File                | Contents                                         |
| ------------------- | ------------------------------------------------ |
| `metaFileName`      | JSON `Bookkeeping`: `clientId`, `hlc`, `outbox[]`, `errors`, `serverVersion`, `context` |
| `stateFileName`     | the committed server content (`Uint8Array`)      |
| `derivedFileName`   | the derived of the committed server content      |

Every read-modify-write of these files happens inside the store's
`withLock(opfsLockName, …)` (`src/client/store.ts`, acquired through
`navigator.locks`, `src/client/lock.ts`), so concurrent tabs serialize instead
of corrupt each other.

The important invariant: **db file and derived file are always for the same
`serverVersion`.** The store writes them in one critical section
(`persistDerived` runs right after the db write, inside the same lock), so a
racing tab's patch can never land between the two writes. A stale derived file
on disk is harmless: it is recomputed from the committed content on startup.

## The rebase

The store keeps two pairs in memory (`src/client/store.ts`):

```
serverState     ← committed content        (last version the server sent)
serverDerived   ← derived of serverState
localState      ← what the UI sees         (optimistic)
localDerived    ← derived of localState
```

`local*` is derived from `server*` by **rebase**: replay the outbox through the
reducer on top of the committed content, tracking derived:

```
localState, localDerived = fold over outbox:
    (state, derived) = reducer(state, ctx, action, derived)
    starting from (serverState, serverDerived)
```

Each reducer step may update state only (raw file, derived unchanged) or both
(`{ state, derived }`).
This is why the reducer must be derived-aware. For an empty outbox,
`local == server`.

## Data flows

### Startup

1. `init` creates the `Storage` and reads the db, derived and meta files
   (`loadInitial`, `src/client/store.ts` — the store owns this lock too).
2. `createStore` recomputes `serverDerived = derive(db, savedDerived)` — always
   recomputed; the saved file is just a hint/diff base.
3. `initialLocal = rebase(db, outbox, serverDerived)`.
4. The worker posts `Ready` (database + derived) to the main thread; derived
   rides along so a fresh tab is immediately consistent.

### Dispatch (optimistic)

1. Main thread posts `Dispatch(action)`.
2. `dispatcher` → `store.dispatch`: under the lock, mint an HLC `ts`, append to
   the outbox, persist; if another tab changed the db meanwhile, read it and
   compute + persist its derived in the same critical section.
3. `store.dispatch` then commits in-memory: if the server content changed, full
   rebase; if only the outbox grew, rebase just the appended entries on top of
   the current `local*` (incremental path).
4. Emit `Database` (+ derived) to the main thread → optimistic UI, wake the
   sender, and `BroadcastChannel("…")` tells other tabs to refresh.
5. Other tabs' workers re-read OPFS (`store.refreshFromOpfs`) and rebase → all
   tabs show the same live content.

### Send / ack

The sender (`src/client/sender.ts`) is an independent loop. Under a *separate*
`sendLockName` it takes the first unsent outbox entry, POSTs it to `/dispatch`,
marks it `sent`. The server dedups by `ts` anyway. Entries are dropped only when
the server acknowledges them through the sync channel.

### Sync (server → client)

1. The sync stream yields `InitialPatch` / `Patch` / `UpToDate`, each carrying a
   `version` and `clientLastApplied`.
2. `store.applyPatch` (under the lock):
   - **Version dedup:** if `meta.serverVersion` already equals the incoming
     version, another tab handled this patch — just read the files (and
     re-derive), don't apply twice.
   - Else apply the rsync patch to the db file, bump `serverVersion`, drop
     acked outbox entries (everything with `ts ≤ clientLastApplied`), and write
     the derived for the new content in the same lock.
3. Rebuild `local*` by rebasing the remaining outbox, and emit.

## Cross-tab consistency, in one place

How parallel tabs stay consistent:

| Risk | How it's handled |
| ---- | ---------------- |
| Two tabs mutate OPFS at once | The store serializes every file read-modify-write behind one OPFS lock. |
| Db + derived written at different times | Both written in one store transaction, tied to `serverVersion`. |
| Two tabs apply the same server patch | `serverVersion` dedup inside the store's `applyPatch`. |
| Two tabs send the same action | `sent` flag persisted in the shared outbox + a separate send lock. |
| A tab dispatching vs another tab's older in-memory state | `BroadcastChannel` wake → store refreshes from OPFS → rebase → converge. |
| Optimistic content across tabs | Every tab derives `local*` from the *same* disk data, so the rebase result is identical. |

## Frontend delivery

The worker delivers the derived to the main thread as follows:

- The derived **rides along with every `Ready`/`Database` snapshot**, so the
  main thread needs no separate request. The cost is a `slice()` copy of the
  derived per emission (~30 µs/MB; the transfer itself is zero-copy), and an
  `emitDerived: false` escape hatch: the main thread always gets the *initial*
  derived (non-null), but later snapshots arrive without an updated derived —
  skipping the per-emission copy for apps that only need it at startup.

## Server side

The server follows the mirrored rule (`src/server/`): it stores the authoritative
file *and* a derived file next to it — derived is always on, client and server
alike — and `clientLastApplied` per client is what drops entries from the client's outbox.
The client and server must both run the same `derive` (and a derived-aware
reducer) or the two sides could compute different states.

## Glossary

| Term | Meaning |
| ---- | ------- |
| **State / server content** | The opaque `Uint8Array` file coming from the server. |
| **Committed** | The content (and derived) the server last sent; what OPFS holds. |
| **Live** | The optimistic content (and derived) the UI sees after rebasing the outbox. |
| **Outbox** | The HLC-ordered actions not yet applied/acked by the server. |
| **Derived** | A value computed from the state, never synced (index/cache). |
| **Rebase** | Replaying the outbox through the reducer on top of the committed content. |
| **`serverVersion`** | The id tying the on-disk db + derived pair to a content version. |
