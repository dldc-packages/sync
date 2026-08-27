import { Database } from "@db/sqlite";
import {
  Column,
  Datatype,
  Migration,
  Schema,
  type TOperation,
  type TOperationResult,
} from "@dldc/zendb";
import { DbSqliteDriver } from "@dldc/zendb-db-sqlite";
import { compareHLC, parseHLC } from "../shared/hlc.ts";

export function instantDt() {
  return Datatype.create<Temporal.Instant, string>({
    name: "instant",
    serialize: (value) => value.toString(),
    parse: (value) => Temporal.Instant.from(value),
    type: "TEXT",
  });
}

export interface TStateDb {
  getClientLastApplied: (clientId: string) => string | null;
  updateClientLastApplied: (clientId: string, ts: string) => boolean;
  getDbVersion: () => string | null;
  setDbVersion: (version: string) => void;
}

export interface TStateDbParams {
  stateDatabasePath: string;
}

export async function createStateDb(
  { stateDatabasePath }: TStateDbParams,
): Promise<TStateDb> {
  const MAIN_DB_VERSION_KEY = "mainDbVersion";

  const stateSchemaDef = Schema.declare({
    clientState: {
      ...baseColumns(),
      clientId: Column.text().primary(), // client-generated UUID
      clientLastApplied: Column.text().nullable(), // HLC timestamp string
    },
    dbMeta: {
      metaKey: Column.text().primary(),
      value: Column.text(),
    },
  });

  const stateMigration = Migration.init(
    DbSqliteDriver,
    stateSchemaDef,
    ({ database }) => database,
  );

  const stateSchema = stateMigration.schema;

  // Ensure the parent directory exists (native SQLite won't create it).
  const dir = dirname(stateDatabasePath);
  Deno.mkdirSync(dir, { recursive: true });

  // Open the file-backed DB. Native SQLite persists writes directly to disk.
  const initDb = new Database(stateDatabasePath);
  const [migratedDb, shouldPersist] = await stateMigration.apply(initDb);

  let db = migratedDb;
  if (shouldPersist) {
    // Migration produced an in-memory DB (createDatabase returns ":memory:").
    // Persist it back to the file by backing up into a fresh on-disk DB.
    const diskDb = new Database(stateDatabasePath);
    migratedDb.backup(diskDb);
    migratedDb.close();
    db = diskDb;
  }

  return {
    getClientLastApplied,
    updateClientLastApplied,
    getDbVersion,
    setDbVersion,
  };

  function exec<Op extends TOperation>(op: Op): TOperationResult<Op> {
    return DbSqliteDriver.exec(db, op);
  }

  function getClientLastApplied(clientId: string): string | null {
    const result = exec(
      stateSchema.tables.clientState.query()
        .andFilterEqual({ clientId })
        .maybeOne(),
    );
    if (result === null) return null;
    return result.clientLastApplied ?? null;
  }

  /** Returns true if the ts was new (updated), false if stale (already applied). */
  function updateClientLastApplied(clientId: string, ts: string): boolean {
    const current = getClientLastApplied(clientId);
    if (current !== null) {
      const cmp = compareHLC(parseHLC(ts), parseHLC(current));
      if (cmp <= 0) return false; // stale, already applied
    }
    // Upsert: delete existing (if any) + insert
    exec(stateSchema.tables.clientState.deleteEqual({ clientId }));
    exec(
      stateSchema.tables.clientState.insert({
        clientId,
        clientLastApplied: ts,
        createdAt: Temporal.Now.instant(),
        updatedAt: Temporal.Now.instant(),
      }),
    );
    return true;
  }

  /** Read the persisted version UUID of the main app DB. */
  function getDbVersion(): string | null {
    const result = exec(
      stateSchema.tables.dbMeta.query()
        .andFilterEqual({ metaKey: MAIN_DB_VERSION_KEY })
        .maybeOne(),
    );
    if (result === null) return null;
    return result.value;
  }

  /** Persist the version UUID of the main app DB (upsert). */
  function setDbVersion(version: string): void {
    exec(
      stateSchema.tables.dbMeta.deleteEqual({ metaKey: MAIN_DB_VERSION_KEY }),
    );
    exec(
      stateSchema.tables.dbMeta.insert({
        metaKey: MAIN_DB_VERSION_KEY,
        value: version,
      }),
    );
  }

  function dirname(path: string): string {
    const idx = path.lastIndexOf("/");
    return idx === -1 ? "." : path.slice(0, idx);
  }
}

function baseColumns() {
  return {
    createdAt: Column.declare(instantDt()),
    updatedAt: Column.declare(instantDt()),
  } as const;
}
