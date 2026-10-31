import { describe, expect, it } from "vitest";
import { diff, signature } from "@dldc/librsync";
import type { TDerive, TStoreReducer } from "../shared/types.ts";
import type { Bookkeeping, SanitizedOutboxAction, Storage } from "./storage.ts";
import { createStore } from "./store.ts";

type Action = { kind: "add"; id: string } | { kind: "toggle"; id: string };
type Context = Record<never, never>;

interface TestState {
  items: { id: string; done: boolean }[];
}
interface TestDerived {
  done: number;
}

const encode = <T>(value: T): Uint8Array => new TextEncoder().encode(JSON.stringify(value));
const decode = <T>(bytes: Uint8Array, fallback: T): T => {
  if (bytes.byteLength === 0) return fallback;
  return JSON.parse(new TextDecoder().decode(bytes)) as T;
};
const decodeDone = (bytes: Uint8Array): number => decode<TestDerived>(bytes, { done: 0 }).done;

/** Derived-aware reducer: maintains a `{ done }` counter next to the state. */
const derivedReducer: TStoreReducer<Action, Context> = (file, _ctx, action, currentDerived) => {
  const state = decode<TestState>(file, { items: [] });
  const derived = decode<TestDerived>(currentDerived, { done: 0 });
  if (action.kind === "add") {
    state.items.push({ id: action.id, done: false });
  } else {
    const item = state.items.find((i) => i.id === action.id);
    if (item) {
      item.done = !item.done;
      derived.done += item.done ? 1 : -1;
    }
  }
  return { state: encode(state), derived: encode(derived) };
};

/** Recompute the derived counter from the state (ignores `prevDerived`). */
const rebuildDerive: TDerive = (file) => {
  const state = decode<TestState>(file, { items: [] });
  return encode<TestDerived>({ done: state.items.filter((i) => i.done).length });
};

/**
 * Derive that trusts a non-empty `prevDerived` and only recomputes from the
 * state when given an empty hint — simulates an incremental derive holding a
 * stale value that content changes alone never self-heal.
 */
const stickyDerive: TDerive = (file, prevDerived) => {
  if (prevDerived.byteLength > 0) {
    return prevDerived;
  }
  const state = decode<TestState>(file, { items: [] });
  return encode<TestDerived>({ done: state.items.filter((i) => i.done).length });
};

/** Non-derived-aware reducer: returns only the next state. */
const plainReducer: TStoreReducer<Action, Context> = (file, _ctx, action) => {
  const state = decode<TestState>(file, { items: [] });
  if (action.kind === "add") {
    state.items.push({ id: action.id, done: false });
  } else {
    const item = state.items.find((i) => i.id === action.id);
    if (item) item.done = !item.done;
  }
  return encode(state);
};

const EMPTY = new Uint8Array(0);

// A lock that just runs the function — the store's lock ownership is what we
// exercise; the mutual exclusion across tabs is `navigator.locks`, not testable here.
const passThroughLock = <T>(_name: string, fn: () => Promise<T>): Promise<T> => fn();

const sanitizedOf = (action: Action, n: number): SanitizedOutboxAction => ({
  ts: `ts-${n}`,
  action: { _action: action },
  sent: false,
});

/** Wrap a plain action in the sanitized wire form the store dispatches. */
const dispatchSanitized = (action: Action) => ({ _action: action });

/** In-memory `Storage` fake: the single source of truth for the store under test. */
function createStorageMock(initial: {
  serverVersion?: string | null;
  state?: Uint8Array;
  derived?: Uint8Array;
  outbox?: SanitizedOutboxAction[];
}) {
  let meta: Bookkeeping = {
    clientId: "client",
    hlc: null,
    outbox: initial.outbox ?? [],
    errors: [],
    serverVersion: initial.serverVersion ?? null,
    context: null,
  };
  let state = initial.state ?? EMPTY;
  let derived = initial.derived ?? EMPTY;
  const derivedWrites: Uint8Array[] = [];

  const storage: Storage = {
    readMeta: async () => meta,
    writeMeta: async (m) => {
      meta = m;
    },
    readState: async () => state,
    writeState: async (d) => {
      state = d;
    },
    readDerived: async () => derived,
    writeDerived: async (d) => {
      derivedWrites.push(d);
      derived = d;
    },
    deleteState: async () => {
      state = EMPTY;
    },
  };

  return {
    storage,
    derivedWrites,
    get meta() {
      return meta;
    },
    get state() {
      return state;
    },
    /** Simulate another tab having committed a new server content + version. */
    setServerContent: async (
      content: Uint8Array,
      version: string,
      outbox: SanitizedOutboxAction[],
    ) => {
      state = content;
      meta.serverVersion = version;
      meta.outbox = outbox;
    },
  };
}

