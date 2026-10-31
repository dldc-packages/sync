import { describe, expect, it } from "vitest";
import { isDerivedResult, unwrapReducerState } from "./derived.ts";

const state = new Uint8Array([1, 2, 3]);
const derived = new Uint8Array([4, 5]);

describe("unwrapReducerState", () => {
  it("returns the raw bytes when the reducer result is a Uint8Array", () => {
    expect(unwrapReducerState(state)).toBe(state);
  });

  it("returns only the state when the result carries a derived value", () => {
    expect(unwrapReducerState({ state, derived })).toBe(state);
  });
});

describe("isDerivedResult", () => {
  it("is false for a plain Uint8Array result", () => {
    expect(isDerivedResult(state)).toBe(false);
  });

  it("is true for a { state, derived } result", () => {
    expect(isDerivedResult({ state, derived })).toBe(true);
  });
});
