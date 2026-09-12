import {
  configureDatabaseSession,
  REQUIRED_SQL_MODE,
} from "@araucaria/database";
import type { RowDataPacket } from "mysql2";
import { createConnection } from "mysql2/promise";

import {
  assertPercona57TestDatabaseName,
  requirePercona57TestDatabaseUrl,
} from "./safety.js";

interface InitialSessionRow extends RowDataPacket {
  character_set_server: string;
  collation_server: string;
  database_name: string | null;
  hostname: string;
  innodb_strict_mode: number;
  session_sql_mode: string;
  session_time_zone: string;
  version: string;
  version_comment: string;
}

interface BootstrappedSessionRow extends RowDataPacket {
  database_name: string | null;
  innodb_strict_mode: number;
  session_sql_mode: string;
  session_time_zone: string;
}

async function main(): Promise<void> {
  const databaseUrl = requirePercona57TestDatabaseUrl();
  const connection = await createConnection(databaseUrl);
  try {
    const [initialRows] = await connection.query<InitialSessionRow[]>(`
      SELECT
        DATABASE() AS database_name,
        VERSION() AS version,
        @@version_comment AS version_comment,
        @@hostname AS hostname,
        @@session.time_zone AS session_time_zone,
        @@session.sql_mode AS session_sql_mode,
        @@innodb_strict_mode AS innodb_strict_mode,
        @@character_set_server AS character_set_server,
        @@collation_server AS collation_server
    `);
    const initial = initialRows[0];
    assert(initial, "Unable to read the initial database session.");
    assertPercona57TestDatabaseName(initial.database_name);
    console.log(JSON.stringify({ phase: "initial", ...initial }, null, 2));

    await configureDatabaseSession(connection);

    const [bootstrappedRows] = await connection.query<
      BootstrappedSessionRow[]
    >(`
      SELECT
        DATABASE() AS database_name,
        @@session.time_zone AS session_time_zone,
        @@session.sql_mode AS session_sql_mode,
        @@innodb_strict_mode AS innodb_strict_mode
    `);
    const bootstrapped = bootstrappedRows[0];
    assert(bootstrapped, "Unable to read the bootstrapped database session.");
    assertPercona57TestDatabaseName(bootstrapped.database_name);
    assert(
      bootstrapped.session_time_zone === "+00:00",
      "Session time zone bootstrap failed.",
    );
    assert(
      bootstrapped.innodb_strict_mode === 1,
      "InnoDB strict-mode bootstrap failed.",
    );
    assertRequiredSqlModes(bootstrapped.session_sql_mode);
    console.log(
      JSON.stringify({ phase: "bootstrapped", ...bootstrapped }, null, 2),
    );
  } finally {
    await connection.end();
  }
}

function assertRequiredSqlModes(sqlMode: string): void {
  const configuredModes = new Set(sqlMode.split(","));
  for (const requiredMode of REQUIRED_SQL_MODE.split(",")) {
    assert(
      configuredModes.has(requiredMode),
      `Database session is missing SQL mode ${requiredMode}.`,
    );
  }
}

function assert(condition: unknown, message: string): asserts condition {
  if (!condition) {
    throw new Error(message);
  }
}

main().catch((error: unknown) => {
  console.error(
    error instanceof Error ? error.message : "Unknown preflight error.",
  );
  process.exitCode = 1;
});
