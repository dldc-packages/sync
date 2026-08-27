export type TStoreReducer<Action, Context> = (
  file: Uint8Array,
  context: Context,
  action: Action,
) => Uint8Array;

export type TGetStoreReducer<Action, Context> = () => Promise<
  TStoreReducer<Action, Context>
>;
