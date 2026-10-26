import { createWorkerClient } from "../../../src/client.ts";
import type { Action, Context, Task, TaskState } from "../shared.ts";
import { applyOptimisticToggle } from "./optimistic.ts";

/**
 * 🐢 OPTIMISTIC UPDATES ON THE MAIN THREAD (vs a slow worker)
 * =======================================================================
 *
 * `ToggleTask` in `../shared.ts` is deliberately SLOW. If the UI only rendered
 * what the worker sends back, every toggle would lag behind the worker's whole
 * pipeline (message-passing + dispatch queue + OPFS lock + reducer + rebase +
 * transfer back). So the main thread is optimistic for toggles:
 *
 *  1. the toggle is applied IMMEDIATELY via a cheap O(1) patch
 *     (`applyOptimisticToggle` just flips `done`) — NOT by running the full
 *     reducer, which would freeze the main thread as long as it freezes the
 *     worker;
 *  2. `client.dispatchAsync(action, token)` hands the action to the local
 *     engine and resolves once it has been applied locally;
 *  3. `client.subscribeDispatched(token)` fires the INSTANT the worker's
 *     commit snapshot (the one that contains the action) is about to be
 *     delivered — the overlay entry is dropped there, so the next
 *     `subscribeDatabase` render reconciles to the authoritative snapshot
 *     without re-applying anything;
 *  4. if the engine fails to apply the action, `dispatchAsync` rejects and the
 *     overlay rolls back.
 *
 * Add and delete are intentionally NOT optimistic: they surface at the slow
 * worker's pace, as expected. The toggle is the case (a slow, synchronous
 * action) that makes a main-thread optimistic layer worth having.
 *
 * Status chips + feed below make the lifecycle visible:
 *   pending  → dispatchAsync() hasn't resolved yet
 *   applied  → dispatchAsync() resolved: the action is in the local engine
 *   synced   → the server has acked it (no pending actions left)
 */

const client = createWorkerClient<Action, Context>({
  worker: new Worker(new URL("./worker.ts", import.meta.url), {
    type: "module",
  }),
  sanitizeAction: (action) => action,
  restoreContext: (data) => data as Context,
});

// Expose the client to E2E tests.
(window as any).__client = client;

// ─── state (main thread) ────────────────────────────────────────────────────

/** The latest authoritative snapshot from the worker (server + its own pending). */
let workerState: TaskState = { tasks: [] };

/**
 * Uncommitted optimistic toggles, keyed by the token passed to `dispatchAsync`.
 * Only `ToggleTask` ever enters this overlay (see `./optimistic.ts`). It is
 * rendered as a cheap `done` flip and dropped in `subscribeDispatched` the
 * instant the worker commits the action.
 */
const pendingByToken = new Map<number, Action>();

/** Per task id: leading status chip (pending → applied → synced). */
const statusById = new Map<string, "pending" | "applied" | "synced">();

let dispatchSeq = 0;

// Feed + badges bookkeeping.
interface FeedEntry {
  token: number;
  id: string;
  label: string;
  tsDispatch: number;
  tsApplied: number | null;
  tsSynced: number | null;
  failed: string | null;
}
const feed: FeedEntry[] = [];

let serverPending = 0; // number of actions the server hasn't acked yet (subscribeDebugState)

// ─── subscriptions ──────────────────────────────────────────────────────────

client.subscribeDatabase((bytes) => {
  workerState = decode(bytes);
  render();
});

/**
 * The commit signal. Fires synchronously, BEFORE the snapshot that contains
 * the action is delivered to `subscribeDatabase` — so the optimistic toggle is
 * dropped here and the next render (from that very snapshot) reconciles to the
 * authoritative `done` value. No re-apply, no flicker.
 */
client.subscribeDispatched((token) => {
  pendingByToken.delete(token);
});

client.subscribeDebugState((debug) => {
  serverPending = debug.pendingCount;
  if (serverPending === 0) {
    // Nothing left for the server to ack → everything applied is now synced.
    for (const entry of feed) {
      if (entry.tsApplied !== null) entry.tsSynced ??= performance.now();
    }
    for (const [id, status] of statusById) {
      if (status === "applied") statusById.set(id, "synced");
    }
  }
  render();
});

// ─── dispatching with an optimistic lifecycle ───────────────────────────────

function dispatchTracked(action: Action, label: string, optimistic: boolean): void {
  const token = ++dispatchSeq;
  if (optimistic) {
    pendingByToken.set(token, action);
  }
  statusById.set(action.id, "pending");
  feed.unshift({
    token,
    id: action.id,
    label,
    tsDispatch: performance.now(),
    tsApplied: null,
    tsSynced: null,
    failed: null,
  });
  render(); // cheap: the overlay only ever holds toggles

  client.dispatchAsync(action, token).then(
    () => {
      // The action is in the local engine (its commit snapshot has been
      // delivered; `subscribeDispatched` already dropped the overlay).
      const entry = feed.find((f) => f.token === token);
      if (entry) {
        entry.tsApplied = performance.now();
        statusById.set(action.id, "applied");
        if (serverPending === 0) {
          entry.tsSynced = entry.tsApplied;
          statusById.set(action.id, "synced");
        }
      }
      render();
    },
    (error: unknown) => {
      // The engine never committed the action: roll the optimistic overlay back.
      pendingByToken.delete(token);
      const entry = feed.find((f) => f.token === token);
      if (entry) entry.failed = String(error);
      statusById.delete(action.id);
      console.error("[dispatchAsync] failed to apply action:", error);
      render();
    },
  );
}

