import { randomUUID } from "node:crypto";
import {
  CollectorIngestionService,
  type CollectorReceipt,
  KyselyIngestionRepository,
  type NormalizedScoreObservation,
  normalizedFingerprint,
  type PayloadAdapter,
} from "@araucaria/collector-ingestion";
import {
  createDatabase,
  type Database,
  type DatabaseId,
  serializeJson,
} from "@araucaria/database";
import { type Kysely, sql } from "kysely";

import {
  assertKyselyTestDatabase,
  PERCONA57_TEST_DATABASE,
  requirePercona57TestDatabaseUrl,
} from "./safety.js";

const FIXTURE_TIME = "2026-09-12 12:00:00.000000";

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
  categoryId: DatabaseId;
  contestId: DatabaseId;
  namespace: string;
  sourceId: DatabaseId;
}

interface CountRow {
  count: number | string;
}

interface CurrentRow {
  canonicalEventId: DatabaseId;
  canonicalSnapshotId: DatabaseId;
  eventSnapshotId: DatabaseId;
}

interface RawMessageRow {
  processingStatus: string;
}

interface SnapshotRow {
  id: DatabaseId;
  multTotal: string | null;
  pointsTotal: string | null;
  qsoTotal: string | null;
  score: string | null;
}

interface FlagRow {
  count: number | string;
}

interface TimeZoneRow {
  timeZone: string;
}

