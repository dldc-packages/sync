import type { StoredError } from "./opfs.ts";

export type TWorkerInMessage<Action> =
  | { kind: "Dispatch"; action: Action }
  | {
    kind: "Terminate";
  }
  | { kind: "ClearError"; id: string }
  | { kind: "ClearAllErrors" }
  | { kind: "Refresh" }
  | { kind: "ForceRefresh" };

export type TWorkerOutMessage<Context> =
  // me: TUser;
  | { kind: "Ready"; context: Context; database: ArrayBuffer }
  | { kind: "Database"; content: ArrayBuffer }
  | { kind: "DebugState"; pendingCount: number; errors: StoredError[] }
  | { kind: "Reload" }
  | { kind: "SessionExpired" };

export type TGetContext<Context> = (
  signal: AbortSignal,
) => Promise<Context | null>;
export type TSanitizeContext<Context> = (
  context: Context,
) => Promise<unknown> | unknown;
export type TRestoreContext<Context> = (
  data: unknown,
) => Promise<Context | null>;
