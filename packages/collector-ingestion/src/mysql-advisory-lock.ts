import {
  createPhysicalDatabaseConnection,
  type DatabaseConfig,
} from "@araucaria/database";
import type {
  AdvisoryLockSession,
  AdvisoryLockSessionProvider,
} from "./polling.js";

interface MySqlConnection {
  query<T extends Array<Record<string, unknown>>>(
    statement: string,
    values?: readonly unknown[],
  ): Promise<[T, unknown]>;
  end(): Promise<void>;
}

interface LockRow extends Record<string, unknown> {
  acquired?: unknown;
  released?: unknown;
}

/**
 * Opens a pinned mysql2/promise connection per mapping execution. MySQL
 * advisory-lock ownership therefore cannot move across pooled connections.
 */
export class MySqlAdvisoryLockSessionProvider
  implements AdvisoryLockSessionProvider
{
  constructor(private readonly databaseConfig: DatabaseConfig) {}

  async open(): Promise<AdvisoryLockSession> {
    const connection = (await createPhysicalDatabaseConnection(
      this.databaseConfig,
    )) as MySqlConnection;
    return new MySqlAdvisoryLockSession(connection);
  }
}

class MySqlAdvisoryLockSession implements AdvisoryLockSession {
  constructor(private readonly connection: MySqlConnection) {}

  async tryAcquire(lockName: string): Promise<boolean> {
    const [rows] = await this.connection.query<LockRow[]>(
      "SELECT GET_LOCK(?, 0) AS acquired",
      [lockName],
    );
    return normalizeLockScalar(rows[0]?.acquired, "GET_LOCK");
  }

  async release(lockName: string): Promise<boolean> {
    const [rows] = await this.connection.query<LockRow[]>(
      "SELECT RELEASE_LOCK(?) AS released",
      [lockName],
    );
    return normalizeLockScalar(rows[0]?.released, "RELEASE_LOCK");
  }

  async close(): Promise<void> {
    await this.connection.end();
  }
}

function normalizeLockScalar(raw: unknown, operation: string): boolean {
  if (raw === 1 || raw === "1") return true;
  if (raw === 0 || raw === "0") return false;
  throw new Error(`${operation} returned an invalid advisory-lock scalar.`);
}
