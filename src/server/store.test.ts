import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { createHLC, serializeHLC } from "../shared/hlc.ts";
import type { TStoreReducer } from "../shared/types.ts";
import { createStore } from "./store.ts";

type Action = { kind: "set"; value: string };
type Context = { user: string };

/** A trivial deterministic reducer — the store treats the bytes opaquely. */
const reduce: TStoreReducer<Action, Context> = (file, _context, action) =>
  new TextEncoder().encode(action.value);

async function withStore<T>(
  run: (store: Awaited<ReturnType<typeof createStore<Action, Context>>>) => Promise<T>,
): Promise<T> {
  const dir = mkdtempSync(join(tmpdir(), "sync-store-"));
  try {
    const store = await createStore<Action, Context>({
      stateDatabasePath: join(dir, "state.sqlite"),
      filePath: join(dir, "main.sqlite"),
      getReducer: async () => reduce,
      restoreAction: (data) => data as Action,
    });
    return await run(store);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}

describe("store.subscribe", () => {
  it("fires on every applied update, including client dispatches, and stops on unsubscribe", async () => {
    await withStore(async (store) => {
      const versions: string[] = [];
      const unsub = store.subscribe((event) => versions.push(event.version));

      store.update(() => new TextEncoder().encode("first"), {
        clientId: null,
        clientLastApplied: null,
      });
      store.update(() => new TextEncoder().encode("second"), {
        clientId: null,
        clientLastApplied: null,
      });
      expect(versions).toHaveLength(2);
      expect(versions[0]).not.toBe(versions[1]);
      // The event is emitted after the bytes are written: the callback already
      // observes the new state.
      expect(new TextDecoder().decode(store.getCurrent())).toBe("second");

      // A client dispatch is an applied update like any other.
      const hlc = createHLC();
      const response = store.dispatch(
        { action: { kind: "set", value: "third" }, ts: serializeHLC(hlc.send()) },
        "client-1",
        { user: "alice" },
      );
      expect(await response.json()).toEqual({ status: "ok", applied: true });
      expect(versions).toHaveLength(3);
      expect(new TextDecoder().decode(store.getCurrent())).toBe("third");

      // Unsubscribing stops future events.
      unsub();
      store.update(() => new TextEncoder().encode("fourth"), {
        clientId: null,
        clientLastApplied: null,
      });
      expect(versions).toHaveLength(3);
    });
  });
});
