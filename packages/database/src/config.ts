export interface DatabaseConfig {
  databaseUrl: string;
  connectionLimit: number;
}

const DEFAULT_CONNECTION_LIMIT = 10;

export function databaseConfigFromEnvironment(
  environment: NodeJS.ProcessEnv = process.env,
): DatabaseConfig {
  const databaseUrl = environment.DATABASE_URL;
  if (!databaseUrl) {
    throw new Error("DATABASE_URL must be configured.");
  }

  validateDatabaseUrl(databaseUrl);
  return {
    databaseUrl,
    connectionLimit: parseConnectionLimit(
      environment.DATABASE_CONNECTION_LIMIT,
    ),
  };
}

export function validateDatabaseUrl(databaseUrl: string): void {
  const parsed = new URL(databaseUrl);
  if (parsed.protocol !== "mysql:") {
    throw new Error("DATABASE_URL must use the mysql: scheme.");
  }
  if (!parsed.hostname || !parsed.pathname || parsed.pathname === "/") {
    throw new Error("DATABASE_URL must include a host and database name.");
  }
}

function parseConnectionLimit(value: string | undefined): number {
  if (value === undefined) {
    return DEFAULT_CONNECTION_LIMIT;
  }

  const parsed = Number(value);
  if (!Number.isInteger(parsed) || parsed < 1 || parsed > 100) {
    throw new Error(
      "DATABASE_CONNECTION_LIMIT must be an integer from 1 to 100.",
    );
  }
  return parsed;
}
