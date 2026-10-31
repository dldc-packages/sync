import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname } from "node:path";
import { isDerivedResult } from "../shared/derived.ts";
import type { TDerive, TStoreReducerResult } from "../shared/types.ts";
import type { TStateStore } from "./stateStore.ts";

export interface TDerivedStore {
  getCurrent(): Uint8Array;
  applyReducerResult(result: TStoreReducerResult): void;
  recompute(): void;
}

export interface DerivedStoreParams {
  stateStore: TStateStore;
  derivedFilePath: string;
  derive: TDerive;
}

export function createDerivedStore({
  stateStore,
  derivedFilePath,
  derive,
}: DerivedStoreParams): TDerivedStore {
  // Bootstrap: re-derive from the current state using the persisted bytes as a
  // hint, so a stale file (e.g. a crash between the state and derived writes)
  // self-heals on the next persist
  let derived: Uint8Array = derive(stateStore.getCurrent(), readDerivedFile(derivedFilePath));

  return {
    getCurrent: () => derived,
    applyReducerResult,
    recompute,
  };

  function applyReducerResult(result: TStoreReducerResult): void {
    if (!isDerivedResult(result)) {
      return;
    }
    derived = result.derived;
    writeDerivedFile(derivedFilePath, derived);
  }

  function recompute(): void {
    derived = derive(stateStore.getCurrent(), derived);
    writeDerivedFile(derivedFilePath, derived);
  }
}

function readDerivedFile(path: string): Uint8Array {
  try {
    return readFileSync(path);
  } catch {
    return new Uint8Array(0);
  }
}

function writeDerivedFile(path: string, content: Uint8Array): void {
  try {
    mkdirSync(dirname(path), { recursive: true });
  } catch {
    // directory may already exist and be fine
  }
  writeFileSync(path, content);
}
