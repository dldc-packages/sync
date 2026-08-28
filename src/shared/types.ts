export type TStoreReducer<Action, Context> = (
  file: Uint8Array,
  context: Context,
  action: Action,
) => Uint8Array;

export type TGetStoreReducer<Action, Context> = () => Promise<
  TStoreReducer<Action, Context>
>;

export type TGetContext<Context> = (
  signal: AbortSignal,
) => Promise<Context | null>;

export type TSanitizeContext<Context> = (context: Context) => unknown;

export type TRestoreContext<Context> = (data: unknown) => Context;

export type TSanitizeAction<Action> = (action: Action) => unknown;

export type TRestoreAction<Action> = (data: unknown) => Action;
