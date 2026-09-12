import { createDatabase, REQUIRED_SQL_MODE } from "@araucaria/database";
import { sql } from "kysely";

import {
  assertKyselyTestDatabase,
  requirePercona57TestDatabaseUrl,
} from "./safety.js";

const REQUIRED_TABLES = [
  "sources",
  "contests",
  "contest_external_ids",
  "contest_categories",
  "contest_category_external_ids",
  "entries",
  "raw_messages",
  "score_snapshots",
  "band_snapshots",
  "score_snapshot_flags",
  "canonical_score_events",
  "current_scores",
  "collector_source_contests",
  "collector_runs",
] as const;

const REQUIRED_COLUMNS: Readonly<Record<string, readonly string[]>> = {
  raw_messages: [
    "processing_status",
    "processing_attempts",
    "processed_at",
    "observation_count",
    "accepted_count",
    "duplicate_count",
    "rejected_count",
    "payload_sha256",
    "payload_redacted",
    "request_path_redacted",
    "response_headers_redacted",
  ],
  score_snapshots: [
    "contest_id",
    "category_id",
    "category_raw",
    "source_timestamp",
    "normalized_fingerprint",
  ],
  score_snapshot_flags: ["snapshot_id", "flag", "detected_at", "details"],
  canonical_score_events: ["score_snapshot_id", "selected_at", "effective_at"],
  current_scores: [
    "entry_id",
    "canonical_event_id",
    "canonical_snapshot_id",
    "updated_at",
  ],
};

const REQUIRED_FOREIGN_KEYS = [
  "fk_contest_external_ids_contest",
  "fk_contest_external_ids_source",
  "fk_contest_categories_contest",
  "fk_category_external_ids_contest",
  "fk_category_external_ids_category_contest",
  "fk_category_external_ids_external_contest",
  "fk_entries_contest",
  "fk_entries_current_category_contest",
  "fk_collector_source_contests_source",
  "fk_collector_source_contests_contest",
  "fk_collector_source_contests_external_identity",
  "fk_collector_runs_mapping",
  "fk_collector_runs_source",
  "fk_raw_messages_source",
  "fk_raw_messages_contest",
  "fk_raw_messages_mapping",
  "fk_raw_messages_run",
  "fk_score_snapshots_entry_contest",
  "fk_score_snapshots_source",
  "fk_score_snapshots_raw_message_source",
  "fk_score_snapshots_category_contest",
  "fk_band_snapshots_snapshot",
  "fk_score_snapshot_flags_snapshot",
  "fk_canonical_score_events_snapshot_entry",
  "fk_current_scores_canonical_event",
] as const;

const REQUIRED_UNIQUE_INDEXES: Readonly<Record<string, readonly string[]>> = {
  sources: ["uq_sources_code"],
  contest_external_ids: [
    "uq_contest_external_ids_source_external",
    "uq_contest_external_ids_id_contest",
  ],
  contest_categories: ["uq_contest_categories_id_contest"],
  entries: ["uq_entries_contest_callsign"],
  raw_messages: ["uq_raw_messages_id_source"],
  score_snapshots: ["uq_score_snapshots_entry_source_fingerprint"],
  score_snapshot_flags: ["uq_score_snapshot_flags_snapshot_diagnostic"],
  canonical_score_events: ["uq_canonical_score_events_snapshot"],
  current_scores: [
    "PRIMARY",
    "uq_current_scores_event",
    "uq_current_scores_snapshot",
  ],
};

const REQUIRED_COLLATIONS: Readonly<Record<string, string>> = {
  "sources.code": "ascii_bin",
  "entries.normalized_callsign": "ascii_bin",
  "contest_external_ids.external_id": "utf8mb4_bin",
  "contest_category_external_ids.external_category_id": "utf8mb4_bin",
  "band_snapshots.band": "ascii_bin",
  "band_snapshots.mode": "ascii_bin",
};

interface SessionRow {
  mysqlVersion: string;
  versionComment: string;
  sqlMode: string;
  timeZone: string;
  innodbStrictMode: number;
}

interface TableRow {
  tableName: string;
}

interface ColumnRow {
  tableName: string;
  columnName: string;
}

interface CollationRow {
  tableName: string;
  columnName: string;
  collationName: string | null;
}

interface ForeignKeyRuleRow {
  constraintName: string;
  deleteRule: string;
  updateRule: string;
}

interface IndexRow {
  tableName: string;
  indexName: string;
  nonUnique: number;
}

async function main(): Promise<void> {
  const databaseUrl = requirePercona57TestDatabaseUrl();

  const database = createDatabase({ databaseUrl, connectionLimit: 1 });
  try {
    await assertKyselyTestDatabase(database);
    await validateSession(database);
    await validateSchema(database);
    console.log("Percona 5.7 schema validation passed.");
  } finally {
    await database.destroy();
  }
}

