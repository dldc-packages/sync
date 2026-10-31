import type { TStoreReducerResult } from "./types";

/** Extract the next state file from a reducer result, ignoring derived. */
export function unwrapReducerState(result: TStoreReducerResult): Uint8Array {
  return result instanceof Uint8Array ? result : result.state;
}

/** True when the reducer result carries a derived value (`{ state, derived }`). */
export function isDerivedResult(
  result: TStoreReducerResult,
): result is { state: Uint8Array; derived: Uint8Array } {
  return !(result instanceof Uint8Array);
}
