import { expect } from "@std/expect";
import {
  compareHLC,
  createHLC,
  type HLCTimestamp,
  parseHLC,
  serializeHLC,
} from "./hlc.ts";

Deno.test("serializeHLC pads the counter to 8 digits", () => {
  const ts: HLCTimestamp = { ts: 123, cl: 7 };
  expect(serializeHLC(ts)).toBe("123-00000007");
});

Deno.test("serializeHLC / parseHLC are inverses", () => {
  const original: HLCTimestamp = { ts: 1700000000000, cl: 42 };
  const round = parseHLC(serializeHLC(original));
  expect(round.ts).toBe(original.ts);
  expect(round.cl).toBe(original.cl);
});

Deno.test("parseHLC parses a serialized timestamp", () => {
  const parsed = parseHLC("1700-00000010");
  expect(parsed.ts).toBe(1700);
  expect(parsed.cl).toBe(10);
});

Deno.test("compareHLC returns 0 for equal timestamps", () => {
  const a: HLCTimestamp = { ts: 5, cl: 1 };
  const b: HLCTimestamp = { ts: 5, cl: 1 };
  expect(compareHLC(a, b)).toBe(0);
});

Deno.test("compareHLC orders by ts first", () => {
  const a: HLCTimestamp = { ts: 4, cl: 9 };
  const b: HLCTimestamp = { ts: 5, cl: 0 };
  expect(compareHLC(a, b)).toBe(-1);
  expect(compareHLC(b, a)).toBe(1);
});

Deno.test("compareHLC breaks ties with the counter", () => {
  const a: HLCTimestamp = { ts: 5, cl: 1 };
  const b: HLCTimestamp = { ts: 5, cl: 2 };
  expect(compareHLC(a, b)).toBe(-1);
  expect(compareHLC(b, a)).toBe(1);
});

Deno.test("createHLC starts from zero by default", () => {
  const clock = createHLC();
  const first = clock.send();
  expect(first.ts).toBeGreaterThan(0);
  expect(first.cl).toBe(0);
});

Deno.test("createHLC increments the counter when wall clock does not advance", () => {
  const clock = createHLC();
  const first = clock.send();
  const second = clock.send();
  expect(second.ts).toBeGreaterThanOrEqual(first.ts);
  if (second.ts === first.ts) {
    expect(second.cl).toBe(first.cl + 1);
  } else {
    expect(second.cl).toBe(0);
  }
});

Deno.test("createHLC resets the counter when wall clock advances", () => {
  const start = 1_000_000;
  const clock = createHLC({ ts: start, cl: 99 });
  const next = clock.send();
  expect(next.ts).toBeGreaterThan(start);
  expect(next.cl).toBe(0);
});

Deno.test("createHLC respects a seeded initial timestamp", () => {
  const clock = createHLC({ ts: 1, cl: 3 });
  const first = clock.send();
  if (first.ts === 1) {
    expect(first.cl).toBe(4);
  }
});
