import { createPhysicalDatabaseConnection } from "@araucaria/database";
import type { Connection, RowDataPacket } from "mysql2/promise";

import {
  assertPercona57TestDatabaseName,
  requirePercona57TestDatabaseUrl,
} from "./safety.js";

const LOCK_NAME = "araucaria_livescore:test:collector";

interface ConnectionInfo extends RowDataPacket {
  databaseName: string | null;
  sessionTimeZone: string;
  version: string;
  versionComment: string;
}

interface ConnectionIdRow extends RowDataPacket {
  connectionId: number;
}

interface LockRow extends RowDataPacket {
  acquired: unknown;
}

interface ReleaseLockRow extends RowDataPacket {
  released: unknown;
}

interface LockResult {
  raw: unknown;
  value: 0 | 1;
}

interface LockDiagnostics {
  firstConnectionId: number | undefined;
  secondConnectionId: number | undefined;
}

async function main(): Promise<void> {
  // This parses and rejects every database URL except the disposable test schema
  // before either physical connection is opened.
  const databaseUrl = requirePercona57TestDatabaseUrl();
  let firstConnection: Connection | undefined;
  let secondConnection: Connection | undefined;
  let firstOwnsLock = false;
  let secondOwnsLock = false;
  let primaryError: unknown;
  let hasPrimaryError = false;
  const cleanupErrors: unknown[] = [];
  let firstConnectionId: number | undefined;
  let secondConnectionId: number | undefined;

  try {
    firstConnection = await createPhysicalDatabaseConnection({
      databaseUrl,
      connectionLimit: 1,
    });
    secondConnection = await createPhysicalDatabaseConnection({
      databaseUrl,
      connectionLimit: 1,
    });

    const [firstInfo, secondInfo] = await Promise.all([
      readConnectionInfo(firstConnection),
      readConnectionInfo(secondConnection),
    ]);
    assertPercona57TestDatabaseName(firstInfo.databaseName);
    assertPercona57TestDatabaseName(secondInfo.databaseName);
    assert(
      firstInfo.sessionTimeZone === "+00:00" &&
        secondInfo.sessionTimeZone === "+00:00",
      "Physical connection session time zone bootstrap failed.",
    );

    [firstConnectionId, secondConnectionId] = await Promise.all([
      readConnectionId(firstConnection),
      readConnectionId(secondConnection),
    ]);
    assert(
      firstConnectionId !== secondConnectionId,
      "Expected two independent physical MySQL connections.",
    );

    const firstAcquire = await getLock(
      firstConnection,
      LOCK_NAME,
      "first acquire",
      lockDiagnostics(firstConnectionId, secondConnectionId),
    );
    assertLockResult(
      firstAcquire,
      1,
      "first acquire",
      firstConnectionId,
      secondConnectionId,
    );
    firstOwnsLock = true;

    const secondWhileHeld = await getLock(
      secondConnection,
      LOCK_NAME,
      "second acquire while first held lock",
      lockDiagnostics(firstConnectionId, secondConnectionId),
    );
    assertLockResult(
      secondWhileHeld,
      0,
      "second acquire while first held lock",
      firstConnectionId,
      secondConnectionId,
    );

    const firstRelease = await releaseLock(
      firstConnection,
      LOCK_NAME,
      "first release",
      lockDiagnostics(firstConnectionId, secondConnectionId),
    );
    assertLockResult(
      firstRelease,
      1,
      "first release",
      firstConnectionId,
      secondConnectionId,
    );
    firstOwnsLock = false;

    const secondAcquire = await getLock(
      secondConnection,
      LOCK_NAME,
      "second acquire after first release",
      lockDiagnostics(firstConnectionId, secondConnectionId),
    );
    assertLockResult(
      secondAcquire,
      1,
      "second acquire after first release",
      firstConnectionId,
      secondConnectionId,
    );
    secondOwnsLock = true;

    const secondRelease = await releaseLock(
      secondConnection,
      LOCK_NAME,
      "second release",
      lockDiagnostics(firstConnectionId, secondConnectionId),
    );
    assertLockResult(
      secondRelease,
      1,
      "second release",
      firstConnectionId,
      secondConnectionId,
    );
    secondOwnsLock = false;

    console.log(
      JSON.stringify(
        {
          status: "PASS",
          database: firstInfo.databaseName,
          version: firstInfo.version,
          versionComment: firstInfo.versionComment,
          sessionTimeZone: firstInfo.sessionTimeZone,
          connectionIds: {
            first: firstConnectionId,
            second: secondConnectionId,
          },
          advisoryLock: {
            firstAcquire: firstAcquire.value,
            secondWhileHeld: secondWhileHeld.value,
            firstRelease: firstRelease.value,
            secondAcquire: secondAcquire.value,
            secondRelease: secondRelease.value,
          },
        },
        null,
        2,
      ),
    );
  } catch (error) {
    primaryError = error;
    hasPrimaryError = true;
  } finally {
    if (secondConnection && secondOwnsLock) {
      const connection = secondConnection;
      await attemptCleanup(
        () =>
          releaseLock(
            connection,
            LOCK_NAME,
            "cleanup second release",
            lockDiagnostics(firstConnectionId, secondConnectionId),
          ),
        cleanupErrors,
      );
    }
    if (firstConnection && firstOwnsLock) {
      const connection = firstConnection;
      await attemptCleanup(
        () =>
          releaseLock(
            connection,
            LOCK_NAME,
            "cleanup first release",
            lockDiagnostics(firstConnectionId, secondConnectionId),
          ),
        cleanupErrors,
      );
    }
    if (secondConnection) {
      const connection = secondConnection;
      await attemptCleanup(() => connection.end(), cleanupErrors);
    }
    if (firstConnection) {
      const connection = firstConnection;
      await attemptCleanup(() => connection.end(), cleanupErrors);
    }
  }
  if (hasPrimaryError) throw primaryError;
  if (cleanupErrors.length)
    throw new AggregateError(
      cleanupErrors,
      "Database integration cleanup failed.",
    );
}

