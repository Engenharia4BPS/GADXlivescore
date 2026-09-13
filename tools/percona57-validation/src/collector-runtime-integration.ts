import nodeAssert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import {
  CollectorIngestionService,
  CollectorPollingService,
  CollectorRunRecoveryService,
  CollectorRuntimeService,
  ContestRunPollingRunner,
  collectorMappingLockName,
  KyselyCollectorRunRecoveryRepository,
  KyselyIngestionRepository,
  KyselyPollingMappingRepository,
  MySqlAdvisoryLockSessionProvider,
  type PollingCycleRunner,
  type RuntimeSleeper,
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
const RECOVERY_NOW = "2026-09-13 12:00:00.000000";
const RUNTIME_NOW = "2026-09-13 12:01:00.000000";
const STALE_STARTED_AT = "2026-09-13 11:00:00.000000";
const ACTIVE_STALE_STARTED_AT = "2026-09-13 11:50:00.000000";

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

interface DatabaseNameRow extends RowDataPacket {
  databaseName: string | null;
}

interface LockRow extends RowDataPacket {
  value: unknown;
}

interface RecoveryRunRow extends RowDataPacket {
  errorCode: string | null;
  finishedAt: string | null;
  outcome: string;
}

interface MappingRow extends RowDataPacket {
  lastFailureAt: string | null;
  nextPollAt: string | null;
}

async function main(): Promise<void> {
  const databaseUrl = requirePercona57TestDatabaseUrl();
  const database = createDatabase({ databaseUrl, connectionLimit: 2 });
  let fixture: Fixture | undefined;
  let activeLockConnection: Connection | undefined;
  let activeLockHeld = false;
  let cleaned = false;
  let passOutput: string | undefined;

  try {
    await assertKyselyTestDatabase(database);
    fixture = await seedFixture(database);
    const locks = new MySqlAdvisoryLockSessionProvider({
      databaseUrl,
      connectionLimit: 1,
    });
    const recovery = new CollectorRunRecoveryService(
      new KyselyCollectorRunRecoveryRepository(database),
      locks,
      { now: () => RECOVERY_NOW },
    );
    const staleRunId = await insertRunningRun(
      database,
      fixture,
      STALE_STARTED_AT,
    );

    const recovered = await recovery.recover({
      environment: ENVIRONMENT,
      staleRunThresholdMs: 60_000,
      maxRecoveryRuns: 10,
    });
    const recoveredRun = await readRun(database, staleRunId);
    const recoveredMapping = await readMapping(database, fixture.mappingId);
    assert(
      recovered.recoveredCount === 1 &&
        recoveredRun.outcome === "FAILED" &&
        recoveredRun.errorCode === "ABANDONED_RUN_RECOVERED" &&
        recoveredRun.finishedAt !== null,
      "Stale RUNNING collector run was not recovered as FAILED.",
    );
    assert(
      recoveredMapping.lastFailureAt === RECOVERY_NOW &&
        recoveredMapping.nextPollAt === RUNTIME_NOW,
      "Recovered mapping did not advance failure scheduling.",
    );
    const lockReleaseVerified = await verifyReleasedLock(
      databaseUrl,
      collectorMappingLockName(ENVIRONMENT, fixture.mappingId),
    );

    const activeRunId = await insertRunningRun(
      database,
      fixture,
      ACTIVE_STALE_STARTED_AT,
    );
    activeLockConnection = await createPhysicalDatabaseConnection({
      databaseUrl,
      connectionLimit: 1,
    });
    await assertPhysicalTestDatabase(activeLockConnection);
    const lockName = collectorMappingLockName(ENVIRONMENT, fixture.mappingId);
    assert(
      (await getLock(activeLockConnection, lockName)) === 1,
      "Active-lock fixture could not acquire its mapping lock.",
    );
    activeLockHeld = true;
    const mappingBeforeActiveRecovery = await readMapping(
      database,
      fixture.mappingId,
    );
    const activeRecovery = await recovery.recover({
      environment: ENVIRONMENT,
      staleRunThresholdMs: 60_000,
      maxRecoveryRuns: 10,
    });
    const activeRun = await readRun(database, activeRunId);
    const mappingAfterActiveRecovery = await readMapping(
      database,
      fixture.mappingId,
    );
    assert(
      activeRecovery.activeLockSkippedCount === 1 &&
        activeRun.outcome === "RUNNING" &&
        activeRun.finishedAt === null,
      "Active lock must prevent stale run recovery.",
    );
    nodeAssert.deepEqual(
      mappingAfterActiveRecovery,
      mappingBeforeActiveRecovery,
      "Active lock recovery attempt changed mapping scheduling.",
    );
    assert(
      (await releaseLock(activeLockConnection, lockName)) === 1,
      "Active-lock fixture could not release its mapping lock.",
    );
    activeLockHeld = false;

    const http = new CountingContestRunClient(new ContestRunHttpClient());
    const polling = new CollectorPollingService(
      new KyselyPollingMappingRepository(database),
      locks,
      new ContestRunPollingRunner(
        new CollectorIngestionService(new KyselyIngestionRepository(database)),
        http,
      ),
      { now: () => RUNTIME_NOW },
    );
    const order: string[] = [];
    const trackingRecovery = {
      async recover(input: {
        environment: string;
        maxRecoveryRuns?: number;
        staleRunThresholdMs: number;
      }) {
        order.push("recovery");
        return recovery.recover(input);
      },
    };
    let activeCycles = 0;
    let maxConcurrentCycles = 0;
    const trackingPolling: PollingCycleRunner = {
      async runCycle(input) {
        order.push("polling");
        activeCycles += 1;
        maxConcurrentCycles = Math.max(maxConcurrentCycles, activeCycles);
        try {
          return await polling.runCycle(input);
        } finally {
          activeCycles -= 1;
        }
      },
    };
    const shutdown = new AbortController();
    const runtime = new CollectorRuntimeService(
      trackingPolling,
      trackingRecovery,
      { now: () => RUNTIME_NOW },
      new StopAfterOneSleep(shutdown),
    );
    const runtimeResult = await runtime.run({
      environment: ENVIRONMENT,
      signal: shutdown.signal,
      cycleIntervalMs: 100,
      maxMappingsPerCycle: 1,
      maxRecoveryRuns: 10,
      // The active-lock scenario remains a deliberately old audit row, but it
      // is below this finite runtime's recovery threshold.
      staleRunThresholdMs: 30 * 24 * 3_600_000,
      runtimeFailureBackoffMs: 100,
      maximumRuntimeFailureBackoffMs: 100,
    });
    assert(
      order[0] === "recovery" && order[1] === "polling",
      "Runtime did not recover before its first polling cycle.",
    );
    assert(
      runtimeResult.cyclesStarted === 1 &&
        runtimeResult.cyclesCompleted === 1 &&
        runtimeResult.stoppedBySignal &&
        http.calls === 1 &&
        maxConcurrentCycles === 1,
      "Finite runtime did not execute exactly one controlled polling cycle.",
    );

    const canonicalEventCount = await canonicalCount(
      database,
      fixture.sourceId,
    );
    const currentScoreCount = await currentCount(database, fixture.contestId);
    assert(
      canonicalEventCount === 0 && currentScoreCount === 0,
      "UNZONED contest.run observations must remain non-canonical.",
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
        recovery: {
          staleCandidates: recovered.candidates,
          recoveredCount: recovered.recoveredCount,
          activeLockSkippedCount: activeRecovery.activeLockSkippedCount,
          recoveredRunOutcome: recoveredRun.outcome,
          recoveredRunErrorCode: recoveredRun.errorCode,
          mappingFailureAdvanced:
            recoveredMapping.lastFailureAt === RECOVERY_NOW &&
            recoveredMapping.nextPollAt === RUNTIME_NOW,
          activeRunUnchanged:
            activeRun.outcome === "RUNNING" && activeRun.finishedAt === null,
          lockReleaseVerified,
        },
        runtime: {
          recoveryBeforePolling:
            order[0] === "recovery" && order[1] === "polling",
          cyclesStarted: runtimeResult.cyclesStarted,
          cyclesCompleted: runtimeResult.cyclesCompleted,
          maxConcurrentCycles,
          httpRequests: http.calls,
          shutdownRequested: runtimeResult.stoppedBySignal,
          stoppedCleanly: runtimeResult.stoppedBySignal,
        },
        persistence: { canonicalEventCount, currentScoreCount },
        cleanupRemainingFixtureRows,
      },
      null,
      2,
    );
  } finally {
    if (activeLockConnection && activeLockHeld && fixture) {
      await releaseLock(
        activeLockConnection,
        collectorMappingLockName(ENVIRONMENT, fixture.mappingId),
      );
    }
    if (activeLockConnection) await activeLockConnection.end();
    if (fixture && !cleaned) await cleanupFixture(database, fixture);
    await database.destroy();
  }

  if (passOutput === undefined) {
    throw new Error(
      "Collector runtime validation did not complete successfully.",
    );
  }
  await writeStdout(passOutput);
}

