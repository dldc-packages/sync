import type {
  TStreamReader,
  TStreamTransportReader,
  TStreamTransportWriter,
  TStreamWriter,
  UnionFromMap,
} from "./stream.ts";
import { streamTransportReader, streamTransportWriter } from "./stream.ts";

/**
 * This is the transport used by the /api/client/:clientId/sync endpoint.
 */

export interface TPatchData {
  patch: Uint8Array;
  version: string; // server-generated unique ID for this DB version
  clientLastApplied: string | null; // HLC timestamp string, null if client unknown to server
}
export interface TInitialPatchData {
  patch: Uint8Array;
  version: string;
  clientLastApplied: string | null;
}
export interface TUpToDateData {
  version: string;
  clientLastApplied: string | null;
}

export interface TFileSyncMessageData {
  Connected: null;
  InitialPatch: TInitialPatchData;
  UpToDate: TUpToDateData;
  Patch: TPatchData;
}

export type TMessageName = keyof TFileSyncMessageData;

export type TFileSyncMessage = UnionFromMap<TFileSyncMessageData>;

export type TFileSyncTransportWriter = TStreamTransportWriter<TFileSyncMessage>;
export type TFileSyncTransportReader = TStreamTransportReader<TFileSyncMessage>;

export function fileSyncTransportReader(
  reader: TStreamReader,
): TFileSyncTransportReader {
  return streamTransportReader<TFileSyncMessage>(reader);
}

export function fileSyncTransportWriter(
  writer: TStreamWriter,
): TFileSyncTransportWriter {
  return streamTransportWriter<TFileSyncMessage>(writer);
}
