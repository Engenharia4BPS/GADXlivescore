import type { Database } from "@araucaria/database";
import { createDatabase, REQUIRED_SQL_MODE } from "@araucaria/database";
import { type Kysely, sql } from "kysely";
import {
  assertKyselyTestDatabase,
  requirePercona57TestDatabaseUrl,
} from "./safety.js";

const EXPECTED_TABLES = [
  "band_snapshots",
  "canonical_score_events",
  "collector_runs",
  "collector_source_contests",
  "contest_categories",
  "contest_category_external_ids",
  "contest_external_ids",
  "contests",
  "current_scores",
  "entries",
  "raw_messages",
  "score_snapshot_flags",
  "score_snapshots",
  "sources",
] as const;

const IDENTITY_COLLATIONS: Readonly<Record<string, string>> = {
  "band_snapshots.band": "ascii_bin",
  "band_snapshots.mode": "ascii_bin",
  "contest_category_external_ids.external_category_id": "utf8mb4_bin",
  "contest_external_ids.external_id": "utf8mb4_bin",
  "entries.normalized_callsign": "ascii_bin",
  "sources.code": "ascii_bin",
};

const LOCK_NAME = "araucaria_livescore:test:collector";
const UTC_TIMESTAMP = "2026-09-11 12:34:56.123456";

interface SessionRow {
  innodbStrictMode: number;
  sqlMode: string;
  timeZone: string;
}

interface TableRow {
  characterSetName: string;
  engine: string;
  tableCollation: string;
  tableName: string;
}

interface CollationRow {
  collationName: string | null;
  columnName: string;
  tableName: string;
}

interface StringRow {
  value: string;
}

interface NumberRow {
  value: number;
}

interface CurrentScoreRow {
  canonicalEventId: string;
  canonicalSnapshotId: string;
}

interface SnapshotRow {
  qsoTotal: string;
  score: string;
}

async function main(): Promise<void> {
  const databaseUrl = requirePercona57TestDatabaseUrl();
  const database = createDatabase({ databaseUrl, connectionLimit: 1 });

  try {
    await assertKyselyTestDatabase(database);
    await runCase("A. Session bootstrap", () => testSessionBootstrap(database));
    await runCase("B. Schema", () => testSchema(database));
    await seedReferenceData(database);
    await runCase("C. JSON", () => testJson(database));
    await runCase("E. Entry identity", () => testEntryIdentity(database));
    await runCase("F. Category integrity", () =>
      testCategoryIntegrity(database),
    );
    await runCase("H. Non-monotonic counters", () =>
      testNonMonotonicCounters(database),
    );
    await runCase("D. Timestamp precision", () =>
      testTimestampPrecision(database),
    );
    await runCase("G. Snapshot deduplication", () =>
      testSnapshotDeduplication(database),
    );
    await runCase("I. Append-only diagnostic model", () =>
      testAppendOnlyDiagnostics(database),
    );
    await runCase("J. Canonical integrity", () =>
      testCanonicalIntegrity(database),
    );
    await runCase("K. Canonical time ordering", () =>
      testCanonicalTimeOrdering(database),
    );
    await runCase("L. Restrictive deletion", () =>
      testRestrictiveDeletion(database),
    );
    await runCase("M. Advisory lock", () => testAdvisoryLock(databaseUrl));
    await runCase("N. Raw-message batch semantics", () =>
      testRawMessageBatchSemantics(database),
    );
    console.log("Percona 5.7 behavioral integration validation passed.");
  } finally {
    await database.destroy();
  }
}

async function runCase(name: string, operation: () => Promise<void>) {
  await operation();
  console.log(`PASS ${name}`);
}

async function testSessionBootstrap(database: Kysely<Database>): Promise<void> {
  const result = await sql<SessionRow>`
    SELECT
      @@session.time_zone AS timeZone,
      @@session.sql_mode AS sqlMode,
      @@session.innodb_strict_mode AS innodbStrictMode
  `.execute(database);
  const row = result.rows[0];
  assert(row, "Unable to read the database session.");
  assert(
    row.timeZone === "+00:00",
    "Expected the session time zone to be +00:00.",
  );
  assert(
    row.innodbStrictMode === 1,
    "Expected InnoDB strict mode to be enabled.",
  );

  const actualModes = new Set(row.sqlMode.split(","));
  for (const requiredMode of REQUIRED_SQL_MODE.split(",")) {
    assert(
      actualModes.has(requiredMode),
      `Expected SQL mode ${requiredMode} to be enabled.`,
    );
  }
}

