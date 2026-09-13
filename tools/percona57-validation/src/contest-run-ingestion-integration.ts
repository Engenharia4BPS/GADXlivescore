import { randomUUID } from "node:crypto";
import {
  CollectorIngestionService,
  type CollectorReceipt,
  contestRunDisplayScorePayloadAdapter,
  KyselyIngestionRepository,
  normalizedFingerprint,
  type ReceiptResult,
  redactReceipt,
  sha256,
} from "@araucaria/collector-ingestion";
import {
  createDatabase,
  type Database,
  type DatabaseId,
  type JsonValue,
  serializeJson,
} from "@araucaria/database";
import { ContestRunHttpClient } from "@araucaria/source-adapters";
import { type Kysely, sql } from "kysely";

import {
  contestRunFixtureEvidence,
  phase2E4FixtureNamespace,
} from "./contest-run-ingestion-fixture.js";
import {
  assertKyselyTestDatabase,
  PERCONA57_TEST_DATABASE,
  requirePercona57TestDatabaseUrl,
} from "./safety.js";

const TEST_ID = 91;

let stage = "startup";
let passEmitted = false;
let incompleteEmitted = false;
let primaryFailureStage: string | undefined;

process.once("beforeExit", (beforeExitCode) => {
  if (passEmitted || incompleteEmitted) return;
  incompleteEmitted = true;
  process.stderr.write(
    `${JSON.stringify({
      status: "INCOMPLETE",
      stage: primaryFailureStage ?? stage,
      beforeExitCode,
    })}\n`,
  );
  if (!process.exitCode || process.exitCode === 0) process.exitCode = 1;
});

interface Fixture {
  collectorSourceContestId: DatabaseId;
  contestExternalId: DatabaseId;
  contestId: DatabaseId;
  namespace: string;
  sourceId: DatabaseId;
}

interface CountRow {
  count: number | string;
}

interface RawMessageRow {
  payloadRedacted: Uint8Array;
  payloadSha256: Uint8Array;
  processingStatus: string;
  observationCount: number;
  acceptedCount: number;
  duplicateCount: number;
  rejectedCount: number;
}

interface RawMetricsRow {
  rawMetrics: JsonValue | string | null;
}

interface FixtureCounts {
  bandSnapshotCount: number;
  canonicalEventCount: number;
  currentScoreCount: number;
  persistedSnapshotCount: number;
  rawMetricsCount: number;
  unzonedTimestampCount: number;
}

interface RunEvidence {
  acceptedCount: number;
  duplicateCount: number;
  observationCount: number;
  rawMessageId: DatabaseId;
  rejectedCount: number;
  status: string;
  sourceRowCount: number;
}

