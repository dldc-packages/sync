import { describe, expect, it } from "vitest";
import { assertOk, UnauthorizedError } from "./errors.ts";

describe("assertOk", () => {
  it("does not throw when the response is ok", () => {
    expect(() => assertOk({ ok: true, status: 200 } as Response)).not.toThrow();
  });

  it("throws UnauthorizedError on a 401", () => {
    expect(() => assertOk({ ok: false, status: 401 } as Response)).toThrow(UnauthorizedError);
  });

  it("throws a generic error with the status on other failures", () => {
    try {
      assertOk({ ok: false, status: 500 } as Response);
      throw new Error("should have thrown");
    } catch (err) {
      expect(err).toBeInstanceOf(Error);
      expect((err as Error).message).toContain("500");
      expect(err).not.toBeInstanceOf(UnauthorizedError);
    }
  });
});

describe("UnauthorizedError", () => {
  it("is an Error with the right name and a helpful message", () => {
    const err = new UnauthorizedError();
    expect(err).toBeInstanceOf(Error);
    expect(err.name).toBe("UnauthorizedError");
    expect(err.message).toContain("401");
  });
});
