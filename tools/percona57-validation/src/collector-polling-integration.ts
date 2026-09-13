import nodeAssert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import {
  CollectorIngestionService,
  CollectorPollingService,
  ContestRunPollingRunner,
  collectorMappingLockName,
  KyselyIngestionRepository,
  KyselyPollingMappingRepository,
  MySqlAdvisoryLockSessionProvider,
  type PollingClock,
} from "@araucaria/collector-ingestion";
import {
  createDatabase,
  createPhysicalDatabaseConnection,
  type Database,
  type DatabaseId,
  serializeJson,
} from "@araucaria/database";
import {
  type ContestRunDisplayScoreHttpResponse,
  ContestRunHttpClient,
} from "@araucaria/source-adapters";
import { type Kysely, sql } from "kysely";
import type { Connection, RowDataPacket } from "mysql2/promise";

import {
  assertKyselyTestDatabase,
  assertPercona57TestDatabaseName,
  PERCONA57_TEST_DATABASE,
  requirePercona57TestDatabaseUrl,
} from "./safety.js";

const TEST_ID = 91;
const ENVIRONMENT = "test";
const FIRST_NOW = "2026-09-13 12:00:00.000000";
const CONTENTION_NOW = "2026-09-13 12:02:00.000000";

interface Fixture {
  contestExternalId: DatabaseId;
  contestId: DatabaseId;
  mappingId: DatabaseId;
  namespace: string;
  sourceId: DatabaseId;
}

interface CountRow extends RowDataPacket {
  count: number | string;
}

interface MappingRow extends RowDataPacket {
  lastSuccessAt: string | null;
  nextPollAt: string | null;
}

interface RawMessageRow extends RowDataPacket {
  collectorRunId: DatabaseId | null;
  mappingId: DatabaseId | null;
}

interface LockRow extends RowDataPacket {
  value: unknown;
}

interface DatabaseNameRow extends RowDataPacket {
  databaseName: string | null;
}

interface FirstCycleEvidence {
  acceptedCount: number;
  duplicateCount: number;
  observationCount: number;
  rejectedCount: number;
  receivedMessageCount: number;
  rawMessageCountLinkedToRun: number;
  requestCount: number;
  runId: DatabaseId;
}

