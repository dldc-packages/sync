import type { TWorkerOutMessage } from "./types.ts";

/** The one shape every message crossing the worker boundary has: a `kind`
 * string. Sync's own messages use the exact unions in `types.ts`; the
 * transport and any app-level extension route purely on this string. */
export type TWorkerMessage = { kind: string };

/** A message endpoint shared by every layer of the client half:
 *
 * - `emit` feeds a message INTO the logic from the outside — the transport
 *   decodes a `MessageEvent` and emits it;
 * - `onMessage` exposes the messages the logic pushes OUT — the transport
 *   posts them to the other side.
 *
 * Both the worker engine core and the main-thread client core implement it, so
 * a transport is just the code that connects this bus to `postMessage`.
 */
export interface TMessageBus<
  TIn extends TWorkerMessage = TWorkerMessage,
  TOut extends TWorkerMessage = TWorkerMessage,
> {
  emit(message: TIn): void;
  onMessage(handler: (message: TOut) => void): () => void;
}

export type TMessageKindHandler<T extends TWorkerMessage> = (message: T) => void;

/** Routes messages by their exact `kind` to the handlers registered for it.
 * Kinds are matched exactly; a message with no (or a non-string) `kind` — or
 * with a kind no handler registered for — is ignored. */
export interface TMessageRouter<T extends TWorkerMessage = TWorkerMessage> {
  /** Register a handler for one or more exact kinds. Returns an unsubscribe. */
  on(kinds: string | readonly string[], handler: TMessageKindHandler<T>): () => void;
  /** Dispatch a message to every handler registered for its kind. */
  handle(message: unknown): void;
}

export function createMessageRouter<
  T extends TWorkerMessage = TWorkerMessage,
>(): TMessageRouter<T> {
  const handlers = new Map<string, Set<TMessageKindHandler<T>>>();

  return {
    on(kinds, handler) {
      const list = typeof kinds === "string" ? [kinds] : kinds;
      for (const kind of list) {
        let set = handlers.get(kind);
        if (!set) {
          set = new Set();
          handlers.set(kind, set);
        }
        set.add(handler);
      }
      return () => {
        for (const kind of list) {
          handlers.get(kind)?.delete(handler);
        }
      };
    },
    handle(message) {
      const msg = message as Partial<TWorkerMessage> | null;
      if (!msg || typeof msg !== "object" || typeof msg.kind !== "string") {
        return;
      }
      const set = handlers.get(msg.kind);
      if (!set) {
        return;
      }
      for (const handler of set) {
        handler(message as T);
      }
    },
  };
}

/** The fields of a worker→main message that are safe to transfer (and are
 * detached by `postMessage`): the freshly-sliced database buffers on
 * `Ready`/`Database`. The send loops of every transport call this so the byte
 * copies never travel as structured clones. */
export function getMessageTransferables(message: unknown): Transferable[] {
  const msg = message as Partial<TWorkerOutMessage> | null;
  if (!msg || typeof msg !== "object" || typeof msg.kind !== "string") {
    return [];
  }
  if (msg.kind === "Ready" && msg.database) {
    return [msg.database];
  }
  if (msg.kind === "Database" && msg.content) {
    return [msg.content];
  }
  return [];
}