async function testSchema(database: Kysely<Database>): Promise<void> {
  const tables = await sql<TableRow>`
    SELECT
      tables.table_name AS tableName,
      tables.engine AS engine,
      tables.table_collation AS tableCollation,
      collations.character_set_name AS characterSetName
    FROM information_schema.tables AS tables
    INNER JOIN information_schema.collations AS collations
      ON collations.collation_name = tables.table_collation
    WHERE tables.table_schema = DATABASE()
      AND tables.table_name IN (${sql.join(EXPECTED_TABLES)})
    ORDER BY tables.table_name
  `.execute(database);
  assert(
    tables.rows.length === EXPECTED_TABLES.length,
    "Expected every application table to exist.",
  );
  for (const table of tables.rows) {
    assert(table.engine === "InnoDB", `${table.tableName} must use InnoDB.`);
    assert(
      table.characterSetName === "utf8mb4",
      `${table.tableName} must use utf8mb4.`,
    );
    assert(
      table.tableCollation === "utf8mb4_unicode_ci",
      `${table.tableName} must use utf8mb4_unicode_ci.`,
    );
  }
  console.log(
    `Application tables (${tables.rows.length}): ${tables.rows
      .map((table) => table.tableName)
      .join(", ")}`,
  );

  const collations = await sql<CollationRow>`
    SELECT
      table_name AS tableName,
      column_name AS columnName,
      collation_name AS collationName
    FROM information_schema.columns
    WHERE table_schema = DATABASE()
  `.execute(database);
  const byColumn = new Map(
    collations.rows.map((row) => [
      `${row.tableName}.${row.columnName}`,
      row.collationName,
    ]),
  );
  for (const [column, expected] of Object.entries(IDENTITY_COLLATIONS)) {
    assert(
      byColumn.get(column) === expected,
      `${column} must use ${expected}.`,
    );
  }
}

