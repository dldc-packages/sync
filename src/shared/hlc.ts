export interface HLCTimestamp {
  ts: number; // ms since epoch
  cl: number; // logical counter
}

export interface HLC {
  send(): HLCTimestamp;
}

/**
 * Minimal single-client Hybrid Logical Clock.
 *
 * No `nodeId` in the timestamp (the client never merges remote clocks) and
 * no `receive()` (the client only generates, never receives remote timestamps).
 * Per-client, so cross-client skew doesn't matter.
 */
export function createHLC(initial?: HLCTimestamp | null): HLC {
  let lastTs = initial?.ts ?? 0;
  let lastCl = initial?.cl ?? 0;

  return {
    send(): HLCTimestamp {
      const now = Date.now();
      if (now > lastTs) {
        lastTs = now;
        lastCl = 0;
      } else {
        lastCl += 1;
      }
      return { ts: lastTs, cl: lastCl };
    },
  };
}

export function serializeHLC(ts: HLCTimestamp): string {
  return `${ts.ts}-${String(ts.cl).padStart(8, "0")}`;
}

export function parseHLC(str: string): HLCTimestamp {
  const [tsStr, clStr] = str.split("-");
  return { ts: parseInt(tsStr, 10), cl: parseInt(clStr, 10) };
}

export function compareHLC(a: HLCTimestamp, b: HLCTimestamp): number {
  if (a.ts !== b.ts) return a.ts < b.ts ? -1 : 1;
  if (a.cl !== b.cl) return a.cl < b.cl ? -1 : 1;
  return 0;
}
