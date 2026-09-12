import type { Database } from "@araucaria/database";
import { type Kysely, sql } from "kysely";

export const PERCONA57_TEST_DATABASE = "dxarauca_livescore_test";
const PRODUCTION_DATABASE = "dxarauca_livescore";

interface DatabaseNameRow {
  databaseName: string | null;
}

export function requirePercona57TestDatabaseUrl(): string {
  const databaseUrl = process.env.PERCONA57_DATABASE_URL;
  if (!databaseUrl) {
    throw new Error("PERCONA57_DATABASE_URL must be configured.");
  }

  const databaseName = decodeURIComponent(
    new URL(databaseUrl).pathname.slice(1),
  );
  assertPercona57TestDatabaseName(databaseName);
  return databaseUrl;
}

export async function assertKyselyTestDatabase(
  database: Kysely<Database>,
): Promise<void> {
  const result = await sql<DatabaseNameRow>`
    SELECT DATABASE() AS databaseName
  `.execute(database);
  assertPercona57TestDatabaseName(result.rows[0]?.databaseName);
}

export function assertPercona57TestDatabaseName(
  databaseName: string | null | undefined,
): asserts databaseName is typeof PERCONA57_TEST_DATABASE {
  if (databaseName === PRODUCTION_DATABASE) {
    throw new Error("Refusing to run against the production database.");
  }
  if (databaseName !== PERCONA57_TEST_DATABASE) {
    throw new Error(
      `Expected database ${PERCONA57_TEST_DATABASE}, received ${databaseName ?? "NULL"}.`,
    );
  }
}
