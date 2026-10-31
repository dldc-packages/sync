import { describe, expect, it } from "vitest";
import {
  streamTransportReadAll,
  streamTransportReader,
  streamTransportWriteAll,
  streamTransportWriter,
  type TStreamReader,
} from "./stream.ts";

interface Message {
  name: string;
  data: unknown;
}

/** A TStreamReader that yields fixed chunks then signals EOF. */
function readerFromChunks(chunks: Uint8Array[]): TStreamReader {
  let i = 0;
  return {
    read: async () => {
      if (i >= chunks.length) return { done: true, value: new Uint8Array(0) };
      return { done: false, value: chunks[i++] };
    },
  };
}

async function collect<M>(iterable: AsyncIterable<M>): Promise<M[]> {
  const out: M[] = [];
  for await (const message of iterable) out.push(message);
  return out;
}

const CONNECTED: Message = { name: "Connected", data: null };

describe("streamTransportWriteAll / streamTransportReadAll", () => {
  it("round-trips multiple messages, preserving binary payloads", () => {
    const messages: Message[] = [
      { name: "Connected", data: null },
      {
        name: "InitialPatch",
        data: { version: "v1", patch: new Uint8Array([1, 2, 3]), clientLastApplied: null },
      },
      {
        name: "Patch",
        data: { version: "v2", patch: new Uint8Array([0, 255, 128]), clientLastApplied: "ts-9000" },
      },
    ];
    const bytes = streamTransportWriteAll<Message>(messages);
    expect(streamTransportReadAll<Message>(bytes)).toEqual(messages);
  });

  it("round-trips an empty list as empty bytes", () => {
    const bytes = streamTransportWriteAll<Message>([]);
    expect(bytes.byteLength).toBe(0);
    expect(streamTransportReadAll<Message>(bytes)).toEqual([]);
  });

  it("round-trips unicode strings", () => {
    const messages: Message[] = [
      { name: "Connected", data: "héllo wörld 🎉 café" },
      { name: "Patch", data: { version: "v", patch: new Uint8Array(0), clientLastApplied: null } },
    ];
    const bytes = streamTransportWriteAll<Message>(messages);
    expect(streamTransportReadAll<Message>(bytes)).toEqual(messages);
  });

  it("stops at a truncated frame instead of throwing", () => {
    const bytes = streamTransportWriteAll<Message>([
      { name: "Connected", data: null },
      { name: "Patch", data: { version: "v2", patch: new Uint8Array(0), clientLastApplied: null } },
    ]);
    const decoded = streamTransportReadAll<Message>(bytes.slice(0, bytes.byteLength - 2));
    expect(decoded).toHaveLength(1);
    expect(decoded[0]).toEqual(CONNECTED);
  });
});

describe("streamTransportWriter", () => {
  it("writes a length-prefixed msgpack frame", () => {
    const chunks: Uint8Array[] = [];
    const writer = streamTransportWriter<Message>({ write: (chunk) => chunks.push(chunk) });
    writer({ name: "Connected", data: null });

    const frame = streamTransportWriteAll<Message>([{ name: "Connected", data: null }]);
    // First chunk is the 4-byte little-endian length prefix.
    expect(chunks[0].byteLength).toBe(4);
    const length = new DataView(chunks[0].buffer, chunks[0].byteOffset, 4).getUint32(0, true);
    expect(length).toBe(chunks[1].byteLength);
    // Concatenated output equals the canonical all-at-once framing.
    const joined = new Uint8Array(chunks.reduce((n, c) => n + c.byteLength, 0));
    let offset = 0;
    for (const chunk of chunks) {
      joined.set(chunk, offset);
      offset += chunk.byteLength;
    }
    expect(joined).toEqual(frame);
  });
});

describe("streamTransportReader", () => {
  it("reads a message split across several chunks", async () => {
    const frame = streamTransportWriteAll<Message>([CONNECTED]);
    const reader = readerFromChunks([frame.slice(0, 2), frame.slice(2, 5), frame.slice(5)]);
    expect(await collect(streamTransportReader<Message>(reader))).toEqual([CONNECTED]);
  });

  it("reads several messages from a single chunk", async () => {
    const frames = streamTransportWriteAll<Message>([
      { name: "Connected", data: null },
      {
        name: "Patch",
        data: { version: "v2", patch: new Uint8Array([9]), clientLastApplied: null },
      },
    ]);
    expect(await collect(streamTransportReader<Message>(readerFromChunks([frames])))).toHaveLength(
      2,
    );
  });

  it("reads messages spanning chunk boundaries back-to-back", async () => {
    const frames = streamTransportWriteAll<Message>([
      { name: "Connected", data: null },
      {
        name: "Patch",
        data: { version: "v2", patch: new Uint8Array([9]), clientLastApplied: null },
      },
    ]);
    const reader = readerFromChunks([
      frames.slice(0, 3),
      frames.slice(3, frames.byteLength - 2),
      frames.slice(frames.byteLength - 2),
    ]);
    const messages = await collect(streamTransportReader<Message>(reader));
    expect(messages).toHaveLength(2);
    expect(messages[1]).toEqual({
      name: "Patch",
      data: { version: "v2", patch: new Uint8Array([9]), clientLastApplied: null },
    });
  });

  it("yields nothing when the stream ends immediately", async () => {
    expect(await collect(streamTransportReader<Message>(readerFromChunks([])))).toEqual([]);
  });

  it("stops cleanly on EOF in the middle of a frame", async () => {
    const frame = streamTransportWriteAll<Message>([CONNECTED]);
    // Only half the frame arrives, then EOF.
    const reader = readerFromChunks([frame.slice(0, 4)]);
    expect(await collect(streamTransportReader<Message>(reader))).toEqual([]);
  });
});
