export type TStoreReducer<Action, Context> = (
  file: Uint8Array,
  context: Context,
  action: Action,
) => Uint8Array;
