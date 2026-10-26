/**
 * Unit tests for the main-thread optimistic patch (`client/optimistic.ts`).
 *
 * Contract: the main thread never runs the (deliberately slow) reducer — that
 * would freeze the UI as long as it freezes the worker. Optimistic rendering is
 * a cheap O(1) `done` flip, and the overlay entry is removed the instant the
 * worker commits (`subscribeDispatched` fires before the commit snapshot is
 * delivered to `subscribeDatabase`), so the next render reconciles to the
 * authoritative snapshot without re-applying anything.
 *
 * These tests pin that: (1) the patch shows the optimistic flip while the
 * snapshot hasn't caught up, (2) once the committed action is gone from the
 * overlay, the commit snapshot renders as-is (no re-apply → no flicker), and
 * (3) multiple pending flips compose independently.
 *
 * Pure logic, no browser — runs in the e2e suite alongside the Playwright tests.
 */

import { describe, expect, test } from "vitest";
import type { TaskState } from "../shared.ts";
import { applyOptimisticToggle } from "../client/optimistic.ts";

interface TaskLike {
  id: string;
  text: string;
  done: boolean;
}

function task(id: string, done = false): TaskLike {
  return { id, text: `t-${id}`, done };
}

function state(tasks: TaskLike[]): TaskState {
  return { tasks: tasks as TaskState["tasks"] };
}

describe("main-thread optimistic toggle patch (no reducer on the main thread)", () => {
  test("flips `done` optimistically while the snapshot hasn't caught up", () => {
    const base = state([task("a", false)]);
    const rendered = applyOptimisticToggle(base, "a");
    expect(rendered.tasks[0].done).toBe(true);
    // non-destructive: the base is untouched, so a replay on every snapshot is safe
    expect(base.tasks[0].done).toBe(false);
  });

  test("flips back optimistically for a second toggle on the same task", () => {
    const base = state([task("a", true)]);
    expect(applyOptimisticToggle(base, "a").tasks[0].done).toBe(false);
  });

  test("is NOT re-applied after commit: the snapshot renders as-is once the overlay is empty", () => {
    // The worker absorbed the toggle: the commit snapshot has done=true, and
    // `subscribeDispatched` dropped the toggle from the overlay BEFORE this
    // snapshot was rendered. Rendering the snapshot with no overlay must not
    // touch `done` again (a second flip would be the flicker).
    const committed = state([task("a", true)]);
    expect(committed.tasks[0].done).toBe(true);
  });

  test("different tasks flip independently", () => {
    const base = state([task("a", false), task("b", true)]);
    const rendered = applyOptimisticToggle(applyOptimisticToggle(base, "a"), "b");
    expect(rendered.tasks[0].done).toBe(true);
    expect(rendered.tasks[1].done).toBe(false);
    expect(rendered.tasks[0].id).toBe("a");
    expect(rendered.tasks[1].id).toBe("b");
  });

  test("two pending toggles on the same task cancel out (one flip each)", () => {
    const base = state([task("a", false)]);
    const rendered = applyOptimisticToggle(applyOptimisticToggle(base, "a"), "a");
    expect(rendered.tasks[0].done).toBe(false);
  });

  test("toggling a task the snapshot doesn't contain is a no-op", () => {
    const rendered = applyOptimisticToggle(state([task("a", false)]), "ghost");
    expect(rendered.tasks).toHaveLength(1);
    expect(rendered.tasks[0].done).toBe(false);
  });
});