async function main(): Promise<void> {
  stage = "connect";
  const databaseUrl = requirePercona57TestDatabaseUrl();
  const database = createDatabase({ databaseUrl, connectionLimit: 1 });
  let fixture: Fixture | undefined;
  let cleaned = false;
  let passOutput: string | undefined;

  try {
    stage = "safety-guard";
    await assertKyselyTestDatabase(database);
    fixture = await seedFixture(database, TEST_ID);
    const client = new ContestRunHttpClient();
    const repository = new KyselyIngestionRepository(database);
    const service = new CollectorIngestionService(repository);

    stage = "first-fetch";
    const firstResponse = await client.displayScore(TEST_ID);
    assert(
      !containsAuthKey(firstResponse.data),
      "Source-adapter displayscore DTO retained auth.",
    );
    const firstReceipt = receiptFor(fixture, firstResponse.rawPayload, {
      responseBytes: firstResponse.metadata.responseBytes,
      durationMs: firstResponse.metadata.durationMs,
    });
    stage = "first-ingestion";
    const firstResult = await service.ingest(
      firstReceipt,
      contestRunDisplayScorePayloadAdapter,
    );
    await assertStoredRawReceipt(
      database,
      firstResult,
      firstResponse.rawPayload,
    );
    assertRunAccountsForSourceRows(
      firstResult,
      firstResponse.data.records.length,
    );
    assert(
      firstResult.acceptedCount > 0,
      "First displayscore receipt did not persist an accepted snapshot.",
    );
    const firstFingerprints = normalizedFingerprintHexes(firstReceipt);

    stage = "second-fetch";
    const secondResponse = await client.displayScore(TEST_ID);
    assert(
      !containsAuthKey(secondResponse.data),
      "Source-adapter displayscore DTO retained auth.",
    );
    const secondReceipt = receiptFor(fixture, secondResponse.rawPayload, {
      responseBytes: secondResponse.metadata.responseBytes,
      durationMs: secondResponse.metadata.durationMs,
    });
    stage = "second-ingestion";
    const secondResult = await service.ingest(
      secondReceipt,
      contestRunDisplayScorePayloadAdapter,
    );
    await assertStoredRawReceipt(
      database,
      secondResult,
      secondResponse.rawPayload,
    );
    assertRunAccountsForSourceRows(
      secondResult,
      secondResponse.data.records.length,
    );
    const changedObservationCount = countChangedObservations(
      firstFingerprints,
      normalizedFingerprintHexes(secondReceipt),
    );
    if (changedObservationCount === 0) {
      assert(
        secondResult.acceptedCount === 0 &&
          secondResult.duplicateCount ===
            secondResult.observationCount - secondResult.rejectedCount,
        "Identical normalized observations were not all classified as duplicates.",
      );
    }

    stage = "persistence-assertions";
    const counts = await fixtureCounts(database, fixture);
    assert(
      counts.persistedSnapshotCount ===
        firstResult.acceptedCount + secondResult.acceptedCount,
      "Fixture snapshot count does not match accepted observations.",
    );
    assert(
      counts.bandSnapshotCount > 0,
      "Accepted contest.run observations did not preserve any band rows.",
    );
    assert(
      counts.rawMetricsCount === counts.persistedSnapshotCount,
      "Accepted contest.run observations did not preserve raw source metrics.",
    );
    assert(
      counts.canonicalEventCount === 0 && counts.currentScoreCount === 0,
      "UNZONED_SOURCE_TEXT observations must not create canonical state.",
    );
    assert(
      counts.unzonedTimestampCount === counts.persistedSnapshotCount,
      "Fixture snapshots did not retain the unzoned timestamp classification.",
    );
    const authRedactionVerified = await assertAuthRedaction(database, fixture, [
      firstResult.rawMessageId,
      secondResult.rawMessageId,
    ]);

    stage = "cleanup";
    await cleanupFixture(database, fixture);
    cleaned = true;
    stage = "cleanup-verification";
    const cleanupRemainingFixtureRows = await assertFixtureClean(
      database,
      fixture,
    );
    passOutput = JSON.stringify(
      {
        status: "PASS",
        database: PERCONA57_TEST_DATABASE,
        testId: TEST_ID,
        sourceRowCount: firstResponse.data.records.length,
        firstRun: reportRun(firstResult, firstResponse.data.records.length),
        secondRun: {
          ...reportRun(secondResult, secondResponse.data.records.length),
          changedObservationCount,
        },
        persistedSnapshotCount: counts.persistedSnapshotCount,
        bandSnapshotCount: counts.bandSnapshotCount,
        canonicalEventCount: counts.canonicalEventCount,
        currentScoreCount: counts.currentScoreCount,
        unzonedTimestampCount: counts.unzonedTimestampCount,
        authRedactionVerified,
        cleanupRemainingFixtureRows,
      },
      null,
      2,
    );
  } finally {
    if (passOutput === undefined) primaryFailureStage ??= stage;
    if (fixture && !cleaned) {
      stage = "cleanup";
      await cleanupFixture(database, fixture);
      cleaned = true;
      stage = "cleanup-verification";
      await assertFixtureClean(database, fixture);
    }
    stage = "connection-close";
    await database.destroy();
  }

  if (passOutput === undefined)
    throw new Error("Pass output was not prepared after validation.");
  stage = "pass-output";
  await writeStdout(passOutput);
  passEmitted = true;
}

