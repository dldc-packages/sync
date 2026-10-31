import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { createHLC, serializeHLC } from "../shared/hlc.ts";
import type { TDerive, TStoreReducer } from "../shared/types.ts";
import { createStore } from "./store.ts";

type Action = { kind: "set"; value: string };
type Context = { user: string };

/** A trivial deterministic reducer — the store treats the bytes opaquely. */
const reduce: TStoreReducer<Action, Context> = (file, _context, action) =>
  new TextEncoder().encode(action.value);

/** Trivial derive for the plain-reducer suite: derived mirrors the state bytes. */
const trivialDerive: TDerive = (state) => state;

async function withStore<T>(
  run: (store: Awaited<ReturnType<typeof createStore<Action, Context>>>) => Promise<T>,
): Promise<T> {
  const dir = mkdtempSync(join(tmpdir(), "sync-store-"));
  try {
    const store = await createStore<Action, Context>({
      metaFilePath: join(dir, "state.sqlite"),
      stateFilePath: join(dir, "main.sqlite"),
      derivedFilePath: join(dir, "main.derived"),
      restoreAction: (data) => data as Action,
      getReducer: async () => reduce,
      getDerive: async () => trivialDerive,
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

// ─── derived ─────────────────────────────────────────────────────────────────

type DAction = { kind: "add"; value: string };
type DContext = { user: string };

interface DerivedState {
  values: string[];
}
interface CountDerived {
  n: number;
}

const encodeJson = <T>(value: T): Uint8Array => new TextEncoder().encode(JSON.stringify(value));
const decodeJson = <T>(bytes: Uint8Array, fallback: T): T =>
  bytes.byteLength === 0 ? fallback : (JSON.parse(new TextDecoder().decode(bytes)) as T);

/**
 * A derived-aware reducer that USES `currentDerived` to compute the next state:
 * each value embeds the current counter, so the state would be wrong without
 * a maintained derived value.
 */
const derivedReducer: TStoreReducer<DAction, DContext> = (file, _ctx, action, currentDerived) => {
  const state = decodeJson<DerivedState>(file, { values: [] });
  const derived = decodeJson<CountDerived>(currentDerived, { n: 0 });
  // state depends on the derived counter — proves currentDerived was fed through
  state.values.push(`${action.value}:${derived.n}`);
  derived.n += 1;
  return { state: encodeJson(state), derived: encodeJson(derived) };
};

/** Rebuild the counter from the state (ignores the previous derived hint). */
const rederive: TDerive = (file) => {
  const state = decodeJson<DerivedState>(file, { values: [] });
  return encodeJson<CountDerived>({ n: state.values.length });
};

describe("createStore with derived", () => {
  it("feeds currentDerived to the reducer, persists derived next to the state, and survives a restart", async () => {
    const dir = mkdtempSync(join(tmpdir(), "sync-derived-"));
    const metaFilePath = join(dir, "state.sqlite");
    const stateFilePath = join(dir, "main.json");
    const derivedFilePath = join(dir, "main.derived");
    const hlc = createHLC();

    const makeStore = () =>
      createStore<DAction, DContext>({
        metaFilePath,
        stateFilePath,
        derivedFilePath,
        restoreAction: (data) => data as DAction,
        getReducer: async () => derivedReducer,
        getDerive: async () => rederive,
      });

    try {
      let store = await makeStore();
      const send = (value: string) =>
        store.dispatch(
          { action: { kind: "add", value }, ts: serializeHLC(hlc.send()) },
          "client-1",
          { user: "alice" },
        );

      // Two dispatches: the reducer consumes the counter from derived.
      expect(await send("a").json()).toEqual({ status: "ok", applied: true });
      expect(await send("b").json()).toEqual({ status: "ok", applied: true });

      expect(store.getCurrent()).toEqual(encodeJson<DerivedState>({ values: ["a:0", "b:1"] }));

      // derived is persisted next to the main state file
      expect(decodeJson<CountDerived>(readFileSync(derivedFilePath), { n: 0 }).n).toBe(2);

      // Simulate a server restart: a fresh store bootstraps derived from the
      // current state (+ stored derived as a hint) before the next dispatch.
      store = await makeStore();
      expect(await send("c").json()).toEqual({ status: "ok", applied: true });

      expect(store.getCurrent()).toEqual(
        encodeJson<DerivedState>({ values: ["a:0", "b:1", "c:2"] }),
      );
      expect(decodeJson<CountDerived>(readFileSync(derivedFilePath), { n: 0 }).n).toBe(3);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("maintains derived through raw `update` calls (re-derives from the new state)", async () => {
    const dir = mkdtempSync(join(tmpdir(), "sync-derived-"));
    const metaFilePath = join(dir, "state.sqlite");
    const stateFilePath = join(dir, "main.json");
    const derivedFilePath = join(dir, "main.derived");

    try {
      const store = await createStore<DAction, DContext>({
        metaFilePath,
        stateFilePath,
        derivedFilePath,
        restoreAction: (data) => data as DAction,
        getReducer: async () => derivedReducer,
        getDerive: async () => rederive,
      });

      // Server-side programmatic write (bypasses the reducer): derived is
      // recomputed from the new state so the next reducer call stays correct.
      store.update((_cur) => encodeJson<DerivedState>({ values: ["x:0", "y:1"] }), {
        clientId: null,
        clientLastApplied: null,
      });
      expect(decodeJson<CountDerived>(readFileSync(derivedFilePath), { n: 0 }).n).toBe(2);

      const hlc = createHLC();
      const res = store.dispatch(
        { action: { kind: "add", value: "z" }, ts: serializeHLC(hlc.send()) },
        "client-1",
        { user: "alice" },
      );
      expect(await res.json()).toEqual({ status: "ok", applied: true });
      expect(decodeJson<DerivedState>(store.getCurrent(), { values: [] }).values).toEqual([
        "x:0",
        "y:1",
        "z:2",
      ]);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});
