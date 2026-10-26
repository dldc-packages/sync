import type { SanitizedAction, SanitizedContext, StoredError } from "./opfs.ts";

export type TWorkerInMessage =
  | { kind: "Dispatch"; action: SanitizedAction; id?: number; ack?: boolean }
  | { kind: "Terminate" }
  | { kind: "ClearError"; id: string }
  | { kind: "ClearAllErrors" }
  | { kind: "Refresh" }
  | { kind: "ForceRefresh" };

export type TWorkerOutMessage =
  | { kind: "Ready"; context: SanitizedContext; database: ArrayBuffer }
  | {
      kind: "Database";
      content: ArrayBuffer;
      dispatchedId?: number;
    }
  | { kind: "Dispatched"; id: number; ok: boolean }
  | { kind: "DebugState"; pendingCount: number; errors: StoredError[] }
  | { kind: "Reload" }
  | { kind: "SessionExpired" };

export interface PendingAction<Action> {
  ts: string;
  action: Action;
}