// ─── rendering ──────────────────────────────────────────────────────────────

/** Latest worker snapshot with the cheap optimistic toggle(s) on top. */
function getRenderState(): TaskState {
  let state = workerState;
  for (const action of pendingByToken.values()) {
    state = applyOptimisticToggle(state, action.id);
  }
  return state;
}

// Instrumentation: per-task sequence of `{ done, status }` across renders, so
// E2E can assert the optimistic flip happens while the entry is still pending
// and that a checkbox never flickers (true → false → true).
const renderHistory: Record<string, { done: boolean; status: string }[]> = {};
(window as any).__renderHistory = renderHistory;

function render(): void {
  const tasks = getRenderState().tasks;
  const list = document.querySelector<HTMLUListElement>("#task-list")!;
  list.replaceChildren(...tasks.map(renderItem));
  for (const task of tasks) {
    (renderHistory[task.id] ??= []).push({
      done: task.done,
      status: statusById.get(task.id) ?? "synced",
    });
  }
  renderBadges();
  renderFeed();
}

function renderItem(task: Task): HTMLLIElement {
  const status = statusById.get(task.id) ?? "synced";

  const li = document.createElement("li");
  li.dataset.id = task.id;
  li.dataset.status = status;
  if (task.done) li.classList.add("done");

  const label = document.createElement("label");
  const check = document.createElement("input");
  check.type = "checkbox";
  check.checked = task.done;
  check.addEventListener("change", () => onToggle(task.id));
  label.append(check, document.createTextNode(task.text));

  const chip = document.createElement("span");
  chip.className = `chip chip-${status}`;
  chip.textContent = chipLabel(status);

  const del = document.createElement("button");
  del.dataset.action = "delete";
  del.textContent = "✕";
  del.setAttribute("aria-label", `Delete ${task.text}`);
  del.addEventListener("click", () => onDelete(task.id));

  li.append(label, chip, del);
  return li;
}

function chipLabel(status: "pending" | "applied" | "synced"): string {
  return status === "pending" ? "…" : status === "applied" ? "applied" : "synced";
}

function renderBadges(): void {
  const badge = document.querySelector("#sync-badge")!;
  const applied = feed.length === 0 ? 0 : feed.filter((f) => f.tsApplied !== null).length;
  document.querySelector("#applied-count")!.textContent =
    `Applied locally: ${applied}/${feed.length}`;
  const serverStatus = document.querySelector("#server-status")!;
  if (serverPending === 0) {
    serverStatus.textContent = "Server: synced ✓";
    badge.setAttribute("data-synced", "true");
  } else {
    serverStatus.textContent = `Server: ${serverPending} pending`;
    badge.setAttribute("data-synced", "false");
  }
}

function renderFeed(): void {
  const body = document.querySelector<HTMLTableSectionElement>("#feed-body")!;
  body.replaceChildren(...feed.map(renderFeedRow));
}

function renderFeedRow(entry: FeedEntry): HTMLTableRowElement {
  const tr = document.createElement("tr");
  const label = document.createElement("td");
  label.textContent = entry.failed ? `${entry.label} (${entry.failed})` : entry.label;

  const dispatch = document.createElement("td");
  dispatch.className = "num";
  dispatch.textContent = "now";

  const applied = document.createElement("td");
  applied.className = "num";
  applied.textContent =
    entry.tsApplied === null ? "…" : formatSince(entry.tsDispatch, entry.tsApplied);

  const synced = document.createElement("td");
  synced.className = "num";
  synced.textContent =
    entry.tsSynced === null ? "…" : formatSince(entry.tsDispatch, entry.tsSynced);

  tr.append(label, dispatch, applied, synced);
  if (entry.failed) tr.classList.add("failed");
  return tr;
}

function formatSince(from: number, to: number): string {
  const delta = Math.max(0, to - from);
  return delta < 1000 ? `+${delta.toFixed(1)}ms` : `+${(delta / 1000).toFixed(1)}s`;
}

// ─── user actions ───────────────────────────────────────────────────────────

function onAdd(text: string): void {
  const trimmed = text.trim();
  if (!trimmed) return;
  dispatchTracked(
    { kind: "AddTask", id: crypto.randomUUID(), text: trimmed },
    `Add: ${trimmed}`,
    false, // not optimistic — surfaces at the slow worker's pace, as expected
  );
}

function onToggle(id: string): void {
  dispatchTracked({ kind: "ToggleTask", id }, `Toggle: ${id.slice(0, 8)}`, true);
}

function onDelete(id: string): void {
  dispatchTracked({ kind: "DeleteTask", id }, `Delete: ${id.slice(0, 8)}`, false);
}

// ─── wiring ─────────────────────────────────────────────────────────────────

const form = document.querySelector<HTMLFormElement>("#task-form")!;
const input = document.querySelector<HTMLInputElement>("#task-input")!;

form.addEventListener("submit", (e) => {
  e.preventDefault();
  onAdd(input.value);
  input.value = "";
});

client.ready().then(() => {
  (window as any).__syncReady = true;
  render();
});

// ─── helpers ────────────────────────────────────────────────────────────────

function decode(bytes: Uint8Array): TaskState {
  if (bytes.byteLength === 0) return { tasks: [] };
  return JSON.parse(new TextDecoder().decode(bytes)) as TaskState;
}