async function validateSession(database: ReturnType<typeof createDatabase>) {
  const result = await sql<SessionRow>`
    SELECT
      VERSION() AS mysqlVersion,
      @@version_comment AS versionComment,
      @@session.sql_mode AS sqlMode,
      @@session.time_zone AS timeZone,
      @@session.innodb_strict_mode AS innodbStrictMode
  `.execute(database);
  const row = result.rows[0];
  if (!row) {
    throw new Error("Unable to read the database session configuration.");
  }
  if (
    !row.mysqlVersion.includes("5.7") ||
    !row.versionComment.includes("Percona")
  ) {
    throw new Error(
      `Expected Percona Server 5.7, received ${row.mysqlVersion}.`,
    );
  }
  if (row.timeZone !== "+00:00" || row.innodbStrictMode !== 1) {
    throw new Error(
      "Database session bootstrap did not set UTC and InnoDB strict mode.",
    );
  }

  const configuredModes = new Set(row.sqlMode.split(","));
  for (const mode of REQUIRED_SQL_MODE.split(",")) {
    if (!configuredModes.has(mode)) {
      throw new Error(`Database session is missing SQL mode ${mode}.`);
    }
  }
}

async function validateSchema(database: ReturnType<typeof createDatabase>) {
  const tables = await sql<TableRow>`
    SELECT table_name AS tableName
    FROM information_schema.tables
    WHERE table_schema = DATABASE()
  `.execute(database);
  const discoveredTables = new Set(tables.rows.map((row) => row.tableName));
  for (const table of REQUIRED_TABLES) {
    if (!discoveredTables.has(table)) {
      throw new Error(`Missing required table ${table}.`);
    }
  }

  const columns = await sql<ColumnRow>`
    SELECT table_name AS tableName, column_name AS columnName
    FROM information_schema.columns
    WHERE table_schema = DATABASE()
  `.execute(database);
  const columnNames = new Set(
    columns.rows.map((row) => `${row.tableName}.${row.columnName}`),
  );
  for (const [table, names] of Object.entries(REQUIRED_COLUMNS)) {
    for (const name of names) {
      if (!columnNames.has(`${table}.${name}`)) {
        throw new Error(`Missing required column ${table}.${name}.`);
      }
    }
  }

  const collations = await sql<CollationRow>`
    SELECT
      table_name AS tableName,
      column_name AS columnName,
      collation_name AS collationName
    FROM information_schema.columns
    WHERE table_schema = DATABASE()
  `.execute(database);
  const collationByColumn = new Map(
    collations.rows.map((row) => [
      `${row.tableName}.${row.columnName}`,
      row.collationName,
    ]),
  );
  for (const [column, expected] of Object.entries(REQUIRED_COLLATIONS)) {
    if (collationByColumn.get(column) !== expected) {
      throw new Error(`Expected ${column} to use ${expected}.`);
    }
  }

  const rules = await sql<ForeignKeyRuleRow>`
    SELECT
      constraint_name AS constraintName,
      delete_rule AS deleteRule,
      update_rule AS updateRule
    FROM information_schema.referential_constraints
    WHERE constraint_schema = DATABASE()
  `.execute(database);
  for (const rule of rules.rows) {
    if (
      !["RESTRICT", "NO ACTION"].includes(rule.deleteRule) ||
      !["RESTRICT", "NO ACTION"].includes(rule.updateRule)
    ) {
      throw new Error(
        `Foreign key ${rule.constraintName} must not use cascading actions.`,
      );
    }
  }
  const foreignKeyNames = new Set(
    rules.rows.map((rule) => rule.constraintName),
  );
  for (const name of REQUIRED_FOREIGN_KEYS) {
    if (!foreignKeyNames.has(name)) {
      throw new Error(`Missing required foreign key ${name}.`);
    }
  }

  const indexes = await sql<IndexRow>`
    SELECT
      table_name AS tableName,
      index_name AS indexName,
      non_unique AS nonUnique
    FROM information_schema.statistics
    WHERE table_schema = DATABASE()
  `.execute(database);
  const indexByTableAndName = new Map(
    indexes.rows.map((row) => [
      `${row.tableName}.${row.indexName}`,
      row.nonUnique,
    ]),
  );
  for (const [table, names] of Object.entries(REQUIRED_UNIQUE_INDEXES)) {
    for (const name of names) {
      if (indexByTableAndName.get(`${table}.${name}`) !== 0) {
        throw new Error(`Missing unique index ${table}.${name}.`);
      }
    }
  }
}

main().catch((error: unknown) => {
  console.error(
    error instanceof Error ? error.message : "Unknown validation error.",
  );
  process.exitCode = 1;
});
