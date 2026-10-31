# Optimistic updates on the main thread — a `@dldc/sync` example

A task list that demonstrates **optimistic updates driven from the main thread
*relative to* a slow worker**, built on `dispatchAsync(action, id)` + the
`subscribeDispatched(id)` commit signal.

The [todo example](../todo/) renders straight from `subscribeState`
snapshots. Here `ToggleTask` runs a deliberately **slow** reducer (a busy-wait
in `shared.ts`), so if the UI only rendered what the worker sends back, every
toggle would lag behind the worker's whole pipeline: message-passing, dispatch
queue, OPFS lock, the reducer itself, the rebase, and the transfer back.

**Only the toggle is optimistic.** Add and Delete are deliberately *not* — they
surface at the slow worker's pace, as expected. The toggle is the case (a slow,
synchronous action) that makes a main-thread optimistic layer worth having — it
works for anything that must take effect synchronously with its event (typing,
dragging, toggling).

## What you'll see

1. **The toggle flips instantly** — in the same turn as the click. The main
   thread does NOT run the slow reducer (that would freeze the UI for as long
   as it freezes the worker): it applies a cheap O(1) patch that just flips
   the task's `done`.
2. **`dispatchAsync` resolves → chip flips to `applied`** — the deterministic
   "your action is now in the local engine's state" signal (see below).
3. **Server acks → header flips to `synced`** — nothing left for the server to
   ack.

The checkbox is the star: flip it and it stays flipped while the slow worker
catches up — no re-apply, no flicker.

A per-action **feed** at the bottom logs each action's lifecycle with its
deltas (`dispatch` → `applied` → `server`).

## The pattern

```ts
// main thread: an overlay keyed by the id passed to dispatchAsync,
// rendered as a cheap `done` flip (see client/optimistic.ts)
client.subscribeState((bytes) => { workerState = decode(bytes); render(); });

// the commit signal: fires BEFORE the snapshot that contains the action is
// delivered, so the overlay is dropped in time for the next render
client.subscribeDispatched((id) => { overlay.delete(id); });

function onToggle(id) {
  const token = ++seq;
  overlay.set(token, { kind: "ToggleTask", id });
  render(); // instant — cheap patch: key insight, the reducer runs only in the worker
  client.dispatchAsync({ kind: "ToggleTask", id }, token).catch(() => {
    overlay.delete(token); // the engine never applied it: roll back
    render();
  });
}

function render() { renderState = applyOptimisticToggle(workerState, overlay); }
```

`applyOptimisticToggle` (`client/optimistic.ts`) is a pure O(1) patch that
mirrors what the reducer will do — it never executes the reducer. The worker
(and the server) run the real, slow reducer; the main thread just flips the
bit optimistically and reconciles on commit.

### Why `dispatchAsync`, the `id`, and `subscribeDispatched`?

From the main thread, `dispatch()` is fire-and-forget. A concurrent server
patch can slip an intermediate snapshot in between your `dispatch()` call and
the snapshot that contains your action, so "the next event has my action" is
**not** guaranteed.

`dispatchAsync(action, id)` fixes that:

- on resolve, `getState()` already contains the action and a
  `subscribeState` event that includes it was already delivered (the worker
  posts the `State` snapshot before the ack, and worker→main messages are
  FIFO);
- **and** just before that snapshot is delivered, `subscribeDispatched(id)`
  fires with the same `id`, synchronously, ahead of the `subscribeState`
  render.

That second piece is what makes the optimistic overlay safe. The worker's
snapshot already contains every action it has absorbed, so if the overlay still
held the toggle when the commit snapshot rendered, it would re-apply it (the
checkbox flips back off). Because the overlay is removed in
`subscribeDispatched`, the very next render from that snapshot reconciles to
the authoritative `done` value. No bookkeeping, no reconciliation logic: the
library's ordering makes re-application impossible.

If the engine fails to apply an action (no commit snapshot is ever emitted),
`dispatchAsync` rejects — the rollback path drops the overlay entry.

### Why the main thread never blocks

The slow reducer stays in the worker and the server. The main thread's
optimistic render is a trivial flip, and it reconciles to the authoritative
snapshot via the commit signal — so toggling stays responsive even though the
worker takes ~100ms+ to commit. That's the win: instant UI, slow worker, no
jank, no flicker.

## Layout

```
optimistic/
├── shared.ts          # types + the reducer (ToggleTask is deliberately slow) + sanitize/restore
├── server.ts          # Node server: createStore + /api/client/:id/{sync,dispatch}
├── index.html         # browser entry (chips, badges, action feed)
├── vite.config.ts     # dev server; proxies /api to the Node server
├── e2e/               # pure patch tests + Playwright tests (incl. the instant-toggle + no-flicker regressions)
└── client/
    ├── main.ts        # ★ optimistic toggle overlay + dispatchAsync + subscribeDispatched
    ├── optimistic.ts  # applyOptimisticToggle: the cheap, pure main-thread patch
    ├── worker.ts      # createWorkerEngine (same as the todo example) — runs the slow reducer
    └── style.css
```

## Run it

Two processes, exactly like the todo example (from the repo root):

```sh
# Terminal 1 — the Node API server (port 3100)
pnpm example:optimistic

# Terminal 2 — the Vite dev server (port 5174), proxying /api -> :3100
pnpm example:optimistic:client
# open http://localhost:5174
```

Open the page in two tabs to watch tasks sync live.

## End-to-end tests

```sh
pnpm example:optimistic:e2e   # vite build && vitest run (Playwright)
```

The suite verifies: an added task is applied locally and reaches `synced`; a
burst of adds all apply and all sync; toggling flips the checkbox **instantly
while the entry is still pending** (ahead of the slow worker) and its render
history is monotonic — once checked, never unchecked; and delete flows through
the same lifecycle.
