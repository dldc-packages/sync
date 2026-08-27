import {
  createRestore,
  createSanitize,
  createTypedKey,
  createTypedMap,
  type ICustomType,
  type restore as zenjsonRestore,
  type sanitize as zenjsonSanitize,
} from "@dldc/zenjson";
import { ALL_TYPES as ALL_TYPES_BASE } from "../../shared/transport/zenjson.ts";

const transferableKey = createTypedKey<Transferable[]>("transferable");

const arrayBufferTypes: ICustomType<ArrayBuffer, ArrayBuffer> = {
  name: "arrayBuffer",
  check: (val) => val instanceof ArrayBuffer,
  restore: (val) => val,
  sanitize: (val, { state }) => {
    state.getOrDefault(transferableKey, []).push(val);
    return val;
  },
};

const ALL_TYPES = [
  ...ALL_TYPES_BASE,
  arrayBufferTypes,
];

const restore: typeof zenjsonRestore = createRestore(ALL_TYPES);

const sanitize: typeof zenjsonSanitize = createSanitize(ALL_TYPES);

export function encodeMessage(
  message: unknown,
): [data: unknown, transfer: Transferable[]] {
  const state = createTypedMap();
  const data = sanitize(message, state);
  const transfer = state.getOrDefault(transferableKey, []);
  return [data, transfer];
}

export function decodeMessage(data: unknown): unknown {
  return restore(data);
}