async function seedReferenceData(database: Kysely<Database>): Promise<void> {
  const sources =
    await sql<NumberRow>`SELECT COUNT(*) AS value FROM sources`.execute(
      database,
    );
  assert(sources.rows[0]?.value === 0, "The test database must be empty.");

  await sql`
    INSERT INTO sources (
      id, code, kind, precedence_rank, display_name, base_url, default_config,
      enabled, created_at, updated_at
    ) VALUES (
      1, 'TEST_EXTERNAL', 'EXTERNAL_SERVER', 3, 'Test external source', NULL,
      JSON_OBJECT('poll_interval_seconds', 60), 1,
      '2026-09-11 12:00:00.000000', '2026-09-11 12:00:00.000000'
    )
  `.execute(database);

  await sql`
    INSERT INTO contests (
      id, name, normalized_name, slug, status, start_at, end_at, time_zone,
      metadata, created_at, updated_at
    ) VALUES
      (
        10, 'Contest A', 'contest a', 'contest-a', 'SCHEDULED', NULL, NULL, NULL,
        JSON_OBJECT('label', 'integration', 'valid', TRUE),
        '2026-09-11 12:00:00.000000', '2026-09-11 12:00:00.000000'
      ),
      (
        11, 'Contest B', 'contest b', 'contest-b', 'SCHEDULED', NULL, NULL, NULL,
        JSON_OBJECT('label', 'secondary'),
        '2026-09-11 12:00:00.000000', '2026-09-11 12:00:00.000000'
      )
  `.execute(database);

  await sql`
    INSERT INTO contest_categories (
      id, contest_id, category_key, display_name, metadata, active, created_at, updated_at
    ) VALUES
      (
        100, 10, 'SINGLE-OP', 'Single operator', JSON_OBJECT('band', 'ALL'), 1,
        '2026-09-11 12:00:00.000000', '2026-09-11 12:00:00.000000'
      ),
      (
        101, 11, 'MULTI-OP', 'Multi operator', JSON_OBJECT('band', 'ALL'), 1,
        '2026-09-11 12:00:00.000000', '2026-09-11 12:00:00.000000'
      )
  `.execute(database);

  await sql`
    INSERT INTO entries (
      id, contest_id, normalized_callsign, display_callsign, current_category_id,
      current_category_observed_at, metadata, created_at, updated_at
    ) VALUES
      (
        100, 10, 'DM7EE', 'DM7EE', 100, '2026-09-11 12:00:00.000000', NULL,
        '2026-09-11 12:00:00.000000', '2026-09-11 12:00:00.000000'
      ),
      (
        101, 11, 'PA6Y', 'PA6Y', 101, '2026-09-11 12:00:00.000000', NULL,
        '2026-09-11 12:00:00.000000', '2026-09-11 12:00:00.000000'
      ),
      (
        102, 10, 'TEST102', 'TEST102', 100, '2026-09-11 12:00:00.000000', NULL,
        '2026-09-11 12:00:00.000000', '2026-09-11 12:00:00.000000'
      )
  `.execute(database);

  await sql`
    INSERT INTO raw_messages (
      id, source_id, contest_id, collector_source_contest_id, collector_run_id,
      received_at, processing_status, processing_attempts, processing_started_at,
      processed_at, observation_count, accepted_count, duplicate_count, rejected_count,
      message_kind, request_method, request_path_redacted, response_status,
      response_content_type, response_headers_redacted, payload_redacted, payload_sha256,
      redaction_metadata, parse_error, validation_error, metadata, created_at
    ) VALUES
      (
        200, 1, 10, NULL, NULL, '2026-09-11 12:40:00.000000', 'PARTIAL', 1,
        '2026-09-11 12:40:00.000000', '2026-09-11 12:40:01.000000', 6, 4, 1, 1,
        'HTTP_RESPONSE', 'GET', '/api/displayscore/fixture', 200, 'application/json',
        JSON_OBJECT('content-type', 'application/json'), '{"rows":6}',
        UNHEX(SHA2('raw-message-200', 256)), JSON_OBJECT('redacted', TRUE), NULL, NULL,
        JSON_OBJECT('fixture', TRUE), '2026-09-11 12:40:00.000000'
      ),
      (
        201, 1, 11, NULL, NULL, '2026-09-11 12:40:00.000000', 'PARTIAL', 1,
        '2026-09-11 12:40:00.000000', '2026-09-11 12:40:01.000000', 1, 0, 0, 1,
        'HTTP_RESPONSE', 'GET', '/api/displayscore/fixture', 200, 'application/json',
        JSON_OBJECT('content-type', 'application/json'), '{"rows":1}',
        UNHEX(SHA2('raw-message-201', 256)), JSON_OBJECT('redacted', TRUE), NULL,
        JSON_OBJECT('row', 'invalid'), '2026-09-11 12:40:00.000000'
      )
  `.execute(database);
}

async function testJson(database: Kysely<Database>): Promise<void> {
  const result = await sql<StringRow>`
    SELECT JSON_UNQUOTE(JSON_EXTRACT(metadata, '$.label')) AS value
    FROM contests
    WHERE id = 10
  `.execute(database);
  assert(result.rows[0]?.value === "integration", "JSON did not round-trip.");
}

async function testEntryIdentity(database: Kysely<Database>): Promise<void> {
  await expectRejected("duplicate contest/callsign entry", () =>
    sql`
      INSERT INTO entries (
        id, contest_id, normalized_callsign, display_callsign, current_category_id,
        current_category_observed_at, metadata, created_at, updated_at
      ) VALUES (
        103, 10, 'DM7EE', 'DM7EE', 100, '2026-09-11 12:00:00.000000', NULL,
        '2026-09-11 12:00:00.000000', '2026-09-11 12:00:00.000000'
      )
    `.execute(database),
  );
}

async function testCategoryIntegrity(
  database: Kysely<Database>,
): Promise<void> {
  await expectRejected("entry category from another contest", () =>
    sql`
      INSERT INTO entries (
        id, contest_id, normalized_callsign, display_callsign, current_category_id,
        current_category_observed_at, metadata, created_at, updated_at
      ) VALUES (
        104, 11, 'WRONGCAT', 'WRONGCAT', 100, '2026-09-11 12:00:00.000000', NULL,
        '2026-09-11 12:00:00.000000', '2026-09-11 12:00:00.000000'
      )
    `.execute(database),
  );

  await expectRejected("snapshot category from another contest", () =>
    sql`
      INSERT INTO score_snapshots (
        id, entry_id, contest_id, source_id, raw_message_id, category_id, category_raw,
        source_timestamp, source_timestamp_raw, source_timestamp_quality, received_at,
        score, qso_total, points_total, mult_total, raw_metrics, normalized_fingerprint,
        acceptance_status, anomaly_flags, created_at
      ) VALUES (
        1004, 101, 11, 1, 201, 100, NULL, '${UTC_TIMESTAMP}', NULL, 'EXACT',
        '${UTC_TIMESTAMP}', 1, 1, 1, 1, JSON_OBJECT(), UNHEX(SHA2('wrong-category', 256)),
        'ACCEPTED', NULL, '${UTC_TIMESTAMP}'
      )
    `.execute(database),
  );
}