async function seedFixture(
  database: Kysely<Database>,
  testId: number,
): Promise<Fixture> {
  const namespace = phase2E4FixtureNamespace(randomUUID());
  const now = utcNow();
  return database.transaction().execute(async (trx) => {
    const source = await trx
      .insertInto("sources")
      .values({
        code: namespace,
        kind: "EXTERNAL_SERVER",
        precedence_rank: 1,
        display_name: namespace,
        base_url: "https://contest.run",
        default_config: null,
        enabled: 0,
        created_at: now,
        updated_at: now,
      })
      .executeTakeFirstOrThrow();
    if (source.insertId === undefined)
      throw new Error("Fixture source insert returned no id.");
    const sourceId = String(source.insertId);
    const evidence = contestRunFixtureEvidence(namespace, testId);
    const contest = await trx
      .insertInto("contests")
      .values({
        name: namespace,
        normalized_name: namespace.toLowerCase(),
        slug: `phase2e4-${namespace.slice(-24).toLowerCase()}`,
        status: "TEST",
        start_at: null,
        end_at: null,
        time_zone: null,
        metadata: serializeJson(evidence),
        created_at: now,
        updated_at: now,
      })
      .executeTakeFirstOrThrow();
    if (contest.insertId === undefined)
      throw new Error("Fixture contest insert returned no id.");
    const contestId = String(contest.insertId);
    const external = await trx
      .insertInto("contest_external_ids")
      .values({
        contest_id: contestId,
        source_id: sourceId,
        external_id: String(testId),
        external_name: null,
        external_calendar_code: null,
        start_day: null,
        start_time: null,
        finish_day: null,
        finish_time: null,
        metadata: serializeJson(evidence),
        last_observed_at: null,
        created_at: now,
        updated_at: now,
      })
      .executeTakeFirstOrThrow();
    if (external.insertId === undefined)
      throw new Error("Fixture contest external ID insert returned no id.");
    const contestExternalId = String(external.insertId);
    const mapping = await trx
      .insertInto("collector_source_contests")
      .values({
        source_id: sourceId,
        contest_id: contestId,
        contest_external_id_id: contestExternalId,
        enabled: 0,
        poll_interval_seconds: null,
        configuration: serializeJson(evidence),
        last_success_at: null,
        last_failure_at: null,
        next_poll_at: null,
        created_at: now,
        updated_at: now,
      })
      .executeTakeFirstOrThrow();
    if (mapping.insertId === undefined)
      throw new Error("Fixture collector mapping insert returned no id.");
    return {
      sourceId,
      contestId,
      contestExternalId,
      collectorSourceContestId: String(mapping.insertId),
      namespace,
    };
  });
}

function receiptFor(
  fixture: Fixture,
  payload: Uint8Array,
  metadata: { durationMs: number; responseBytes: number },
): CollectorReceipt {
  return {
    sourceId: fixture.sourceId,
    contestId: fixture.contestId,
    collectorSourceContestId: fixture.collectorSourceContestId,
    receivedAt: utcNow(),
    messageKind: "CONTEST_RUN_DISPLAYSCORE",
    payload,
    request: {
      method: "GET",
      path: `/api/displayscore/${TEST_ID}`,
      responseStatus: 200,
      contentType: "application/json",
    },
    metadata: {
      fixture_namespace: fixture.namespace,
      endpoint: "displayscore",
      test_id: TEST_ID,
      response_bytes: metadata.responseBytes,
      duration_ms: metadata.durationMs,
    },
  };
}

function normalizedFingerprintHexes(
  receipt: CollectorReceipt,
): readonly string[] {
  const parsed = contestRunDisplayScorePayloadAdapter.parse(
    redactReceipt(receipt),
  );
  return parsed.observations.map((observation) =>
    Buffer.from(normalizedFingerprint(observation)).toString("hex"),
  );
}