async function main(): Promise<void> {
  const databaseUrl = requirePercona57TestDatabaseUrl();
  const database = createDatabase({ databaseUrl, connectionLimit: 2 });
  const clock = new MutableClock(FIRST_NOW);
  let fixture: Fixture | undefined;
  let lockConnection: Connection | undefined;
  let heldLock = false;
  let cleaned = false;
  let passOutput: string | undefined;

  try {
    await assertKyselyTestDatabase(database);
    fixture = await seedFixture(database);
    const http = new CountingContestRunClient(new ContestRunHttpClient());
    const repository = new KyselyPollingMappingRepository(database);
    const ingestion = new CollectorIngestionService(
      new KyselyIngestionRepository(database),
    );
    const polling = new CollectorPollingService(
      repository,
      new MySqlAdvisoryLockSessionProvider({ databaseUrl, connectionLimit: 1 }),
      new ContestRunPollingRunner(ingestion, http),
      clock,
    );

    const firstCycle = await polling.runCycle({
      environment: ENVIRONMENT,
      maxMappingsPerCycle: 1,
    });
    const first = firstCycle.results[0];
    assert(
      first?.outcome === "SUCCESS",
      "First polling cycle did not succeed.",
    );
    assert(first.runId, "First polling cycle returned no collector run ID.");
    assert(
      http.calls === 1,
      "First polling cycle did not make one HTTP request.",
    );
    const firstEvidence = await assertFirstCycle(
      database,
      fixture,
      first.runId,
      first,
    );

    const immediateCycle = await polling.runCycle({
      environment: ENVIRONMENT,
      maxMappingsPerCycle: 1,
    });
    assert(
      immediateCycle.mappingsConsidered === 0 && http.calls === 1,
      "A mapping before next_poll_at must not create another request or run.",
    );

    lockConnection = await createPhysicalDatabaseConnection({
      databaseUrl,
      connectionLimit: 1,
    });
    await assertPhysicalTestDatabase(lockConnection);
    const lockName = collectorMappingLockName(ENVIRONMENT, fixture.mappingId);
    assert(
      (await getLock(lockConnection, lockName)) === 1,
      "Contention connection could not acquire the mapping lock.",
    );
    heldLock = true;
    const mappingBeforeContention = await readMapping(
      database,
      fixture.mappingId,
    );
    clock.value = CONTENTION_NOW;
    const contentionCycle = await polling.runCycle({
      environment: ENVIRONMENT,
      maxMappingsPerCycle: 1,
    });
    assert(
      contentionCycle.results[0]?.outcome === "LOCKED_BY_OTHER",
      "Contended mapping did not report LOCKED_BY_OTHER.",
    );
    assert(
      http.calls === 1 &&
        (await collectorRunCount(database, fixture.sourceId)) === 1,
      "Lock-contended worker performed HTTP work or created a collector run.",
    );
    nodeAssert.deepEqual(
      await readMapping(database, fixture.mappingId),
      mappingBeforeContention,
      "Lock contention changed mapping schedule state.",
    );
    assert(
      (await releaseLock(lockConnection, lockName)) === 1,
      "Contention connection did not release the mapping lock.",
    );
    heldLock = false;

    const persistedSnapshotCount = await snapshotCount(
      database,
      fixture.sourceId,
    );
    const fixtureCanonicalEventCount = await canonicalEventCount(
      database,
      fixture.sourceId,
    );
    const fixtureCurrentScoreCount = await currentScoreCount(
      database,
      fixture.contestId,
    );
    assert(
      persistedSnapshotCount > 0 &&
        fixtureCanonicalEventCount === 0 &&
        fixtureCurrentScoreCount === 0,
      "First cycle did not preserve snapshots or incorrectly canonicalized unzoned observations.",
    );
    await cleanupFixture(database, fixture);
    cleaned = true;
    const cleanupRemainingFixtureRows = await assertFixtureClean(
      database,
      fixture,
    );
    passOutput = JSON.stringify(
      {
        status: "PASS",
        database: PERCONA57_TEST_DATABASE,
        testId: TEST_ID,
        firstCycle: firstEvidence,
        firstCollectorRunId: first.runId,
        rawMessageCountLinkedToRun: firstEvidence.rawMessageCountLinkedToRun,
        persistedSnapshotCount,
        canonicalEventCount: fixtureCanonicalEventCount,
        currentScoreCount: fixtureCurrentScoreCount,
        nextPollAdvanced: true,
        immediateCycleHttpRequests: 0,
        contentionCycle: "LOCKED_BY_OTHER",
        contentionCycleHttpRequests: 0,
        contentionCycleCollectorRuns: 0,
        lockReleaseVerified: true,
        cleanupRemainingFixtureRows,
      },
      null,
      2,
    );
  } finally {
    if (lockConnection && heldLock && fixture) {
      await releaseLock(
        lockConnection,
        collectorMappingLockName(ENVIRONMENT, fixture.mappingId),
      );
    }
    if (lockConnection) await lockConnection.end();
    if (fixture && !cleaned) await cleanupFixture(database, fixture);
    await database.destroy();
  }

  if (passOutput === undefined) {
    throw new Error("Polling validation did not complete successfully.");
  }
  await writeStdout(passOutput);
}

async function seedFixture(database: Kysely<Database>): Promise<Fixture> {
  const namespace = `PHASE2E5_TEST_${randomUUID().replaceAll("-", "").toUpperCase()}`;
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
        created_at: FIRST_NOW,
        updated_at: FIRST_NOW,
      })
      .executeTakeFirstOrThrow();
    assert(
      source.insertId !== undefined,
      "Fixture source insert returned no ID.",
    );
    const sourceId = String(source.insertId);
    const evidence = {
      fixture_namespace: namespace,
      contest_run_testid: TEST_ID,
    };
    const contest = await trx
      .insertInto("contests")
      .values({
        name: namespace,
        normalized_name: namespace.toLowerCase(),
        slug: `phase2e5-${namespace.slice(-24).toLowerCase()}`,
        status: "TEST",
        start_at: null,
        end_at: null,
        time_zone: null,
        metadata: serializeJson(evidence),
        created_at: FIRST_NOW,
        updated_at: FIRST_NOW,
      })
      .executeTakeFirstOrThrow();
    assert(
      contest.insertId !== undefined,
      "Fixture contest insert returned no ID.",
    );
    const contestId = String(contest.insertId);
    const external = await trx
      .insertInto("contest_external_ids")
      .values({
        contest_id: contestId,
        source_id: sourceId,
        external_id: String(TEST_ID),
        external_name: null,
        external_calendar_code: null,
        start_day: null,
        start_time: null,
        finish_day: null,
        finish_time: null,
        metadata: serializeJson(evidence),
        last_observed_at: null,
        created_at: FIRST_NOW,
        updated_at: FIRST_NOW,
      })
      .executeTakeFirstOrThrow();
    assert(
      external.insertId !== undefined,
      "Fixture external ID insert returned no ID.",
    );
    const contestExternalId = String(external.insertId);
    const mapping = await trx
      .insertInto("collector_source_contests")
      .values({
        source_id: sourceId,
        contest_id: contestId,
        contest_external_id_id: contestExternalId,
        enabled: 1,
        poll_interval_seconds: 60,
        configuration: serializeJson(evidence),
        last_success_at: null,
        last_failure_at: null,
        next_poll_at: null,
        created_at: FIRST_NOW,
        updated_at: FIRST_NOW,
      })
      .executeTakeFirstOrThrow();
    assert(
      mapping.insertId !== undefined,
      "Fixture mapping insert returned no ID.",
    );
    return {
      sourceId,
      contestId,
      contestExternalId,
      mappingId: String(mapping.insertId),
      namespace,
    };
  });
}