function makeStore(opts: {
  initialState?: Uint8Array;
  initialOutbox?: SanitizedOutboxAction[];
  derive?: TDerive;
  reducer?: TStoreReducer<Action, Context>;
  serverVersion?: string;
}) {
  const serverVersion = opts.serverVersion ?? "s0";
  const initialState = opts.initialState ?? EMPTY;
  const fake = createStorageMock({ serverVersion, state: initialState });
  const snapshots: Array<{ content: Uint8Array; derived: Uint8Array; dispatchId?: number }> = [];
  const store = createStore<Action, Context>({
    context: {},
    initialServerVersion: serverVersion,
    initialOutbox: opts.initialOutbox ?? [],
    initialState: initialState,
    initialDerived: EMPTY,
    storage: fake.storage,
    opfsLockName: "test-lock",
    lock: passThroughLock,
    maxStoredErrors: 20,
    restoreAction: (data) => data as Action,
    reducer: opts.reducer ?? derivedReducer,
    derive: opts.derive ?? rebuildDerive,
    onState: (content, derived, dispatchId) => {
      snapshots.push({ content, derived, dispatchId });
    },
    onStateChange: () => {},
  });
  // NOTE: return live getters — spreading `fake` would snapshot the getter
  // values (e.g. `state`) at construction time.
  return {
    store,
    storage: fake.storage,
    derivedWrites: fake.derivedWrites,
    setServerContent: fake.setServerContent,
    get state() {
      return fake.state;
    },
    get meta() {
      return fake.meta;
    },
    snapshots,
  };
}