function countChangedObservations(
  first: readonly string[],
  second: readonly string[],
): number {
  const firstFingerprints = new Set(first);
  return second.filter((fingerprint) => !firstFingerprints.has(fingerprint))
    .length;
}

async function assertStoredRawReceipt(
  database: Kysely<Database>,
  result: ReceiptResult,
  originalPayload: Uint8Array,
): Promise<void> {
  const row = await database
    .selectFrom("raw_messages")
    .select([
      "payload_redacted as payloadRedacted",
      "payload_sha256 as payloadSha256",
      "processing_status as processingStatus",
      "observation_count as observationCount",
      "accepted_count as acceptedCount",
      "duplicate_count as duplicateCount",
      "rejected_count as rejectedCount",
    ])
    .where("id", "=", result.rawMessageId)
    .executeTakeFirst();
  assert(row, "Raw receipt was not committed before observation processing.");
  const raw = row as RawMessageRow;
  assert(
    raw.processingStatus === result.status &&
      raw.observationCount === result.observationCount &&
      raw.acceptedCount === result.acceptedCount &&
      raw.duplicateCount === result.duplicateCount &&
      raw.rejectedCount === result.rejectedCount,
    "Durable raw receipt counters or final status do not match ingestion.",
  );
  assert(
    equalBytes(raw.payloadSha256, sha256(originalPayload)),
    "Raw receipt payload SHA-256 was not derived from the original response.",
  );
  assert(
    !containsAuthKey(parseRedactedPayload(raw.payloadRedacted)),
    "Persisted raw receipt retained auth.",
  );
}

function assertRunAccountsForSourceRows(
  result: ReceiptResult,
  sourceRowCount: number,
): void {
  assert(
    result.observationCount === sourceRowCount &&
      result.acceptedCount + result.duplicateCount + result.rejectedCount ===
        result.observationCount,
    "Ingestion result does not account for every displayscore source row.",
  );
}

async function fixtureCounts(
  database: Kysely<Database>,
  fixture: Fixture,
): Promise<FixtureCounts> {
  const [snapshots, bands, events, current, rawMetrics, unzoned] =
    await Promise.all([
      count(
        database,
        sql<CountRow>`
      SELECT COUNT(*) AS count
      FROM score_snapshots
      WHERE source_id = ${fixture.sourceId}
    `,
        "fixture snapshot count",
      ),
      count(
        database,
        sql<CountRow>`
      SELECT COUNT(*) AS count
      FROM band_snapshots AS band
      INNER JOIN score_snapshots AS snapshot ON snapshot.id = band.snapshot_id
      WHERE snapshot.source_id = ${fixture.sourceId}
    `,
        "fixture band snapshot count",
      ),
      count(
        database,
        sql<CountRow>`
      SELECT COUNT(*) AS count
      FROM canonical_score_events AS event
      INNER JOIN score_snapshots AS snapshot
        ON snapshot.id = event.score_snapshot_id
      WHERE snapshot.source_id = ${fixture.sourceId}
    `,
        "fixture canonical event count",
      ),
      count(
        database,
        sql<CountRow>`
      SELECT COUNT(*) AS count
      FROM current_scores AS current
      INNER JOIN entries AS entry ON entry.id = current.entry_id
      WHERE entry.contest_id = ${fixture.contestId}
    `,
        "fixture current score count",
      ),
      count(
        database,
        sql<CountRow>`
      SELECT COUNT(*) AS count
      FROM score_snapshots
      WHERE source_id = ${fixture.sourceId}
        AND raw_metrics IS NOT NULL
    `,
        "fixture raw metrics count",
      ),
      count(
        database,
        sql<CountRow>`
      SELECT COUNT(*) AS count
      FROM score_snapshots
      WHERE source_id = ${fixture.sourceId}
        AND source_timestamp IS NULL
        AND source_timestamp_quality = 'UNZONED_SOURCE_TEXT'
    `,
        "fixture unzoned timestamp count",
      ),
    ]);
  return {
    persistedSnapshotCount: snapshots,
    bandSnapshotCount: bands,
    canonicalEventCount: events,
    currentScoreCount: current,
    rawMetricsCount: rawMetrics,
    unzonedTimestampCount: unzoned,
  };
}