async function assertFirstCycle(
  database: Kysely<Database>,
  fixture: Fixture,
  runId: DatabaseId,
  result: {
    acceptedCount?: number;
    duplicateCount?: number;
    observationCount?: number;
    receivedMessageCount: number;
    requestCount: number;
  },
): Promise<FirstCycleEvidence> {
  const rawMessages = await database
    .selectFrom("raw_messages")
    .select([
      "collector_run_id as collectorRunId",
      "collector_source_contest_id as mappingId",
      "observation_count as observationCount",
      "accepted_count as acceptedCount",
      "duplicate_count as duplicateCount",
      "rejected_count as rejectedCount",
    ])
    .where("source_id", "=", fixture.sourceId)
    .execute();
  assert(
    rawMessages.length === 1,
    "First polling cycle did not persist one raw receipt.",
  );
  const rawMessage = rawMessages[0] as RawMessageRow & {
    acceptedCount: number;
    duplicateCount: number;
    observationCount: number;
    rejectedCount: number;
  };
  assert(
    rawMessage.collectorRunId === runId &&
      rawMessage.mappingId === fixture.mappingId,
    "Raw receipt is not linked to the collector run and mapping.",
  );
  const storedMapping = await readMapping(database, fixture.mappingId);
  assert(
    storedMapping.lastSuccessAt !== null &&
      storedMapping.nextPollAt !== null &&
      storedMapping.nextPollAt > FIRST_NOW,
    "Successful polling cycle did not advance next_poll_at.",
  );
  assert(
    (await canonicalEventCount(database, fixture.sourceId)) === 0 &&
      (await currentScoreCount(database, fixture.contestId)) === 0,
    "UNZONED contest.run observations must not create canonical state.",
  );
  return {
    observationCount: rawMessage.observationCount,
    acceptedCount: rawMessage.acceptedCount,
    duplicateCount: rawMessage.duplicateCount,
    rejectedCount: rawMessage.rejectedCount,
    requestCount: result.requestCount,
    receivedMessageCount: result.receivedMessageCount,
    rawMessageCountLinkedToRun: rawMessages.length,
    runId,
  };
}

async function readMapping(
  database: Kysely<Database>,
  mappingId: DatabaseId,
): Promise<MappingRow> {
  const mapping = await database
    .selectFrom("collector_source_contests")
    .select(["last_success_at as lastSuccessAt", "next_poll_at as nextPollAt"])
    .where("id", "=", mappingId)
    .executeTakeFirst();
  assert(mapping, "Fixture mapping disappeared.");
  return mapping as MappingRow;
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
      .where("id", "=", fixture.mappingId)
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
    ),
    count(
      database,
      sql<CountRow>`SELECT COUNT(*) AS count FROM contests WHERE id = ${fixture.contestId}`,
    ),
    count(
      database,
      sql<CountRow>`SELECT COUNT(*) AS count FROM contest_external_ids WHERE id = ${fixture.contestExternalId}`,
    ),
    count(
      database,
      sql<CountRow>`SELECT COUNT(*) AS count FROM collector_source_contests WHERE id = ${fixture.mappingId}`,
    ),
    count(
      database,
      sql<CountRow>`SELECT COUNT(*) AS count FROM collector_runs WHERE source_id = ${fixture.sourceId}`,
    ),
    count(
      database,
      sql<CountRow>`SELECT COUNT(*) AS count FROM raw_messages WHERE source_id = ${fixture.sourceId}`,
    ),
    count(
      database,
      sql<CountRow>`SELECT COUNT(*) AS count FROM score_snapshots WHERE source_id = ${fixture.sourceId}`,
    ),
  ]);
  assert(
    counts.every((value) => value === 0),
    "Fixture cleanup was incomplete.",
  );
  return counts.reduce((total, value) => total + value, 0);
}

