import * as v from "@valibot/valibot";
import { fileSyncTransportWriter } from "../shared/transport/fileSync.ts";
import { restore } from "../shared/transport/zenjson.ts";
import type { TGetStoreReducer } from "../shared/types.ts";
import { createFileStore, type TStoreUpdateContext } from "./fileStore.ts";
import { createStateDb } from "./stateDb.ts";

export interface TStore<Context> {
  sync(
    clientSignature: Uint8Array,
    clientId: string,
    signal: AbortSignal,
  ): Response;
  dispatch(
    bodyJson: unknown,
    clientId: string,
    context: Context,
  ): Response;
  getCurrent: () => Uint8Array;
  update(
    updater: (current: Uint8Array) => Uint8Array,
    context: TStoreUpdateContext,
  ): void;
}

export interface StoreParams<Action, Context> {
  stateDatabasePath: string;
  filePath: string;
  actionSchema: v.GenericSchema<Action>;
  getReducer: TGetStoreReducer<Action, Context>;
}

export const vDispatchRequest = v.object({
  action: v.any(),
  ts: v.string(),
});

export async function createStore<Action, Context>(
  { stateDatabasePath, filePath, getReducer, actionSchema }: StoreParams<
    Action,
    Context
  >,
): Promise<TStore<Context>> {
  const stateDb = await createStateDb({ stateDatabasePath });
  const fileStore = createFileStore({
    filePath,
    getDbVersion: stateDb.getDbVersion,
    setDbVersion: stateDb.setDbVersion,
  });
  const reducer = await getReducer();

  return {
    dispatch,
    sync,
    getCurrent: fileStore.getCurrent,
    update: fileStore.update,
  };

  function sync(
    clientSignature: Uint8Array,
    clientId: string,
    signal: AbortSignal,
  ): Response {
    // compare() returns { patch, version } atomically — version is captured at
    // comparison time, avoiding a race where getVersion() could change between
    // the compare and the UpToDate message
    const { patch: initialPatch, version: initialVersion } = fileStore.compare(
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
        const unsub = fileStore.subscribe((event) => {
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
        "Connection": "keep-alive",
        "Content-Type": "application/octet-stream",
        "Cache-Control": "no-transform",
      },
    });
  }

  function dispatch(
    bodyJson: unknown,
    clientId: string,
    context: Context,
  ): Response {
    const decoded = restore(bodyJson);
    const { action: actionAny, ts } = v.parse(vDispatchRequest, decoded);
    const action = v.parse(actionSchema, actionAny);

    // Idempotency: skip if already applied
    const isNew = stateDb.updateClientLastApplied(clientId, ts);
    if (!isNew) {
      return jsonResponse({ status: "ok", applied: false }); // already applied, dedup
    }

    fileStore.update(
      (current) => reducer(current, context, action),
      { clientId, clientLastApplied: ts },
    );
    return jsonResponse({ status: "ok", applied: true });

    // return dispatchHandler(fileStore, clientId, reducer, context, action, ts);
  }

  function jsonResponse(data: unknown, status = 200) {
    return new Response(JSON.stringify(data), {
      status, // optional
      headers: { "Content-Type": "application/json" },
    });
  }
}