interface ValidationEvidence {
  acceptedSnapshotCount: number;
  canonicalEventCount: number;
  duplicateCount: number;
  outOfOrderFlagCount: number;
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
    const timeZone = await sql<TimeZoneRow>`
      SELECT @@session.time_zone AS timeZone
    `.execute(database);
    assert(
      timeZone.rows[0]?.timeZone === "+00:00",
      "Collector ingestion session did not use UTC.",
    );
    stage = "fixture-setup";
    fixture = await seedFixture(database);
    const validationEvidence = await validateCollectorIngestion(
      database,
      fixture,
    );
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
        validation: {
          rawReceiptCommitted: true,
          acceptedSnapshotPersisted: true,
          initialCanonicalCreated: true,
          timestampOnlyCanonicalAdvance: true,
          duplicateRejected: true,
          resetPreserved: true,
          aggregateBandMismatchPreserved: true,
          currentPointerConsistent: true,
          outOfOrderFlagged: true,
          outOfOrderDidNotRewindCurrent: true,
          cleanupZeroFixtures: true,
          ...validationEvidence,
          cleanupRemainingFixtureRows,
        },
      },
      null,
      2,
    );
  } finally {
    if (passOutput === undefined) primaryFailureStage ??= stage;
    if (fixture && !cleaned) {
      stage = "cleanup";
      await cleanupFixture(database, fixture);
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

async function seedFixture(database: Kysely<Database>): Promise<Fixture> {
  const token = randomUUID().replaceAll("-", "").toUpperCase();
  const namespace = `PHASE2D_TEST_${token}`;
  return database.transaction().execute(async (trx) => {
    const source = await trx
      .insertInto("sources")
      .values({
        code: namespace,
        kind: "EXTERNAL_SERVER",
        precedence_rank: 1,
        display_name: namespace,
        base_url: null,
        default_config: null,
        enabled: 1,
        created_at: FIXTURE_TIME,
        updated_at: FIXTURE_TIME,
      })
      .executeTakeFirstOrThrow();
    if (source.insertId === undefined)
      throw new Error("Fixture source insert returned no id.");
    const sourceId = String(source.insertId);
    const contest = await trx
      .insertInto("contests")
      .values({
        name: namespace,
        normalized_name: namespace.toLowerCase(),
        slug: `phase2d-${token.toLowerCase()}`,
        status: "ACTIVE",
        start_at: null,
        end_at: null,
        time_zone: "UTC",
        metadata: serializeJson({ fixture_namespace: namespace }),
        created_at: FIXTURE_TIME,
        updated_at: FIXTURE_TIME,
      })
      .executeTakeFirstOrThrow();
    if (contest.insertId === undefined)
      throw new Error("Fixture contest insert returned no id.");
    const contestId = String(contest.insertId);
    const category = await trx
      .insertInto("contest_categories")
      .values({
        contest_id: contestId,
        category_key: "PHASE2D",
        display_name: "Phase 2D fixture",
        metadata: serializeJson({ fixture_namespace: namespace }),
        active: 1,
        created_at: FIXTURE_TIME,
        updated_at: FIXTURE_TIME,
      })
      .executeTakeFirstOrThrow();
    if (category.insertId === undefined)
      throw new Error("Fixture category insert returned no id.");
    return {
      sourceId,
      contestId,
      categoryId: String(category.insertId),
      namespace,
    };
  });
}

async function validateCollectorIngestion(
  database: Kysely<Database>,
  fixture: Fixture,
): Promise<ValidationEvidence> {
  const repository = new KyselyIngestionRepository(database);
  const service = new CollectorIngestionService(repository, () => FIXTURE_TIME);
  stage = "raw-receipt";
  const failedReceipt = await service.ingest(receipt(fixture, "receipt-only"), {
    parse: () => {
      throw new Error("Phase 2D fixture parser failure.");
    },
  });
  assert(
    failedReceipt.status === "FAILED",
    "Fixture parser failure must fail.",
  );
  const durableRaw = await database
    .selectFrom("raw_messages")
    .select("processing_status as processingStatus")
    .where("id", "=", failedReceipt.rawMessageId)
    .executeTakeFirst();
  assert(durableRaw, "Raw receipt was not committed before parsing.");
  assert(
    (durableRaw as RawMessageRow).processingStatus === "FAILED",
    "Durable raw receipt did not record the failed processing outcome.",
  );

  stage = "normal-observation";
  const first = observation(fixture, {
    callsign: "TEST1",
    sourceTimestamp: "2026-09-12 12:00:00.000000",
    score: "100",
    qsoTotal: "10",
    pointsTotal: "900",
    multTotal: "4",
    bands: [
      {
        band: "20M",
        mode: "CW",
        qso: "7",
        points: "700",
        mult1: "3",
        mult2: null,
      },
    ],
  });
  const firstResult = await service.ingest(
    receipt(fixture, "first"),
    adapter(first),
  );
  stage = "aggregate-band-mismatch";
  assert(firstResult.acceptedCount === 1, "First snapshot was not accepted.");
  const firstSnapshot = await snapshotByFingerprint(database, first);
  assert(firstSnapshot, "Accepted snapshot was not persisted.");
  assert(
    firstSnapshot.qsoTotal === "10" && firstSnapshot.pointsTotal === "900",
    "Source-authoritative aggregate totals were not preserved.",
  );
  const firstCurrent = await currentForCallsign(database, fixture, "TEST1");
  assert(firstCurrent, "First eligible snapshot did not become canonical.");
  assert(
    firstCurrent.canonicalSnapshotId === firstSnapshot.id &&
      firstCurrent.canonicalSnapshotId === firstCurrent.eventSnapshotId,
    "current_scores does not point to its canonical event snapshot.",
  );

  const newer: NormalizedScoreObservation = {
    ...first,
    sourceTimestamp: "2026-09-12 12:01:00.000000",
    sourceTimestampRaw: "2026-09-12 12:01:00.000000 UTC",
  };
  stage = "timestamp-only";
  const newerResult = await service.ingest(
    receipt(fixture, "newer"),
    adapter(newer),
  );
  assert(
    newerResult.acceptedCount === 1,
    "Timestamp-only update was not accepted as a new snapshot.",
  );
  const newerSnapshot = await snapshotByFingerprint(database, newer);
  assert(newerSnapshot, "Timestamp-only snapshot was not persisted.");
  const newerCurrent = await currentForCallsign(database, fixture, "TEST1");
  assert(
    newerCurrent?.canonicalSnapshotId === newerSnapshot.id,
    "Timestamp-only update did not advance the canonical pointer.",
  );
  assert(
    (await canonicalEventCount(database, newerSnapshot.id)) === 1,
    "Timestamp-only snapshot must have one canonical event.",
  );

  const beforeDuplicateSnapshots = await snapshotCountForCallsign(
    database,
    fixture,
    "TEST1",
  );
  const beforeDuplicateEvents = await canonicalEventCountForCallsign(
    database,
    fixture,
    "TEST1",
  );
  stage = "duplicate";
  const duplicateResult = await service.ingest(
    receipt(fixture, "duplicate"),
    adapter(newer),
  );
  assert(
    duplicateResult.duplicateCount === 1 && duplicateResult.acceptedCount === 0,
    "Exact normalized fingerprint was not treated as a duplicate.",
  );
  assert(
    (await snapshotCountForCallsign(database, fixture, "TEST1")) ===
      beforeDuplicateSnapshots &&
      (await canonicalEventCountForCallsign(database, fixture, "TEST1")) ===
        beforeDuplicateEvents,
    "Exact duplicate created a snapshot or canonical event.",
  );

  const beforeReset = observation(fixture, {
    callsign: "DM7EE_TEST",
    sourceTimestamp: "2026-09-12 12:02:00.000000",
    score: "36594",
    qsoTotal: "342",
    pointsTotal: "12345",
    multTotal: "107",
    bands: [],
  });
  stage = "reset-before";
  const beforeResetResult = await service.ingest(
    receipt(fixture, "before-reset"),
    adapter(beforeReset),
  );
  assert(
    beforeResetResult.acceptedCount === 1,
    "Pre-reset DM7EE snapshot was not accepted.",
  );
  const reset: NormalizedScoreObservation = {
    ...beforeReset,
    sourceTimestamp: "2026-09-12 12:03:00.000000",
    sourceTimestampRaw: "2026-09-12 12:03:00.000000 UTC",
    score: "0",
    qsoTotal: "0",
    multTotal: "0",
  };
  stage = "reset-after";
  const resetResult = await service.ingest(
    receipt(fixture, "reset"),
    adapter(reset),
  );
  assert(resetResult.acceptedCount === 1, "Reset snapshot was not accepted.");
  const resetSnapshot = await snapshotByFingerprint(database, reset);
  assert(resetSnapshot, "Reset snapshot was not persisted.");
  assert(
    resetSnapshot.score === "0" &&
      resetSnapshot.qsoTotal === "0" &&
      resetSnapshot.multTotal === "0",
    "Counter reset values were changed or rejected.",
  );
  const resetCurrent = await currentForCallsign(
    database,
    fixture,
    "DM7EE_TEST",
  );
  assert(
    resetCurrent?.canonicalSnapshotId === resetSnapshot.id &&
      resetCurrent.canonicalSnapshotId === resetCurrent.eventSnapshotId,
    "Newer reset did not become the matching current canonical state.",
  );

  const older: NormalizedScoreObservation = {
    ...beforeReset,
    sourceTimestamp: "2026-09-12 12:02:30.000000",
    sourceTimestampRaw: "2026-09-12 12:02:30.000000 UTC",
    score: "100",
    qsoTotal: "10",
    multTotal: "2",
  };
  stage = "out-of-order";
  const olderResult = await service.ingest(
    receipt(fixture, "out-of-order"),
    adapter(older),
  );
  assert(olderResult.acceptedCount === 1, "Older snapshot was not retained.");
  const olderSnapshot = await snapshotByFingerprint(database, older);
  assert(olderSnapshot, "Older snapshot was not persisted.");
  const outOfOrderFlags = await sql<FlagRow>`
    SELECT COUNT(*) AS count
    FROM score_snapshot_flags
    WHERE snapshot_id = ${olderSnapshot.id}
      AND flag = 'OUT_OF_ORDER'
  `.execute(database);
  const outOfOrderFlagCount = readCount(
    outOfOrderFlags.rows[0]?.count,
    "OUT_OF_ORDER flag count",
  );
  assert(
    outOfOrderFlagCount === 1,
    "Older same-source snapshot did not receive OUT_OF_ORDER.",
  );
  const afterOlderCurrent = await currentForCallsign(
    database,
    fixture,
    "DM7EE_TEST",
  );
  assert(
    afterOlderCurrent?.canonicalSnapshotId === resetSnapshot.id,
    "Out-of-order snapshot moved the current canonical pointer backward.",
  );
  stage = "assertions";
  return {
    acceptedSnapshotCount:
      firstResult.acceptedCount +
      newerResult.acceptedCount +
      beforeResetResult.acceptedCount +
      resetResult.acceptedCount +
      olderResult.acceptedCount,
    canonicalEventCount: await canonicalEventCountForFixture(database, fixture),
    duplicateCount: duplicateResult.duplicateCount,
    outOfOrderFlagCount,
  };
}

function receipt(fixture: Fixture, sequence: string): CollectorReceipt {
  return {
    sourceId: fixture.sourceId,
    contestId: fixture.contestId,
    receivedAt: FIXTURE_TIME,
    messageKind: "PHASE2D_TEST",
    payload: new TextEncoder().encode(
      JSON.stringify({ fixture: fixture.namespace, sequence }),
    ),
  };
}

function observation(
  fixture: Fixture,
  values: Omit<
    NormalizedScoreObservation,
    | "categoryId"
    | "categoryRaw"
    | "contestId"
    | "displayCallsign"
    | "fingerprintEvidence"
    | "normalizedCallsign"
    | "rawMetrics"
    | "sourceId"
    | "sourceTimestampQuality"
    | "sourceTimestampRaw"
  > & {
    callsign: string;
  },
): NormalizedScoreObservation {
  return {
    sourceId: fixture.sourceId,
    contestId: fixture.contestId,
    normalizedCallsign: values.callsign,
    displayCallsign: values.callsign,
    categoryId: fixture.categoryId,
    categoryRaw: { fixture_namespace: fixture.namespace },
    sourceTimestamp: values.sourceTimestamp,
    sourceTimestampRaw: `${values.sourceTimestamp} UTC`,
    sourceTimestampQuality: "CONFIRMED_UTC",
    score: values.score,
    qsoTotal: values.qsoTotal,
    pointsTotal: values.pointsTotal,
    multTotal: values.multTotal,
    rawMetrics: { transport_independent_fixture: fixture.namespace },
    fingerprintEvidence: { fixture_namespace: fixture.namespace },
    bands: values.bands,
  };
}

function adapter(observation: NormalizedScoreObservation): PayloadAdapter {
  return { parse: () => ({ observations: [observation], rejected: [] }) };
}

async function snapshotByFingerprint(
  database: Kysely<Database>,
  observation: NormalizedScoreObservation,
): Promise<SnapshotRow | undefined> {
  return database
    .selectFrom("score_snapshots")
    .select([
      "id",
      "score",
      "qso_total as qsoTotal",
      "points_total as pointsTotal",
      "mult_total as multTotal",
    ])
    .where("normalized_fingerprint", "=", normalizedFingerprint(observation))
    .executeTakeFirst();
}

async function currentForCallsign(
  database: Kysely<Database>,
  fixture: Fixture,
  callsign: string,
): Promise<CurrentRow | undefined> {
  return database
    .selectFrom("entries as entry")
    .innerJoin("current_scores as current", "current.entry_id", "entry.id")
    .innerJoin(
      "canonical_score_events as event",
      "event.id",
      "current.canonical_event_id",
    )
    .select([
      "current.canonical_event_id as canonicalEventId",
      "current.canonical_snapshot_id as canonicalSnapshotId",
      "event.score_snapshot_id as eventSnapshotId",
    ])
    .where("entry.contest_id", "=", fixture.contestId)
    .where("entry.normalized_callsign", "=", callsign)
    .executeTakeFirst();
}

async function snapshotCountForCallsign(
  database: Kysely<Database>,
  fixture: Fixture,
  callsign: string,
): Promise<number> {
  const result = await sql<CountRow>`
    SELECT COUNT(*) AS count
    FROM score_snapshots AS snapshot
    INNER JOIN entries AS entry ON entry.id = snapshot.entry_id
    WHERE entry.contest_id = ${fixture.contestId}
      AND entry.normalized_callsign = ${callsign}
  `.execute(database);
  return readCount(result.rows[0]?.count, "snapshot count");
}

async function canonicalEventCount(
  database: Kysely<Database>,
  snapshotId: DatabaseId,
): Promise<number> {
  const result = await sql<CountRow>`
    SELECT COUNT(*) AS count
    FROM canonical_score_events
    WHERE score_snapshot_id = ${snapshotId}
  `.execute(database);
  return readCount(result.rows[0]?.count, "canonical event count");
}

async function canonicalEventCountForCallsign(
  database: Kysely<Database>,
  fixture: Fixture,
  callsign: string,
): Promise<number> {
  const result = await sql<CountRow>`
    SELECT COUNT(*) AS count
    FROM canonical_score_events AS event
    INNER JOIN entries AS entry ON entry.id = event.entry_id
    WHERE entry.contest_id = ${fixture.contestId}
      AND entry.normalized_callsign = ${callsign}
  `.execute(database);
  return readCount(result.rows[0]?.count, "callsign canonical event count");
}

async function canonicalEventCountForFixture(
  database: Kysely<Database>,
  fixture: Fixture,
): Promise<number> {
  const result = await sql<CountRow>`
    SELECT COUNT(*) AS count
    FROM canonical_score_events AS event
    INNER JOIN score_snapshots AS snapshot
      ON snapshot.id = event.score_snapshot_id
    WHERE snapshot.source_id = ${fixture.sourceId}
  `.execute(database);
  return readCount(result.rows[0]?.count, "fixture canonical event count");
}

async function cleanupFixture(
  database: Kysely<Database>,
  fixture: Fixture,
): Promise<void> {
  const entries = await database
    .selectFrom("entries")
    .select("id")
    .where("contest_id", "=", fixture.contestId)
    .execute();
  const entryIds = entries.map((entry) => entry.id);
  const snapshots = entryIds.length
    ? await database
        .selectFrom("score_snapshots")
        .select("id")
        .where("entry_id", "in", entryIds)
        .execute()
    : [];
  const snapshotIds = snapshots.map((snapshot) => snapshot.id);

  if (entryIds.length)
    await database
      .deleteFrom("current_scores")
      .where("entry_id", "in", entryIds)
      .execute();
  if (snapshotIds.length)
    await database
      .deleteFrom("score_snapshot_flags")
      .where("snapshot_id", "in", snapshotIds)
      .execute();
  if (entryIds.length)
    await database
      .deleteFrom("canonical_score_events")
      .where("entry_id", "in", entryIds)
      .execute();
  if (snapshotIds.length)
    await database
      .deleteFrom("band_snapshots")
      .where("snapshot_id", "in", snapshotIds)
      .execute();
  if (snapshotIds.length)
    await database
      .deleteFrom("score_snapshots")
      .where("id", "in", snapshotIds)
      .execute();
  await database
    .deleteFrom("raw_messages")
    .where("source_id", "=", fixture.sourceId)
    .execute();
  await database
    .deleteFrom("entries")
    .where("contest_id", "=", fixture.contestId)
    .execute();
  await database
    .deleteFrom("contest_categories")
    .where("contest_id", "=", fixture.contestId)
    .execute();
  await database
    .deleteFrom("contests")
    .where("id", "=", fixture.contestId)
    .execute();
  await database
    .deleteFrom("sources")
    .where("id", "=", fixture.sourceId)
    .execute();
}

async function assertFixtureClean(
  database: Kysely<Database>,
  fixture: Fixture,
): Promise<number> {
  const [
    source,
    contest,
    categoryCount,
    entryCount,
    rawMessageCount,
    snapshotCount,
  ] = await Promise.all([
    sql<CountRow>`SELECT COUNT(*) AS count FROM sources WHERE code = ${fixture.namespace}`.execute(
      database,
    ),
    sql<CountRow>`SELECT COUNT(*) AS count FROM contests WHERE id = ${fixture.contestId}`.execute(
      database,
    ),
    sql<CountRow>`SELECT COUNT(*) AS count FROM contest_categories WHERE contest_id = ${fixture.contestId}`.execute(
      database,
    ),
    sql<CountRow>`SELECT COUNT(*) AS count FROM entries WHERE contest_id = ${fixture.contestId}`.execute(
      database,
    ),
    sql<CountRow>`SELECT COUNT(*) AS count FROM raw_messages WHERE source_id = ${fixture.sourceId}`.execute(
      database,
    ),
    sql<CountRow>`SELECT COUNT(*) AS count FROM score_snapshots WHERE source_id = ${fixture.sourceId}`.execute(
      database,
    ),
  ]);
  const counts: number[] = [
    readCount(source.rows[0]?.count, "fixture source count"),
    readCount(contest.rows[0]?.count, "fixture contest count"),
    readCount(categoryCount.rows[0]?.count, "fixture category count"),
    readCount(entryCount.rows[0]?.count, "fixture entry count"),
    readCount(rawMessageCount.rows[0]?.count, "fixture raw message count"),
    readCount(snapshotCount.rows[0]?.count, "fixture snapshot count"),
  ];
  assert(
    counts.every((count) => count === 0),
    "Fixture cleanup was incomplete.",
  );
  return counts.reduce<number>((sum, count) => sum + count, 0);
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
      : "Unknown collector ingestion integration validation error.",
  );
  process.exitCode = 1;
}