async function snapshotCount(
  database: Kysely<Database>,
  sourceId: DatabaseId,
): Promise<number> {
  return count(
    database,
    sql<CountRow>`SELECT COUNT(*) AS count FROM score_snapshots WHERE source_id = ${sourceId}`,
  );
}

async function canonicalEventCount(
  database: Kysely<Database>,
  sourceId: DatabaseId,
): Promise<number> {
  return count(
    database,
    sql<CountRow>`SELECT COUNT(*) AS count FROM canonical_score_events AS event INNER JOIN score_snapshots AS snapshot ON snapshot.id = event.score_snapshot_id WHERE snapshot.source_id = ${sourceId}`,
  );
}

async function currentScoreCount(
  database: Kysely<Database>,
  contestId: DatabaseId,
): Promise<number> {
  return count(
    database,
    sql<CountRow>`SELECT COUNT(*) AS count FROM current_scores AS current INNER JOIN entries AS entry ON entry.id = current.entry_id WHERE entry.contest_id = ${contestId}`,
  );
}

async function collectorRunCount(
  database: Kysely<Database>,
  sourceId: DatabaseId,
): Promise<number> {
  return count(
    database,
    sql<CountRow>`SELECT COUNT(*) AS count FROM collector_runs WHERE source_id = ${sourceId}`,
  );
}

async function count(
  database: Kysely<Database>,
  query: ReturnType<typeof sql<CountRow>>,
): Promise<number> {
  const result = await query.execute(database);
  const value = result.rows[0]?.count;
  if (typeof value === "number" && Number.isSafeInteger(value)) return value;
  if (typeof value === "string" && /^(0|[1-9]\d*)$/.test(value))
    return Number(value);
  throw new Error("COUNT(*) returned an invalid scalar.");
}

async function assertPhysicalTestDatabase(
  connection: Connection,
): Promise<void> {
  const [rows] = await connection.query<DatabaseNameRow[]>(
    "SELECT DATABASE() AS databaseName",
  );
  assertPercona57TestDatabaseName(rows[0]?.databaseName);
}

async function getLock(
  connection: Connection,
  lockName: string,
): Promise<0 | 1> {
  const [rows] = await connection.query<LockRow[]>(
    "SELECT GET_LOCK(?, 0) AS value",
    [lockName],
  );
  return lockScalar(rows[0]?.value);
}

async function releaseLock(
  connection: Connection,
  lockName: string,
): Promise<0 | 1> {
  const [rows] = await connection.query<LockRow[]>(
    "SELECT RELEASE_LOCK(?) AS value",
    [lockName],
  );
  return lockScalar(rows[0]?.value);
}

function lockScalar(value: unknown): 0 | 1 {
  if (value === 1 || value === "1") return 1;
  if (value === 0 || value === "0") return 0;
  throw new Error("Advisory lock returned an invalid scalar.");
}

class MutableClock implements PollingClock {
  constructor(public value: string) {}
  now(): string {
    return this.value;
  }
}

class CountingContestRunClient {
  calls = 0;
  constructor(private readonly client: ContestRunHttpClient) {}
  async displayScore(
    testId: number,
  ): Promise<ContestRunDisplayScoreHttpResponse> {
    this.calls += 1;
    return this.client.displayScore(testId);
  }
}

async function writeStdout(text: string): Promise<void> {
  await new Promise<void>((resolve, reject) => {
    process.stdout.write(`${text}\n`, (error) => {
      if (error) reject(error);
      else resolve();
    });
  });
}

function assert(condition: unknown, message: string): asserts condition {
  if (!condition) throw new Error(message);
}

try {
  await main();
} catch (error) {
  console.error(
    error instanceof Error
      ? error.message
      : "Unknown collector polling integration validation error.",
  );
  process.exitCode = 1;
}
