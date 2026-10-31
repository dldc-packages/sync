/**
 * Result of a `TStoreReducer` call: either the raw next file (`Uint8Array`, which
 * keeps the previous derived unchanged), or `{ state, derived }` when the
 * reducer also updates the derived value.
 */
export type TStoreReducerResult = Uint8Array | { state: Uint8Array; derived: Uint8Array };

export type TStoreReducer<Action, Context> = (
  file: Uint8Array,
  context: Context,
  action: Action,
  currentDerived: Uint8Array,
) => TStoreReducerResult;

export type TGetStoreReducer<Action, Context> = () => Promise<TStoreReducer<Action, Context>>;

export type TDerive = (state: Uint8Array, prevDerived: Uint8Array) => Uint8Array;

export type TGetDerive = () => Promise<TDerive>;

export type TGetContext<Context> = (signal: AbortSignal) => Promise<Context | null>;

export type TSanitizeContext<Context> = (context: Context) => unknown;

export type TRestoreContext<Context> = (data: unknown) => Context;

export type TSanitizeAction<Action> = (action: Action) => unknown;

export type TRestoreAction<Action> = (data: unknown) => Action;