describe("createStore (owns the OPFS lock)", () => {
  it("derives the initial derived from the state and replays the outbox on top", () => {
    const initialState = encode<TestState>({ items: [{ id: "a", done: true }] });
    const { store } = makeStore({
      initialState,
      initialOutbox: [sanitizedOf({ kind: "add", id: "b" }, 1)],
      derive: rebuildDerive,
    });

    // derived = server derived (1 done) with outbox replayed (add b: no change)
    expect(decodeDone(store.getDerived())).toBe(1);
    // local content includes the outbox add
    const local = decode<TestState>(store.getState(), { items: [] });
    expect(local.items.some((i) => i.id === "b")).toBe(true);
    expect(store.getServerState()).toBe(initialState);
  });

  it("updates derived optimistically on dispatch and never persists", async () => {
    const { store, derivedWrites, snapshots } = makeStore({ derive: rebuildDerive });

    await store.dispatch(dispatchSanitized({ kind: "add", id: "a" }));
    await store.dispatch(dispatchSanitized({ kind: "toggle", id: "a" }));

    expect(decodeDone(store.getDerived())).toBe(1); // a added + toggled → done
    const last = snapshots.at(-1)!;
    expect(decodeDone(last.derived!)).toBe(1);
    // no server content change → nothing is persisted
    expect(derivedWrites).toHaveLength(0);
  });

  it("persists the outbox on dispatch and exposes the sent lifecycle", async () => {
    const { store, meta } = makeStore({});
    await store.dispatch(dispatchSanitized({ kind: "add", id: "a" }));

    expect(meta.outbox).toHaveLength(1);
    expect(meta.outbox[0].sent).toBe(false);

    const unsent = await store.getNextUnsent();
    expect(unsent?.ts).toBe(meta.outbox[0].ts);

    await store.markOutboxAsSent(unsent!.ts);
    expect(meta.outbox[0].sent).toBe(true);
    expect(await store.getNextUnsent()).toBeNull();
  });

  it("applies a real rsync patch, commits the content and persists derived", async () => {
    const serverOld = encode<TestState>({ items: [] });
    const serverNew = encode<TestState>({ items: [{ id: "a", done: true }] });
    const { store, meta, derivedWrites, storage } = makeStore({
      initialState: serverOld,
      serverVersion: "s0",
      derive: rebuildDerive,
    });

    // optimistic add + toggle (outbox, never persisted)
    await store.dispatch(dispatchSanitized({ kind: "add", id: "a" }));
    await store.dispatch(dispatchSanitized({ kind: "toggle", id: "a" }));
    expect(decodeDone(store.getDerived())).toBe(1);
    expect(derivedWrites).toHaveLength(0);

    // server applies both actions and sends a real rsync patch; the
    // clientLastApplied acknowledges both local actions so they leave the outbox
    const lastTs = meta.outbox[1].ts;
    const patch = diff(signature(serverOld), serverNew);
    await store.applyPatch("v1", patch, lastTs);

    // the OPFS state file is patched into the new content
    expect((await storage.readState()).toString()).toBe(serverNew.toString());
    expect(store.getServerState().toString()).toBe(serverNew.toString());
    expect(meta.serverVersion).toBe("v1");
    expect(meta.outbox).toHaveLength(0);
    // derived re-derived from the new server content and persisted
    expect(decodeDone(store.getDerived())).toBe(1);
    expect(derivedWrites).toHaveLength(1);
    expect(decodeDone(derivedWrites[0])).toBe(1);
  });

  it("drops acked outbox actions when the server acknowledges them", async () => {
    const serverOld = encode<TestState>({ items: [] });
    const { store, meta } = makeStore({ initialState: serverOld, serverVersion: "s0" });

    await store.dispatch(dispatchSanitized({ kind: "add", id: "a" }));
    await store.dispatch(dispatchSanitized({ kind: "toggle", id: "a" }));
    expect(meta.outbox).toHaveLength(2);

    // UpToDate with clientLastApplied covering both actions
    await store.applyPatch("v1", null, meta.outbox[1].ts);
    expect(meta.outbox).toHaveLength(0);
  });

  it("dedups a patch version another tab already handled", async () => {
    const serverNew = encode<TestState>({ items: [{ id: "a", done: true }] });
    // The store starts having only fetched s0, but another tab already
    // committed v1 to disk (state + meta).
    const fake = createStorageMock({ state: serverNew, serverVersion: "v1", outbox: [] });
    const store = createStore<Action, Context>({
      context: {},
      initialServerVersion: "s0",
      initialOutbox: [],
      initialState: EMPTY,
      initialDerived: EMPTY,
      storage: fake.storage,
      opfsLockName: "test-lock",
      lock: passThroughLock,
      maxStoredErrors: 20,
      restoreAction: (data) => data as Action,
      reducer: derivedReducer,
      derive: rebuildDerive,
      onState: () => {},
      onStateChange: () => {},
    });

    // Applying the "v1" patch on top of a meta that already points at v1 hits
    // the dedup path: read the fresh state, re-derive + persist, no double-apply.
    await store.applyPatch("v1", null, null);
    expect(store.getServerState().toString()).toBe(serverNew.toString());
    expect(fake.derivedWrites).toHaveLength(1);
    expect(decodeDone(fake.derivedWrites[0])).toBe(1);
  });

  it("keeps the derived from derive when the reducer is not derived-aware", async () => {
    const { store } = makeStore({ derive: rebuildDerive, reducer: plainReducer });

    await store.dispatch(dispatchSanitized({ kind: "toggle", id: "a" }));

    // The plain reducer never updates derived, so it stays at derive(serverContent) = 0
    expect(decodeDone(store.getDerived())).toBe(0);
  });

  it("always computes a derived, even when the reducer is not derived-aware", async () => {
    const serverOld = encode<TestState>({ items: [] });
    const serverNew = encode<TestState>({ items: [{ id: "a", done: true }] });
    const { store, derivedWrites, storage } = makeStore({
      initialState: serverOld,
      derive: rebuildDerive,
      reducer: plainReducer,
    });

    // derived is non-null from boot
    expect(store.getDerived()).toBeInstanceOf(Uint8Array);
    expect(decodeDone(store.getDerived())).toBe(0);

    // optimistic dispatch: the plain reducer doesn't touch derived, so it stays
    // at derive(serverContent) — still non-null, and never persisted (optimistic)
    await store.dispatch(dispatchSanitized({ kind: "add", id: "a" }));
    expect(store.getDerived()).toBeInstanceOf(Uint8Array);
    expect(decodeDone(store.getDerived())).toBe(0);
    expect(derivedWrites).toHaveLength(0);

    // a real patch updates the state and recommits the derived for the new content
    const patch = diff(signature(serverOld), serverNew);
    await store.applyPatch("v1", patch, null);
    expect((await storage.readState()).toString()).toBe(serverNew.toString());
    expect(decodeDone(store.getDerived())).toBe(1);
    expect(derivedWrites).toHaveLength(1);
    expect(decodeDone(derivedWrites[0])).toBe(1);
  });

  it("picks up another tab's committed content on refreshFromOpfs", async () => {
    const serverNew = encode<TestState>({ items: [{ id: "a", done: true }] });
    const { store, derivedWrites, setServerContent, meta } = makeStore({
      serverVersion: "s0",
      derive: rebuildDerive,
    });

    // this tab dispatchs an optimistic add; the server hasn't changed yet
    await store.dispatch(dispatchSanitized({ kind: "add", id: "b" }));
    expect(store.getServerState().byteLength).toBe(0);
    expect(derivedWrites).toHaveLength(0);

    // another tab applies a patch: state + version on the shared files change,
    // but this tab's unacked actions stay in the shared outbox
    await setServerContent(serverNew, "v1", [...meta.outbox]);

    // the broadcast-channel wake drives the other tabs to refreshFromOpfs
    await store.refreshFromOpfs();

    expect(store.getServerState().toString()).toBe(serverNew.toString());
    // the locally outboxed add b is still replayed on top of the new content
    const local = decode<TestState>(store.getState(), { items: [] });
    expect(local.items.find((i) => i.id === "b")).toBeTruthy();
    expect(decodeDone(store.getDerived())).toBe(1);
    // derived for the new server content was computed and persisted
    expect(derivedWrites.length).toBeGreaterThan(0);
  });

  it("forceRecomputeDerived rebuilds the derived from scratch, ignoring the current value", async () => {
    const serverState = encode<TestState>({
      items: [
        { id: "a", done: true },
        { id: "b", done: true },
      ],
    });
    const stale = encode<TestDerived>({ done: 99 });
    const outboxAction = sanitizedOf({ kind: "toggle", id: "a" }, 1);
    const fake = createStorageMock({
      state: serverState,
      serverVersion: "s0",
      outbox: [outboxAction],
      derived: stale,
    });
    const snapshots: Array<{ content: Uint8Array; derived: Uint8Array }> = [];
    const store = createStore<Action, Context>({
      context: {},
      initialServerVersion: "s0",
      // an optimistic toggle on a -> the live derived diverges from the committed one
      initialOutbox: [outboxAction],
      initialState: serverState,
      initialDerived: stale,
      storage: fake.storage,
      opfsLockName: "test-lock",
      lock: passThroughLock,
      maxStoredErrors: 20,
      restoreAction: (data) => data as Action,
      reducer: derivedReducer,
      derive: stickyDerive,
      onState: (content, derived) => snapshots.push({ content, derived }),
      onStateChange: () => {},
    });

    // boot: stickyDerive trusts the stale hint (99) and the outbox toggle
    // brings the live derived down to 98 — nothing self-heals
    expect(decodeDone(store.getDerived())).toBe(98);

    await store.forceRecomputeDerived();

    // derived rebuilt from the state: 2 done on the server, minus the
    // optimistic toggle on a replayed on top = 1
    expect(decodeDone(store.getDerived())).toBe(1);
    const local = decode<TestState>(store.getState(), { items: [] });
    expect(local.items.find((i) => i.id === "a")!.done).toBe(false);
    // the persisted file only holds the committed derived (2), not the replay
    expect(fake.derivedWrites.at(-1)).toBeDefined();
    expect(decodeDone(fake.derivedWrites.at(-1)!)).toBe(2);
    // the snapshot delivered to the subscribers carries the fresh live derived
    const last = snapshots.at(-1)!;
    expect(decodeDone(last.derived)).toBe(1);
  });
});