async function assertAuthRedaction(
  database: Kysely<Database>,
  fixture: Fixture,
  rawMessageIds: readonly DatabaseId[],
): Promise<true> {
  const rawMetrics = await database
    .selectFrom("score_snapshots")
    .select("raw_metrics as rawMetrics")
    .where("source_id", "=", fixture.sourceId)
    .execute();
  const rawMessages = await database
    .selectFrom("raw_messages")
    .select("payload_redacted as payloadRedacted")
    .where("id", "in", rawMessageIds)
    .execute();
  assert(
    rawMessages.length === rawMessageIds.length &&
      rawMessages.every(
        (message) =>
          !containsAuthKey(parseRedactedPayload(message.payloadRedacted)),
      ) &&
      rawMetrics.every(
        (row) =>
          !containsAuthKey(parseJsonColumn((row as RawMetricsRow).rawMetrics)),
      ),
    "Persisted contest.run evidence retained auth.",
  );
  return true;
}

async function cleanupFixture(
  database: Kysely<Database>,
  fixture: Fixture,
): Promise<void> {
  await assertKyselyTestDatabase(database);
  await database.transaction().execute(async (trx) => {
    const entries = await trx
      .selectFrom("entries")
      .select("id")
      .where("contest_id", "=", fixture.contestId)
      .execute();
    const entryIds = entries.map((entry) => entry.id);
    const snapshots = entryIds.length
      ? await trx
          .selectFrom("score_snapshots")
          .select("id")
          .where("entry_id", "in", entryIds)
          .execute()
      : [];
    const snapshotIds = snapshots.map((snapshot) => snapshot.id);

    if (entryIds.length)
      await trx
        .deleteFrom("current_scores")
        .where("entry_id", "in", entryIds)
        .execute();
    if (snapshotIds.length)
      await trx
        .deleteFrom("score_snapshot_flags")
        .where("snapshot_id", "in", snapshotIds)
        .execute();
    if (entryIds.length)
      await trx
        .deleteFrom("canonical_score_events")
        .where("entry_id", "in", entryIds)
        .execute();
    if (snapshotIds.length)
      await trx
        .deleteFrom("band_snapshots")
        .where("snapshot_id", "in", snapshotIds)
        .execute();
    if (snapshotIds.length)
      await trx
        .deleteFrom("score_snapshots")
        .where("id", "in", snapshotIds)
        .execute();
    await trx
      .deleteFrom("raw_messages")
      .where("source_id", "=", fixture.sourceId)
      .execute();
    await trx
      .deleteFrom("collector_runs")
      .where("source_id", "=", fixture.sourceId)
      .execute();
    await trx
      .deleteFrom("collector_source_contests")
      .where("id", "=", fixture.collectorSourceContestId)
      .execute();
    await trx
      .deleteFrom("contest_category_external_ids")
      .where("contest_id", "=", fixture.contestId)
      .execute();
    await trx
      .deleteFrom("entries")
      .where("contest_id", "=", fixture.contestId)
      .execute();
    await trx
      .deleteFrom("contest_categories")
      .where("contest_id", "=", fixture.contestId)
      .execute();
    await trx
      .deleteFrom("contest_external_ids")
      .where("id", "=", fixture.contestExternalId)
      .execute();
    await trx
      .deleteFrom("contests")
      .where("id", "=", fixture.contestId)
      .execute();
    await trx
      .deleteFrom("sources")
      .where("id", "=", fixture.sourceId)
      .execute();
  });
}

