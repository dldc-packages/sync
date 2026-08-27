import type { TStoreReducer } from "../shared/types.ts";
import type { DispatchResult, OpfsClient, PendingAction } from "./opfs.ts";

export interface Store<Action> {
  applyPatch(
    version: string,
    patch: Uint8Array | null,
    clientLastApplied: string | null,
  ): Promise<void>;
  applyDispatchResult(result: DispatchResult<Action>): void;
  refreshFromOpfs(): Promise<void>;
  getServerContent(): Uint8Array;
  getLocalContent(): Uint8Array;
  getServerVersion(): string | null;
}

export interface StoreParams<Action, Context> {
  context: Context;
  initialServerVersion: string | null;
  initialPending: PendingAction<Action>[];
  initialDatabase: Uint8Array;
  opfsClient: OpfsClient<Action, Context>;
  reducer: TStoreReducer<Action, Context>;
  onDatabase: (content: Uint8Array) => void;
  onStateChange: (pendingCount: number) => void;
}

export function createStore<Action, Context>(
  {
    context,
    initialServerVersion,
    initialPending,
    initialDatabase,
    opfsClient,
    reducer,
    onDatabase,
    onStateChange,
  }: StoreParams<Action, Context>,
): Store<Action> {
  let serverContent: Uint8Array = initialDatabase;
  let serverVersion: string | null = initialServerVersion;
  let pending: PendingAction<Action>[] = initialPending;
  let localContent = rebase(serverContent, pending);

  return {
    applyPatch,
    applyDispatchResult,
    refreshFromOpfs,
    getServerContent: () => serverContent,
    getLocalContent: () => localContent,
    getServerVersion: () => serverVersion,
  };

  async function applyPatch(
    version: string,
    patch: Uint8Array | null,
    clientLastApplied: string | null,
  ) {
    const result = await opfsClient.applyPatchInLock(
      version,
      patch,
      clientLastApplied,
    );
    if (result.serverContent !== null) {
      serverContent = result.serverContent;
      serverVersion = result.serverVersion;
    }
    pending = result.pending;

    // Rebase: reapply remaining pending on top of serverContent
    localContent = rebase(serverContent, pending);
    onDatabase(localContent);
    onStateChange(pending.length);
  }

  function applyDispatchResult(result: DispatchResult<Action>) {
    applyStateChange(
      result.serverContent,
      result.serverVersion,
      result.pending,
    );
  }

  async function refreshFromOpfs() {
    const result = await opfsClient.refreshState(serverVersion);
    applyStateChange(
      result.serverContent,
      result.serverVersion,
      result.pending,
    );
  }

  /**
   * Shared logic for dispatch results and cross-tab refreshes.
   *
   * Incremental path: if the server did not change and the previous pending
   * list is a prefix of the new one (only appends), apply just the
   * newly-appended actions on top of the current localContent instead of
   * rebasing everything from serverContent. If nothing changed at all
   * (appended is empty), skip the database emission entirely.
   */
  function applyStateChange(
    newServerContent: Uint8Array | null,
    newServerVersion: string,
    newPending: PendingAction<Action>[],
  ) {
    if (newServerContent !== null) {
      serverContent = newServerContent;
      serverVersion = newServerVersion;
    }

    // Incremental path: server unchanged, pending only grew
    if (newServerContent === null) {
      const appended = appendedPending(pending, newPending);
      if (appended !== null) {
        if (appended.length === 0) return; // nothing changed
        pending = newPending;
        localContent = rebase(localContent, appended);
        onDatabase(localContent);
        onStateChange(pending.length);
        return;
      }
    }

    // Fallback: full rebase of all pending on top of serverContent.
    pending = newPending;
    localContent = rebase(serverContent, pending);
    onDatabase(localContent);
    onStateChange(pending.length);
  }

  /**
   * Reapply all pending actions on top of serverContent.
   *
   * Each `reducer()` call deserializes -> applies -> exports. For N pending
   * actions this is O(N x DB_size); acceptable for small pending lists.
   */
  function rebase(
    content: Uint8Array,
    pendingActions: PendingAction<Action>[],
  ): Uint8Array {
    if (pendingActions.length === 0) return content;
    let result = content;
    for (const { action } of pendingActions) {
      result = reducer(result, context, action);
    }
    return result;
  }

  /**
   * If `next` is exactly `prev` with extra actions appended (prev is a prefix,
   * matched by ts), return the appended tail. Otherwise return null.
   */
  function appendedPending(
    prev: PendingAction<Action>[],
    next: PendingAction<Action>[],
  ): PendingAction<Action>[] | null {
    if (next.length < prev.length) return null;
    for (let i = 0; i < prev.length; i++) {
      if (prev[i].ts !== next[i].ts) return null;
    }
    return next.slice(prev.length);
  }
}