async function seedFixture(database: Kysely<Database>): Promise<Fixture> {
  const namespace = `PHASE2E6_TEST_${randomUUID().replaceAll("-", "").toUpperCase()}`;
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
        created_at: RECOVERY_NOW,
        updated_at: RECOVERY_NOW,
      })
      .executeTakeFirstOrThrow();
    assert(source.insertId !== undefined, "Fixture source returned no ID.");
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
        slug: `phase2e6-${namespace.slice(-24).toLowerCase()}`,
        status: "TEST",
        start_at: null,
        end_at: null,
        time_zone: null,
        metadata: serializeJson(evidence),
        created_at: RECOVERY_NOW,
        updated_at: RECOVERY_NOW,
      })
      .executeTakeFirstOrThrow();
    assert(contest.insertId !== undefined, "Fixture contest returned no ID.");
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
        created_at: RECOVERY_NOW,
        updated_at: RECOVERY_NOW,
      })
      .executeTakeFirstOrThrow();
    assert(
      external.insertId !== undefined,
      "Fixture external ID returned no ID.",
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
        created_at: RECOVERY_NOW,
        updated_at: RECOVERY_NOW,
      })
      .executeTakeFirstOrThrow();
    assert(mapping.insertId !== undefined, "Fixture mapping returned no ID.");
    return {
      sourceId,
      contestId,
      contestExternalId,
      mappingId: String(mapping.insertId),
      namespace,
    };
  });
}