async function assertFixtureClean(
  database: Kysely<Database>,
  fixture: Fixture,
): Promise<number> {
  const counts = await Promise.all([
    count(
      database,
      sql<CountRow>`SELECT COUNT(*) AS count FROM sources WHERE id = ${fixture.sourceId}`,
      "fixture source count",
    ),
    count(
      database,
      sql<CountRow>`SELECT COUNT(*) AS count FROM contests WHERE id = ${fixture.contestId}`,
      "fixture contest count",
    ),
    count(
      database,
      sql<CountRow>`SELECT COUNT(*) AS count FROM contest_external_ids WHERE id = ${fixture.contestExternalId}`,
      "fixture external ID count",
    ),
    count(
      database,
      sql<CountRow>`SELECT COUNT(*) AS count FROM collector_source_contests WHERE id = ${fixture.collectorSourceContestId}`,
      "fixture mapping count",
    ),
    count(
      database,
      sql<CountRow>`SELECT COUNT(*) AS count FROM contest_categories WHERE contest_id = ${fixture.contestId}`,
      "fixture category count",
    ),
    count(
      database,
      sql<CountRow>`SELECT COUNT(*) AS count FROM entries WHERE contest_id = ${fixture.contestId}`,
      "fixture entry count",
    ),
    count(
      database,
      sql<CountRow>`SELECT COUNT(*) AS count FROM raw_messages WHERE source_id = ${fixture.sourceId}`,
      "fixture raw message count",
    ),
    count(
      database,
      sql<CountRow>`SELECT COUNT(*) AS count FROM score_snapshots WHERE source_id = ${fixture.sourceId}`,
      "fixture snapshot count",
    ),
    count(
      database,
      sql<CountRow>`SELECT COUNT(*) AS count FROM collector_runs WHERE source_id = ${fixture.sourceId}`,
      "fixture run count",
    ),
  ]);
  assert(
    counts.every((value) => value === 0),
    "Fixture cleanup was incomplete.",
  );
  return counts.reduce((total, value) => total + value, 0);
}

async function count(
  database: Kysely<Database>,
  query: ReturnType<typeof sql<CountRow>>,
  label: string,
): Promise<number> {
  const result = await query.execute(database);
  return readCount(result.rows[0]?.count, label);
}

function reportRun(result: ReceiptResult, sourceRowCount: number): RunEvidence {
  return {
    observationCount: result.observationCount,
    acceptedCount: result.acceptedCount,
    duplicateCount: result.duplicateCount,
    rejectedCount: result.rejectedCount,
    rawMessageId: result.rawMessageId,
    status: result.status,
    sourceRowCount,
  };
}

function readCount(value: unknown, label: string): number {
  if (typeof value === "number" && Number.isSafeInteger(value) && value >= 0)
    return value;
  if (typeof value === "string" && /^(0|[1-9]\d*)$/.test(value)) {
    const count = Number(value);
    if (Number.isSafeInteger(count)) return count;
  }
  throw new Error(`${label} returned an invalid scalar count.`);
}

function parseRedactedPayload(value: Uint8Array): unknown {
  return JSON.parse(new TextDecoder().decode(value));
}

function parseJsonColumn(value: JsonValue | string | null): unknown {
  return typeof value === "string" ? JSON.parse(value) : value;
}

function containsAuthKey(value: unknown): boolean {
  if (Array.isArray(value)) return value.some(containsAuthKey);
  if (!value || typeof value !== "object") return false;
  return Object.entries(value).some(
    ([key, child]) => key.toLowerCase() === "auth" || containsAuthKey(child),
  );
}

function equalBytes(left: Uint8Array, right: Uint8Array): boolean {
  return (
    left.length === right.length &&
    left.every((value, index) => value === right[index])
  );
}

function utcNow(): string {
  return new Date().toISOString().replace("T", " ").replace("Z", "");
}

function assert(condition: unknown, message: string): asserts condition {
  if (!condition) throw new Error(message);
}

async function writeStdout(text: string): Promise<void> {
  await new Promise<void>((resolve, reject) => {
    process.stdout.write(`${text}\n`, (error) => {
      if (error) reject(error);
      else resolve();
    });
  });
}

try {
  await main();
} catch (error) {
  console.error(
    error instanceof Error
      ? error.message
      : "Unknown contest.run ingestion integration validation error.",
  );
  process.exitCode = 1;
}