async function testNonMonotonicCounters(
  database: Kysely<Database>,
): Promise<void> {
  await insertSnapshot(database, {
    id: 1000,
    entryId: 100,
    fingerprint: "dm7ee-score-36594",
    sourceTimestamp: UTC_TIMESTAMP,
    score: 36594,
    qsoTotal: 342,
  });
  await insertSnapshot(database, {
    id: 1001,
    entryId: 100,
    fingerprint: "dm7ee-reset",
    sourceTimestamp: "2026-09-11 12:30:00.000000",
    score: 0,
    qsoTotal: 0,
  });
  await insertSnapshot(database, {
    id: 1002,
    entryId: 102,
    fingerprint: "entry-102-canonical",
    sourceTimestamp: "2026-09-11 12:36:00.000000",
    score: 200,
    qsoTotal: 20,
  });
  await insertSnapshot(database, {
    id: 1003,
    entryId: 102,
    fingerprint: "entry-102-not-canonical",
    sourceTimestamp: "2026-09-11 12:32:00.000000",
    score: 150,
    qsoTotal: 15,
  });
  await sql`
    INSERT INTO band_snapshots (snapshot_id, band, mode, qso, points, mult1, mult2)
    VALUES (1000, '20M', 'CW', 342, 36594, 1, 0)
  `.execute(database);

  const result = await sql<SnapshotRow>`
    SELECT CAST(score AS CHAR) AS score, CAST(qso_total AS CHAR) AS qsoTotal
    FROM score_snapshots
    WHERE id = 1001
  `.execute(database);
  assert(result.rows[0]?.score === "0", "Reset score was not retained.");
  assert(result.rows[0]?.qsoTotal === "0", "Reset QSO total was not retained.");
}

async function testTimestampPrecision(
  database: Kysely<Database>,
): Promise<void> {
  const result = await sql<StringRow>`
    SELECT DATE_FORMAT(source_timestamp, '%Y-%m-%d %H:%i:%s.%f') AS value
    FROM score_snapshots
    WHERE id = 1000
  `.execute(database);
  assert(
    result.rows[0]?.value === UTC_TIMESTAMP,
    "DATETIME(6) lost microseconds.",
  );
}

async function testSnapshotDeduplication(
  database: Kysely<Database>,
): Promise<void> {
  await expectRejected("duplicate normalized snapshot fingerprint", () =>
    insertSnapshot(database, {
      id: 1005,
      entryId: 100,
      fingerprint: "dm7ee-score-36594",
      sourceTimestamp: "2026-09-11 12:35:00.000000",
      score: 36594,
      qsoTotal: 342,
    }),
  );
}

async function testAppendOnlyDiagnostics(
  database: Kysely<Database>,
): Promise<void> {
  const before = await readSnapshot(database, 1001);
  await sql`
    INSERT INTO score_snapshot_flags (
      id, snapshot_id, flag, detected_at, details, diagnostic_fingerprint
    ) VALUES (
      1, 1001, 'OUT_OF_ORDER', '2026-09-11 12:41:00.000000',
      JSON_OBJECT('reason', 'late source observation'),
      UNHEX(SHA2('snapshot-1001-out-of-order', 256))
    )
  `.execute(database);
  const after = await readSnapshot(database, 1001);
  assert(
    before.score === after.score && before.qsoTotal === after.qsoTotal,
    "Attaching a flag must not mutate score_snapshots.",
  );

  const flags = await sql<NumberRow>`
    SELECT COUNT(*) AS value
    FROM score_snapshot_flags
    WHERE snapshot_id = 1001 AND flag = 'OUT_OF_ORDER'
  `.execute(database);
  assert(flags.rows[0]?.value === 1, "OUT_OF_ORDER flag was not appended.");
}

