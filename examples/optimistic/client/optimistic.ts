import type { TaskState } from "../shared.ts";

/**
 * Cheap main-thread optimistic patches.
 *
 * The main thread NEVER runs the (deliberately slow) reducer — doing that would
 * freeze the UI for the same ~100ms+ it freezes the worker. Instead, for the
 * optimistic render it applies a trivial O(1) patch that mirrors what the
 * reducer will eventually do, and lets `subscribeDispatched` reconcile back to
 * the authoritative snapshot when the worker commits.
 *
 * Only `ToggleTask` is optimistic in this example (the slow, synchronous case
 * that makes a main-thread optimistic layer worth having). Add/Delete are not
 * optimistic — they surface at the worker's pace, as expected.
 */

/**
 * Return `base` with the target task's `done` flipped. Mirrors the
 * `ToggleTask` case of the reducer, without running it. Never mutates `base`.
 * Toggling a task the snapshot doesn't contain is a no-op.
 */
export function applyOptimisticToggle(base: TaskState, id: string): TaskState {
  return {
    tasks: base.tasks.map((t) => (t.id === id ? { ...t, done: !t.done } : { ...t })),
  };
}