async function readConnectionInfo(
  connection: Connection,
): Promise<ConnectionInfo> {
  const [rows] = await connection.query<ConnectionInfo[]>(`
    SELECT
      DATABASE() AS databaseName,
      VERSION() AS version,
      @@version_comment AS versionComment,
      @@session.time_zone AS sessionTimeZone
  `);
  const row = rows[0];
  assert(row, "Unable to read database connection information.");
  return row;
}

async function readConnectionId(connection: Connection): Promise<number> {
  const [rows] = await connection.query<ConnectionIdRow[]>(
    "SELECT CONNECTION_ID() AS connectionId",
  );
  const row = rows[0];
  assert(row, "Unable to read physical MySQL connection ID.");
  return row.connectionId;
}

async function getLock(
  connection: Connection,
  lockName: string,
  operation: string,
  diagnostics: LockDiagnostics,
): Promise<LockResult> {
  const [rows] = await connection.query<LockRow[]>(
    "SELECT GET_LOCK(?, 0) AS acquired",
    [lockName],
  );
  const raw = rows[0]?.acquired;
  return { raw, value: normalizeLockScalar(raw, operation, diagnostics) };
}

async function releaseLock(
  connection: Connection,
  lockName: string,
  operation: string,
  diagnostics: LockDiagnostics,
): Promise<LockResult> {
  const [rows] = await connection.query<ReleaseLockRow[]>(
    "SELECT RELEASE_LOCK(?) AS released",
    [lockName],
  );
  const raw = rows[0]?.released;
  return { raw, value: normalizeLockScalar(raw, operation, diagnostics) };
}

function normalizeLockScalar(
  raw: unknown,
  operation: string,
  diagnostics: LockDiagnostics,
): 0 | 1 {
  if (raw === 1 || raw === "1") return 1;
  if (raw === 0 || raw === "0") return 0;
  throw new Error(lockDiagnosticMessage(operation, raw, diagnostics));
}

function assertLockResult(
  result: LockResult,
  expected: 0 | 1,
  operation: string,
  firstConnectionId: number,
  secondConnectionId: number,
): void {
  if (result.value !== expected) {
    throw new Error(
      lockDiagnosticMessage(operation, result.raw, {
        firstConnectionId,
        secondConnectionId,
      }),
    );
  }
}

function lockDiagnostics(
  firstConnectionId: number | undefined,
  secondConnectionId: number | undefined,
): LockDiagnostics {
  return { firstConnectionId, secondConnectionId };
}

function lockDiagnosticMessage(
  operation: string,
  raw: unknown,
  diagnostics: LockDiagnostics,
): string {
  return `Advisory lock validation failed: operation=${operation}; raw=${describeScalar(raw)}; typeof=${typeof raw}; firstConnectionId=${diagnostics.firstConnectionId ?? "unavailable"}; secondConnectionId=${diagnostics.secondConnectionId ?? "unavailable"}.`;
}

function describeScalar(raw: unknown): string {
  if (typeof raw === "string") return JSON.stringify(raw);
  if (raw === null || raw === undefined) return String(raw);
  if (typeof raw === "object") return Object.prototype.toString.call(raw);
  return String(raw);
}

async function attemptCleanup(
  operation: () => Promise<unknown>,
  cleanupErrors: unknown[],
): Promise<void> {
  try {
    await operation();
  } catch (error) {
    cleanupErrors.push(error);
  }
}

function assert(condition: unknown, message: string): asserts condition {
  if (!condition) throw new Error(message);
}

main().catch((error: unknown) => {
  console.error(
    error instanceof Error
      ? error.message
      : "Unknown database integration validation error.",
  );
  process.exitCode = 1;
});