async function testCanonicalIntegrity(
  database: Kysely<Database>,
): Promise<void> {
  await sql`
    INSERT INTO canonical_score_events (
      id, entry_id, score_snapshot_id, selected_at, effective_at,
      selection_basis, selection_reason, context
    ) VALUES
      (
        900, 100, 1000, '2026-09-11 12:42:00.000000', '${UTC_TIMESTAMP}',
        'INTEGRATION_TEST', 'valid pointer', JSON_OBJECT('test', TRUE)
      ),
      (
        901, 102, 1002, '2026-09-11 12:42:00.000000',
        '2026-09-11 12:36:00.000000', 'INTEGRATION_TEST', 'mismatch fixture',
        JSON_OBJECT('test', TRUE)
      )
  `.execute(database);
  await sql`
    INSERT INTO current_scores (
      entry_id, canonical_event_id, canonical_snapshot_id, updated_at
    ) VALUES (100, 900, 1000, '2026-09-11 12:42:00.000000')
  `.execute(database);

  const current = await sql<CurrentScoreRow>`
    SELECT
      CAST(canonical_event_id AS CHAR) AS canonicalEventId,
      CAST(canonical_snapshot_id AS CHAR) AS canonicalSnapshotId
    FROM current_scores
    WHERE entry_id = 100
  `.execute(database);
  assert(
    current.rows[0]?.canonicalEventId === "900" &&
      current.rows[0]?.canonicalSnapshotId === "1000",
    "Valid current score pointers were not retained.",
  );

  await expectRejected("mismatched canonical event and snapshot", () =>
    sql`
      INSERT INTO current_scores (
        entry_id, canonical_event_id, canonical_snapshot_id, updated_at
      ) VALUES (102, 901, 1003, '2026-09-11 12:42:00.000000')
    `.execute(database),
  );
}

async function testCanonicalTimeOrdering(
  database: Kysely<Database>,
): Promise<void> {
  const snapshots = await sql<NumberRow>`
    SELECT COUNT(*) AS value
    FROM score_snapshots
    WHERE entry_id = 100
  `.execute(database);
  const events = await sql<NumberRow>`
    SELECT COUNT(*) AS value
    FROM canonical_score_events
    WHERE entry_id = 100
  `.execute(database);
  assert(snapshots.rows[0]?.value === 2, "Expected both DM7EE snapshots.");
  assert(
    events.rows[0]?.value === 1,
    "Expected only one DM7EE canonical event.",
  );

  const olderSnapshot = await sql<StringRow>`
    SELECT DATE_FORMAT(source_timestamp, '%Y-%m-%d %H:%i:%s.%f') AS value
    FROM score_snapshots
    WHERE id = 1001
  `.execute(database);
  assert(
    olderSnapshot.rows[0]?.value === "2026-09-11 12:30:00.000000",
    "Older accepted snapshot was not preserved.",
  );
}

async function testRestrictiveDeletion(
  database: Kysely<Database>,
): Promise<void> {
  await expectRejected("delete referenced source", () =>
    sql`DELETE FROM sources WHERE id = 1`.execute(database),
  );
  await expectRejected("delete referenced contest", () =>
    sql`DELETE FROM contests WHERE id = 10`.execute(database),
  );
  await expectRejected("delete referenced entry", () =>
    sql`DELETE FROM entries WHERE id = 100`.execute(database),
  );
  await expectRejected("delete referenced snapshot", () =>
    sql`DELETE FROM score_snapshots WHERE id = 1000`.execute(database),
  );
  await expectRejected("delete referenced canonical event", () =>
    sql`DELETE FROM canonical_score_events WHERE id = 900`.execute(database),
  );

  const cascades = await sql<NumberRow>`
    SELECT COUNT(*) AS value
    FROM information_schema.referential_constraints
    WHERE constraint_schema = DATABASE()
      AND (delete_rule = 'CASCADE' OR update_rule = 'CASCADE')
  `.execute(database);
  assert(cascades.rows[0]?.value === 0, "No foreign key may use CASCADE.");
}

async function testAdvisoryLock(databaseUrl: string): Promise<void> {
  const lockOwner = createDatabase({ databaseUrl, connectionLimit: 1 });
  const competitor = createDatabase({ databaseUrl, connectionLimit: 1 });
  try {
    const first = await getLock(lockOwner, LOCK_NAME);
    assert(first === 1, "The first advisory lock acquisition must succeed.");

    const second = await getLock(competitor, LOCK_NAME);
    assert(second === 0, "A second connection must not acquire the lock.");

    const released = await releaseLock(lockOwner, LOCK_NAME);
    assert(released === 1, "The lock owner must release the advisory lock.");

    const afterRelease = await getLock(competitor, LOCK_NAME);
    assert(afterRelease === 1, "Lock acquisition must succeed after release.");
    const secondRelease = await releaseLock(competitor, LOCK_NAME);
    assert(
      secondRelease === 1,
      "The second owner must release the advisory lock.",
    );
  } finally {
    await Promise.all([lockOwner.destroy(), competitor.destroy()]);
  }
}