async function insertRunningRun(
  database: Kysely<Database>,
  fixture: Fixture,
  startedAt: string,
): Promise<DatabaseId> {
  const result = await database
    .insertInto("collector_runs")
    .values({
      collector_source_contest_id: fixture.mappingId,
      source_id: fixture.sourceId,
      environment: ENVIRONMENT,
      advisory_lock_name: collectorMappingLockName(
        ENVIRONMENT,
        fixture.mappingId,
      ),
      run_kind: "POLL",
      outcome: "RUNNING",
      started_at: startedAt,
      finished_at: null,
      request_count: 0,
      received_message_count: 0,
      error_code: null,
      error_details: null,
      metadata: null,
      created_at: startedAt,
    })
    .executeTakeFirstOrThrow();
  assert(result.insertId !== undefined, "Fixture run returned no ID.");
  return String(result.insertId);
}

async function readRun(
  database: Kysely<Database>,
  runId: DatabaseId,
): Promise<RecoveryRunRow> {
  const row = await database
    .selectFrom("collector_runs")
    .select(["outcome", "error_code as errorCode", "finished_at as finishedAt"])
    .where("id", "=", runId)
    .executeTakeFirst();
  assert(row, "Fixture collector run disappeared.");
  return row as RecoveryRunRow;
}

async function readMapping(
  database: Kysely<Database>,
  mappingId: DatabaseId,
): Promise<MappingRow> {
  const row = await database
    .selectFrom("collector_source_contests")
    .select(["last_failure_at as lastFailureAt", "next_poll_at as nextPollAt"])
    .where("id", "=", mappingId)
    .executeTakeFirst();
  assert(row, "Fixture mapping disappeared.");
  return row as MappingRow;
}

async function verifyReleasedLock(
  databaseUrl: string,
  lockName: string,
): Promise<boolean> {
  const connection = await createPhysicalDatabaseConnection({
    databaseUrl,
    connectionLimit: 1,
  });
  try {
    await assertPhysicalTestDatabase(connection);
    if ((await getLock(connection, lockName)) !== 1) return false;
    return (await releaseLock(connection, lockName)) === 1;
  } finally {
    await connection.end();
  }
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
  const values = await Promise.all([
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
    values.every((value) => value === 0),
    "Fixture cleanup was incomplete.",
  );
  return values.reduce((total, value) => total + value, 0);
}

async function canonicalCount(
  database: Kysely<Database>,
  sourceId: DatabaseId,
): Promise<number> {
  return count(
    database,
    sql<CountRow>`SELECT COUNT(*) AS count FROM canonical_score_events AS event INNER JOIN score_snapshots AS snapshot ON snapshot.id = event.score_snapshot_id WHERE snapshot.source_id = ${sourceId}`,
  );
}

async function currentCount(
  database: Kysely<Database>,
  contestId: DatabaseId,
): Promise<number> {
  return count(
    database,
    sql<CountRow>`SELECT COUNT(*) AS count FROM current_scores AS current INNER JOIN entries AS entry ON entry.id = current.entry_id WHERE entry.contest_id = ${contestId}`,
  );
}

async function count(
  database: Kysely<Database>,
  query: ReturnType<typeof sql<CountRow>>,
): Promise<number> {
  const value = (await query.execute(database)).rows[0]?.count;
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

class StopAfterOneSleep implements RuntimeSleeper {
  constructor(private readonly shutdown: AbortController) {}
  async sleep(_milliseconds: number): Promise<void> {
    this.shutdown.abort();
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
      : "Unknown collector runtime integration validation error.",
  );
  process.exitCode = 1;
}
