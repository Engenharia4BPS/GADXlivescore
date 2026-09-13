import {
  CompiledQuery,
  type DatabaseConnection,
  Kysely,
  MysqlDialect,
} from "kysely";
import { createPool } from "mysql2";
import {
  type Connection,
  createConnection,
  type PoolConnection,
} from "mysql2/promise";

import {
  type DatabaseConfig,
  databaseConfigFromEnvironment,
} from "./config.js";
import type { Database } from "./types.js";

export const REQUIRED_SQL_MODE =
  "ONLY_FULL_GROUP_BY,STRICT_TRANS_TABLES,NO_ZERO_IN_DATE,NO_ZERO_DATE,ERROR_FOR_DIVISION_BY_ZERO,NO_ENGINE_SUBSTITUTION";

export function createDatabase(config: DatabaseConfig): Kysely<Database> {
  const pool = createPool(poolOptions(config));
  return new Kysely<Database>({
    dialect: new MysqlDialect({
      pool,
      onCreateConnection: configureKyselyDatabaseSession,
    }),
  });
}

export function createDatabaseFromEnvironment(): Kysely<Database> {
  return createDatabase(databaseConfigFromEnvironment());
}

/**
 * Opens one pinned physical session for operations, such as advisory locks,
 * whose ownership cannot safely move between pooled connections.
 */
export async function createPhysicalDatabaseConnection(
  config: DatabaseConfig,
): Promise<Connection> {
  const connection = await createConnection(connectionOptions(config));
  try {
    await configureDatabaseSession(connection);
    return connection;
  } catch (error) {
    await connection.end();
    throw error;
  }
}

export async function configureDatabaseSession(
  connection: Pick<PoolConnection, "query">,
): Promise<void> {
  await connection.query("SET SESSION time_zone = '+00:00'");
  await connection.query(`SET SESSION sql_mode = '${REQUIRED_SQL_MODE}'`);
  await connection.query("SET SESSION innodb_strict_mode = ON");
}

async function configureKyselyDatabaseSession(
  connection: DatabaseConnection,
): Promise<void> {
  await connection.executeQuery(
    CompiledQuery.raw("SET SESSION time_zone = '+00:00'"),
  );
  await connection.executeQuery(
    CompiledQuery.raw(`SET SESSION sql_mode = '${REQUIRED_SQL_MODE}'`),
  );
  await connection.executeQuery(
    CompiledQuery.raw("SET SESSION innodb_strict_mode = ON"),
  );
}

function poolOptions(config: DatabaseConfig) {
  return connectionOptions(config);
}

function connectionOptions(config: DatabaseConfig) {
  const parsed = new URL(config.databaseUrl);
  return {
    host: parsed.hostname,
    port: parsed.port ? Number(parsed.port) : 3306,
    user: decodeURIComponent(parsed.username),
    password: decodeURIComponent(parsed.password),
    database: decodeURIComponent(parsed.pathname.slice(1)),
    waitForConnections: true,
    connectionLimit: config.connectionLimit,
    dateStrings: true,
    supportBigNumbers: true,
    bigNumberStrings: true,
    multipleStatements: false,
    charset: "utf8mb4",
    timezone: "Z",
  };
}
