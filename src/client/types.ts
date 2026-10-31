import type { SanitizedAction, SanitizedContext, StoredError } from "./storage.ts";

export type TWorkerInMessage =
  | { kind: "Dispatch"; action: SanitizedAction; id?: number; ack?: boolean }
  | { kind: "Terminate" }
  | { kind: "ClearError"; id: string }
  | { kind: "ClearAllErrors" }
  | { kind: "Refresh" }
  | { kind: "ForceRefresh" };

export type TWorkerOutMessage =
  | {
      kind: "Ready";
      context: SanitizedContext;
      database: ArrayBuffer;
      /** Always present: the initial derived, so the client is never null-derived. */
      derived: ArrayBuffer;
    }
  | {
      kind: "Database";
      content: ArrayBuffer;
      dispatchedId?: number;
      /** Present on every snapshot unless the engine runs with `emitDerived: false`. */
      derived?: ArrayBuffer;
    }
  | { kind: "Dispatched"; id: number; ok: boolean }
  | { kind: "DebugState"; outboxCount: number; errors: StoredError[] }
  | { kind: "Reload" }
  | { kind: "SessionExpired" };

/** One entry of the outbox, restored to the app's `Action` type. */
export interface OutboxAction<Action> {
  ts: string;
  action: Action;
}
