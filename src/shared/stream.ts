import { decode as decodeMsgPack, encode as encodeMsgPack } from "@msgpack/msgpack";

/**
 * Use msgpack to encode and decode messages.
 *
 * We first send a u32 number that defines the size of the message.
 * Then we decode the message using msgpack.
 */

export interface TStreamWriter {
  write: (chunk: Uint8Array) => void;
}

export interface TStreamReader {
  read: () => Promise<ReadableStreamReadResult<Uint8Array>>;
}

/**
 * Utility function to create an union from a map.
 */
export type UnionFromMap<T extends Record<string, any>> = {
  [K in keyof T]: { name: K; data: T[K] };
}[keyof T];

export type TStreamTransportReader<Msg> = AsyncIterable<Msg>;

export function streamTransportReader<Msg>(reader: TStreamReader): TStreamTransportReader<Msg> {
  return {
    [Symbol.asyncIterator]: async function* () {
      let buffer = new Uint8Array(0);

      /**
       * Wait for the buffer to have at least `size` bytes.
       * Then remove the first `size` bytes from the buffer and return them.
       */
      async function read(size: number): Promise<Uint8Array | null> {
        while (buffer.byteLength < size) {
          const { done, value } = await reader.read();
          if (done) {
            return null;
          }
          buffer = new Uint8Array([...buffer, ...value]);
        }
        const result = buffer.slice(0, size);
        buffer = buffer.slice(size);
        return result;
      }

      while (true) {
        const sizeBytes = await read(4);
        if (sizeBytes === null) {
          return;
        }
        const size = readUint32(sizeBytes.buffer);
        const messageBytes = await read(size);
        if (messageBytes === null) {
          return;
        }
        const message = decodeMsgPack(messageBytes);
        yield message as Msg;
      }
    },
  };
}

export type TStreamTransportWriter<Msg> = (message: Msg) => void;

export function streamTransportWriter<Msg>(writer: TStreamWriter): TStreamTransportWriter<Msg> {
  return function syncTransportWriter(message: Msg): void {
    const encoded = encodeMsgPack(message);
    const encodedLength = encoded.byteLength;
    writer.write(writeUint32(encodedLength));
    writer.write(encoded);
  };
}

/**
 * Synchronously read all messages from the stream using offset on the stream.
 */
export function streamTransportReadAll<Msg>(content: Uint8Array): Msg[] {
  let rest = content;
  const messages: Msg[] = [];

  function read(size: number): Uint8Array {
    const result = rest.slice(0, size);
    rest = rest.slice(size);
    return result;
  }

  while (rest.byteLength > 0) {
    const sizeBytes = read(4);
    if (sizeBytes.byteLength < 4) {
      break;
    }
    const size = readUint32(sizeBytes.buffer);
    const messageBytes = read(size);
    if (messageBytes.byteLength < size) {
      break;
    }
    const message = decodeMsgPack(messageBytes);
    messages.push(message as Msg);
  }
  return messages;
}

export function streamTransportWriteAll<Msg>(messages: Msg[]): Uint8Array {
  const encodedItems = messages.map((message) => {
    const encoded = encodeMsgPack(message);
    const encodedLength = encoded.byteLength;
    return { encodedLength, encoded };
  });
  const totalLength = encodedItems.reduce((acc, { encodedLength }) => acc + 4 + encodedLength, 0);
  const result = new Uint8Array(totalLength);
  let offset = 0;
  for (const { encodedLength, encoded } of encodedItems) {
    const lengthBytes = writeUint32(encodedLength);
    result.set(lengthBytes, offset);
    offset += 4;
    result.set(encoded, offset);
    offset += encodedLength;
  }
  return result;
}

function writeUint32(value: number): Uint8Array {
  const bytes = new Uint8Array(4);
  new DataView(bytes.buffer).setUint32(0, value, true);
  return bytes;
}

function readUint32(buffer: ArrayBufferLike): number {
  return new DataView(buffer).getUint32(0, true);
}