async function testRawMessageBatchSemantics(
  database: Kysely<Database>,
): Promise<void> {
  const rawMessage = await sql<{
    acceptedCount: number;
    duplicateCount: number;
    observationCount: number;
    rejectedCount: number;
  }>`
    SELECT
      accepted_count AS acceptedCount,
      duplicate_count AS duplicateCount,
      observation_count AS observationCount,
      rejected_count AS rejectedCount
    FROM raw_messages
    WHERE id = 200
  `.execute(database);
  const row = rawMessage.rows[0];
  assert(
    row?.observationCount === 6 &&
      row.acceptedCount === 4 &&
      row.duplicateCount === 1 &&
      row.rejectedCount === 1,
    "Raw-message counters did not retain mixed batch outcomes.",
  );

  const snapshots = await sql<NumberRow>`
    SELECT COUNT(*) AS value
    FROM score_snapshots
    WHERE raw_message_id = 200
  `.execute(database);
  assert(
    snapshots.rows[0]?.value === 4,
    "One raw message must be able to own multiple score snapshots.",
  );
}

async function insertSnapshot(
  database: Kysely<Database>,
  fixture: {
    entryId: number;
    fingerprint: string;
    id: number;
    qsoTotal: number;
    score: number;
    sourceTimestamp: string;
  },
): Promise<void> {
  await sql`
    INSERT INTO score_snapshots (
      id, entry_id, contest_id, source_id, raw_message_id, category_id, category_raw,
      source_timestamp, source_timestamp_raw, source_timestamp_quality, received_at,
      score, qso_total, points_total, mult_total, raw_metrics, normalized_fingerprint,
      acceptance_status, anomaly_flags, created_at
    ) VALUES (
      ${fixture.id}, ${fixture.entryId}, 10, 1, 200, 100, JSON_OBJECT('observed', TRUE),
      ${fixture.sourceTimestamp}, ${fixture.sourceTimestamp}, 'EXACT',
      '2026-09-11 12:40:00.000000', ${fixture.score}, ${fixture.qsoTotal},
      ${fixture.score}, 1, JSON_OBJECT('source_total_authoritative', TRUE),
      UNHEX(SHA2(${fixture.fingerprint}, 256)), 'ACCEPTED', NULL,
      '2026-09-11 12:40:00.000000'
    )
  `.execute(database);
}

async function readSnapshot(
  database: Kysely<Database>,
  snapshotId: number,
): Promise<SnapshotRow> {
  const result = await sql<SnapshotRow>`
    SELECT CAST(score AS CHAR) AS score, CAST(qso_total AS CHAR) AS qsoTotal
    FROM score_snapshots
    WHERE id = ${snapshotId}
  `.execute(database);
  const row = result.rows[0];
  assert(row, `Snapshot ${snapshotId} was not found.`);
  return row;
}

async function getLock(
  database: Kysely<Database>,
  lockName: string,
): Promise<number | null> {
  const result = await sql<{ acquired: number | null }>`
    SELECT GET_LOCK(${lockName}, 0) AS acquired
  `.execute(database);
  return result.rows[0]?.acquired ?? null;
}

async function releaseLock(
  database: Kysely<Database>,
  lockName: string,
): Promise<number | null> {
  const result = await sql<{ released: number | null }>`
    SELECT RELEASE_LOCK(${lockName}) AS released
  `.execute(database);
  return result.rows[0]?.released ?? null;
}

async function expectRejected(
  label: string,
  operation: () => Promise<unknown>,
): Promise<void> {
  try {
    await operation();
  } catch {
    return;
  }
  throw new Error(`Expected ${label} to be rejected.`);
}

function assert(condition: unknown, message: string): asserts condition {
  if (!condition) {
    throw new Error(message);
  }
}

main().catch((error: unknown) => {
  console.error(
    error instanceof Error
      ? error.message
      : "Unknown integration validation error.",
  );
  process.exitCode = 1;
});
