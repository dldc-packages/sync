import type { TSubscriptionCallback, TUnsubscribe } from "@dldc/pubsub";
import * as v from "valibot";
import { unwrapReducerState } from "../shared/derived.ts";
import { fileSyncTransportWriter } from "../shared/fileSync.ts";
import type {
  TDerive,
  TGetDerive,
  TGetStoreReducer,
  TRestoreAction,
  TStoreReducerResult,
} from "../shared/types.ts";
import { createDerivedStore } from "./derivedStore.ts";
import { createStateStore, type TStateStoreEvent, type TStoreUpdateContext } from "./stateStore.ts";
import { createStateDb } from "./stateDb.ts";

export interface TStore<Context> {
  sync(clientSignature: Uint8Array, clientId: string, signal: AbortSignal): Response;
  dispatch(bodyJson: unknown, clientId: string, context: Context): Response;
  getCurrent: () => Uint8Array;
  update(updater: (current: Uint8Array) => Uint8Array, context: TStoreUpdateContext): void;
  /**
   * Subscribe to every applied update — a client dispatch that the reducer
   * applied, or a server-side `update`. The event is emitted once the new
   * bytes are written, so `getCurrent()` inside the callback already returns
   * them. Returns an unsubscribe function.
   */
  subscribe(callback: TSubscriptionCallback<TStateStoreEvent>): TUnsubscribe;
}

export interface StoreParams<Action, Context> {
  metaFilePath: string;
  stateFilePath: string;
  derivedFilePath: string;
  restoreAction: TRestoreAction<Action>;
  getReducer: TGetStoreReducer<Action, Context>;
  getDerive: TGetDerive;
}

const vDispatchRequest = v.object({
  action: v.any(),
  ts: v.string(),
});

export async function createStore<Action, Context>({
  metaFilePath,
  stateFilePath,
  derivedFilePath,
  restoreAction,
  getReducer,
  getDerive,
}: StoreParams<Action, Context>): Promise<TStore<Context>> {
  const stateDb = await createStateDb({ metaFilePath });
  const stateStore = createStateStore({
    getDbVersion: stateDb.getDbVersion,
    setDbVersion: stateDb.setDbVersion,
    stateFilePath,
  });
  const reducer = await getReducer();
  const derive: TDerive = await getDerive();
  const derivedStore = createDerivedStore({
    stateStore,
    derivedFilePath,
    derive,
  });

  return {
    dispatch,
    sync,
    getCurrent: () => stateStore.getCurrent(),
    update,
    subscribe: (callback) => stateStore.subscribe(callback),
  };

  function sync(clientSignature: Uint8Array, clientId: string, signal: AbortSignal): Response {
    // compare() returns { patch, version } atomically — version is captured at
    // comparison time, avoiding a race where getVersion() could change between
    // the compare and the UpToDate message
    const { patch: initialPatch, version: initialVersion } = stateStore.compare(
      clientSignature, // new Uint8Array(reqBody),
    );
    // Read once at connection time, then maintain in-memory via the subscribe
    // callback. This avoids a DB read on every patch emission and ensures the
    // clientLastApplied is atomic with the patch (the event carries the clientId
    // + ts of the dispatching client, threaded through Store.update).
    let clientLastApplied = stateDb.getClientLastApplied(clientId);

    const body = new ReadableStream<Uint8Array>({
      start(controller) {
        const writer = fileSyncTransportWriter({
          write: controller.enqueue.bind(controller),
        });
        writer({ name: "Connected", data: null });
        if (initialPatch === null) {
          writer({
            name: "UpToDate",
            data: { version: initialVersion, clientLastApplied },
          });
        } else {
          writer({
            name: "InitialPatch",
            data: {
              patch: new Uint8Array(initialPatch),
              version: initialVersion,
              clientLastApplied,
            },
          });
        }
        const unsub = stateStore.subscribe((event) => {
          // Update the in-memory variable only if this patch was triggered by
          // this client's dispatch. Otherwise keep the existing value — a
          // dispatch from another client changes the DB content but not THIS
          // client's clientLastApplied.
          if (event.clientId === clientId) {
            clientLastApplied = event.clientLastApplied;
          }
          writer({
            name: "Patch",
            data: {
              patch: event.patch,
              version: event.version,
              clientLastApplied,
            },
          });
        });

        signal.addEventListener("abort", () => {
          unsub();
          controller.close();
        });
      },
    });

    return new Response(body, {
      headers: {
        Connection: "keep-alive",
        "Content-Type": "application/octet-stream",
        "Cache-Control": "no-transform",
      },
    });
  }

  function dispatch(bodyJson: unknown, clientId: string, context: Context): Response {
    const { action: actionAny, ts } = v.parse(vDispatchRequest, bodyJson);
    const action = restoreAction(actionAny);

    // Idempotency: skip if already applied
    const isNew = stateDb.updateClientLastApplied(clientId, ts);
    if (!isNew) {
      return jsonResponse({ status: "ok", applied: false }); // already applied, dedup
    }

    let result: TStoreReducerResult | undefined;
    stateStore.update(
      (current) => {
        const next = reducer(current, context, action, derivedStore.getCurrent());
        result = next;
        return unwrapReducerState(next);
      },
      { clientId, clientLastApplied: ts },
    );

    if (result !== undefined) {
      derivedStore.applyReducerResult(result);
    }
    return jsonResponse({ status: "ok", applied: true });
  }

  function update(
    updater: (current: Uint8Array) => Uint8Array,
    context: TStoreUpdateContext,
  ): void {
    stateStore.update((current) => updater(current), context);
    derivedStore.recompute();
  }

  function jsonResponse(data: unknown, status = 200) {
    return new Response(JSON.stringify(data), {
      status, // optional
      headers: { "Content-Type": "application/json" },
    });
  }
}
