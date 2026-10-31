import { afterEach, describe, expect, it, vi } from "vitest";
import { checkCapabilities } from "./init.ts";

afterEach(() => {
  vi.unstubAllGlobals();
});

describe("checkCapabilities", () => {
  it("throws with a descriptive message when required APIs are missing", () => {
    // Node has no OPFS or Web Locks, so this is the failure path.
    expect(() => checkCapabilities()).toThrow(/@dldc\/sync cannot run in this environment/);
    expect(() => checkCapabilities()).toThrow(/Origin Private File System/);
  });

  it("passes when every required API is available", () => {
    vi.stubGlobal("isSecureContext", true);
    vi.stubGlobal("navigator", {
      storage: { getDirectory: () => Promise.resolve({}) },
      locks: { request: () => Promise.resolve(undefined) },
    });
    expect(() => checkCapabilities()).not.toThrow();
  });

  it("reports the specific API that is missing", () => {
    vi.stubGlobal("isSecureContext", true);
    vi.stubGlobal("navigator", {
      storage: { getDirectory: () => Promise.resolve({}) },
    });
    expect(() => checkCapabilities()).toThrow(/Web Locks API/);
  });

  it("reports a non-secure context", () => {
    vi.stubGlobal("isSecureContext", false);
    vi.stubGlobal("navigator", {
      storage: { getDirectory: () => Promise.resolve({}) },
      locks: { request: () => Promise.resolve(undefined) },
    });
    expect(() => checkCapabilities()).toThrow(/secure context/);
  });
});
