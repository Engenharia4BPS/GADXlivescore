import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import {
  type ContestRunCatalogDiscovery,
  ContestRunCatalogSyncService,
  contestRunDiscoveryLockName,
  KyselyContestRunCatalogRepository,
  MySqlAdvisoryLockSessionProvider,
} from "@araucaria/collector-ingestion";
import {
  createDatabase,
  createPhysicalDatabaseConnection,
  type Database,
  type DatabaseId,
} from "@araucaria/database";
import {
  type ContestRunDiscoveryResult,
  ContestRunDiscoveryService,
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

const ENVIRONMENT = "test";
const PREFERRED_TEST_IDS = [91, 108] as const;

interface Fixture {
  namespace: string;
  sourceCode: string;
  sourceId: DatabaseId;
}

interface CountRow extends RowDataPacket {
  count: number | string;
}

interface MappingRow {
  configuration: unknown | null;
  enabled: number;
  pollIntervalSeconds: number | null;
}

interface DatabaseNameRow extends RowDataPacket {
  databaseName: string | null;
}

interface LockRow extends RowDataPacket {
  value: unknown;
}

async function main(): Promise<void> {
  const databaseUrl = requirePercona57TestDatabaseUrl();
  const database = createDatabase({ databaseUrl, connectionLimit: 3 });
  let fixture: Fixture | undefined;
  let lockConnection: Connection | undefined;
  let lockHeld = false;
  let cleaned = false;
  let passOutput: string | undefined;

  try {
    await assertKyselyTestDatabase(database);
    fixture = await seedFixtureSource(database);
    const liveDiscovery = new CachedControlledDiscovery(
      new ContestRunDiscoveryService(new ContestRunHttpClient()),
    );
    const locks = new MySqlAdvisoryLockSessionProvider({
      databaseUrl,
      connectionLimit: 1,
    });
    const sync = new ContestRunCatalogSyncService(
      new KyselyContestRunCatalogRepository(database),
      locks,
      liveDiscovery,
    );
    const first = await sync.sync({
      environment: ENVIRONMENT,
      sourceCode: fixture.sourceCode,
      month: new Date().getUTCMonth() + 1,
      maxContests: 2,
      maxCategoryRequests: 2,
    });
    assert.equal(first.outcome, "SUCCESS");
    assert(
      first.contestsCreated > 0,
      "First sync did not create fixture contests.",
    );
    assert.equal(first.mappingsCreated, first.contestsCreated);
    const fixtureRows = await fixtureCatalogRows(database, fixture.sourceId);
    assert(
      fixtureRows.every(
        (row) =>
          row.enabled === 0 &&
          row.startAt === null &&
          row.endAt === null &&
          row.timeZone === null,
      ),
      "Catalog sync inferred lifecycle timestamps or enabled a mapping.",
    );
    const changed = fixtureRows[0];
    assert(changed, "First sync produced no fixture mapping.");
    const operatorConfiguration = '{"operator":"PHASE2E7"}';
    await database
      .updateTable("collector_source_contests")
      .set({
        enabled: 1,
        poll_interval_seconds: 123,
        configuration: operatorConfiguration,
      })
      .where("id", "=", changed.mappingId)
      .executeTakeFirstOrThrow();
    const beforeSecond = await readMapping(database, changed.mappingId);
    const second = await sync.sync({
      environment: ENVIRONMENT,
      sourceCode: fixture.sourceCode,
      maxContests: 2,
      maxCategoryRequests: 2,
    });
    assert.equal(second.outcome, "SUCCESS");
    assert.equal(second.contestsCreated, 0);
    assert.equal(second.externalIdsCreated, 0);
    assert.equal(second.mappingsCreated, 0);
    assert.deepEqual(
      await readMapping(database, changed.mappingId),
      beforeSecond,
    );

    lockConnection = await createPhysicalDatabaseConnection({
      databaseUrl,
      connectionLimit: 1,
    });
    await assertPhysicalTestDatabase(lockConnection);
    const lockName = contestRunDiscoveryLockName(ENVIRONMENT, fixture.sourceId);
    assert.equal(await getLock(lockConnection, lockName), 1);
    lockHeld = true;
    const cachedCallsBeforeContention = liveDiscovery.calls;
    const contention = await sync.sync({
      environment: ENVIRONMENT,
      sourceCode: fixture.sourceCode,
      maxContests: 2,
      maxCategoryRequests: 2,
    });
    assert.equal(contention.outcome, "LOCKED_BY_OTHER");
    assert.equal(liveDiscovery.calls, cachedCallsBeforeContention);
    assert.equal(await releaseLock(lockConnection, lockName), 1);
    lockHeld = false;
    const lockReleaseVerified = await verifyReleasedLock(databaseUrl, lockName);

    const scoreSideEffects = await scoreCounts(database, fixture.sourceId);
    assert.deepEqual(scoreSideEffects, {
      snapshotsCreated: 0,
      canonicalEventsCreated: 0,
      currentScoresCreated: 0,
    });
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
        source: fixture.sourceCode,
        discovery: {
          nearestRequests: liveDiscovery.endpointCount("nearest"),
          monthRequests: liveDiscovery.endpointCount("month"),
          categoryRequests: liveDiscovery.endpointCount("categories"),
          uniqueDiscoveredTestIds: liveDiscovery.testIds.length,
        },
        firstSync: {
          contestsCreated: first.contestsCreated,
          contestsReused: first.contestsReused,
          externalIdsCreated: first.externalIdsCreated,
          mappingsCreated: first.mappingsCreated,
          mappingsEnabledAutomatically: 0,
        },
        secondSync: {
          duplicateContestsCreated: second.contestsCreated,
          duplicateExternalIdsCreated: second.externalIdsCreated,
          duplicateMappingsCreated: second.mappingsCreated,
          operatorConfigurationPreserved: true,
        },
        semantics: {
          inferredStartTimes: 0,
          inferredTimeZones: 0,
          autoActivatedMappings: 0,
        },
        scoreSideEffects: {
          displayscoreRequests: 0,
          ...scoreSideEffects,
        },
        contention: { result: contention.outcome, mutations: 0 },
        lockReleaseVerified,
        cleanupRemainingFixtureRows,
      },
      null,
      2,
    );
  } finally {
    if (lockConnection && lockHeld && fixture) {
      await releaseLock(
        lockConnection,
        contestRunDiscoveryLockName(ENVIRONMENT, fixture.sourceId),
      );
    }
    if (lockConnection) await lockConnection.end();
    if (fixture && !cleaned) await cleanupFixture(database, fixture);
    await database.destroy();
  }
  if (!passOutput) throw new Error("Catalog integration did not complete.");
  await writeStdout(passOutput);
}

class CachedControlledDiscovery implements ContestRunCatalogDiscovery {
  calls = 0;
  testIds: readonly number[] = [];
  private cached: ContestRunDiscoveryResult | undefined;

  constructor(private readonly source: ContestRunDiscoveryService) {}

  async discover(input: {
    continueOnCategoryError: true;
    maxCategoryRequests?: number;
    month?: number;
  }): Promise<ContestRunDiscoveryResult> {
    this.calls += 1;
    if (this.cached) return { ...this.cached, requestCount: 0, requests: [] };
    const result = await this.source.discover(input);
    const ordered = [...result.contests].sort(
      (left, right) => preference(left.testId) - preference(right.testId),
    );
    const selected = ordered.slice(0, 2);
    assert(selected.length > 0, "Live discovery returned no usable contests.");
    this.testIds = selected.map((contest) => contest.testId);
    this.cached = { ...result, contests: selected };
    return this.cached;
  }

  endpointCount(endpoint: string): number {
    return (
      this.cached?.requests.filter((request) => request.endpoint === endpoint)
        .length ?? 0
    );
  }
}

function preference(testId: number): number {
  const preferred = PREFERRED_TEST_IDS.indexOf(testId as 91 | 108);
  return preferred === -1 ? PREFERRED_TEST_IDS.length + testId : preferred;
}

async function seedFixtureSource(database: Kysely<Database>): Promise<Fixture> {
  const namespace = `PHASE2E7_TEST_${randomUUID().replaceAll("-", "").toUpperCase()}`;
  const inserted = await database
    .insertInto("sources")
    .values({
      code: namespace,
      kind: "EXTERNAL_SERVER",
      precedence_rank: 1,
      display_name: namespace,
      base_url: "https://contest.run",
      default_config: null,
      enabled: 0,
      created_at: utcNow(),
      updated_at: utcNow(),
    })
    .executeTakeFirstOrThrow();
  assert(inserted.insertId !== undefined, "Fixture source returned no ID.");
  return {
    namespace,
    sourceCode: namespace,
    sourceId: String(inserted.insertId),
  };
}

async function fixtureCatalogRows(
  database: Kysely<Database>,
  sourceId: DatabaseId,
): Promise<
  Array<{
    endAt: string | null;
    enabled: number;
    mappingId: DatabaseId;
    startAt: string | null;
    timeZone: string | null;
  }>
> {
  return database
    .selectFrom("collector_source_contests as mapping")
    .innerJoin("contests as contest", "contest.id", "mapping.contest_id")
    .select([
      "mapping.id as mappingId",
      "mapping.enabled as enabled",
      "contest.start_at as startAt",
      "contest.end_at as endAt",
      "contest.time_zone as timeZone",
    ])
    .where("mapping.source_id", "=", sourceId)
    .orderBy("mapping.id")
    .execute();
}

async function readMapping(
  database: Kysely<Database>,
  mappingId: DatabaseId,
): Promise<MappingRow> {
  const result = await database
    .selectFrom("collector_source_contests")
    .select([
      "enabled",
      "poll_interval_seconds as pollIntervalSeconds",
      "configuration",
    ])
    .where("id", "=", mappingId)
    .executeTakeFirst();
  assert(result, "Fixture mapping disappeared.");
  return result;
}

async function scoreCounts(
  database: Kysely<Database>,
  sourceId: DatabaseId,
): Promise<{
  canonicalEventsCreated: number;
  currentScoresCreated: number;
  snapshotsCreated: number;
}> {
  const [snapshotsCreated, canonicalEventsCreated, currentScoresCreated] =
    await Promise.all([
      count(
        database,
        sql<CountRow>`SELECT COUNT(*) AS count FROM score_snapshots WHERE source_id = ${sourceId}`,
      ),
      count(
        database,
        sql<CountRow>`SELECT COUNT(*) AS count FROM canonical_score_events AS event INNER JOIN score_snapshots AS snapshot ON snapshot.id = event.score_snapshot_id WHERE snapshot.source_id = ${sourceId}`,
      ),
      count(
        database,
        sql<CountRow>`SELECT COUNT(*) AS count FROM current_scores AS current INNER JOIN entries AS entry ON entry.id = current.entry_id INNER JOIN collector_source_contests AS mapping ON mapping.contest_id = entry.contest_id WHERE mapping.source_id = ${sourceId}`,
      ),
    ]);
  return { snapshotsCreated, canonicalEventsCreated, currentScoresCreated };
}

async function cleanupFixture(
  database: Kysely<Database>,
  fixture: Fixture,
): Promise<void> {
  await assertKyselyTestDatabase(database);
  await database.transaction().execute(async (trx) => {
    const external = await trx
      .selectFrom("contest_external_ids")
      .select(["id", "contest_id as contestId"])
      .where("source_id", "=", fixture.sourceId)
      .execute();
    const contestIds = external.map((row) => row.contestId);
    await trx
      .deleteFrom("collector_runs")
      .where("source_id", "=", fixture.sourceId)
      .execute();
    await trx
      .deleteFrom("collector_source_contests")
      .where("source_id", "=", fixture.sourceId)
      .execute();
    await trx
      .deleteFrom("contest_external_ids")
      .where("source_id", "=", fixture.sourceId)
      .execute();
    if (contestIds.length)
      await trx.deleteFrom("contests").where("id", "in", contestIds).execute();
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
      sql<CountRow>`SELECT COUNT(*) AS count FROM contest_external_ids WHERE source_id = ${fixture.sourceId}`,
    ),
    count(
      database,
      sql<CountRow>`SELECT COUNT(*) AS count FROM collector_source_contests WHERE source_id = ${fixture.sourceId}`,
    ),
    count(
      database,
      sql<CountRow>`SELECT COUNT(*) AS count FROM collector_runs WHERE source_id = ${fixture.sourceId}`,
    ),
  ]);
  assert(
    counts.every((value) => value === 0),
    "Fixture cleanup was incomplete.",
  );
  return counts.reduce((total, value) => total + value, 0);
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
    return (
      (await getLock(connection, lockName)) === 1 &&
      (await releaseLock(connection, lockName)) === 1
    );
  } finally {
    await connection.end();
  }
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
): Promise<number> {
  const [rows] = await connection.query<LockRow[]>(
    "SELECT GET_LOCK(?, 0) AS value",
    [lockName],
  );
  return scalar(rows[0]?.value, "GET_LOCK");
}

async function releaseLock(
  connection: Connection,
  lockName: string,
): Promise<number> {
  const [rows] = await connection.query<LockRow[]>(
    "SELECT RELEASE_LOCK(?) AS value",
    [lockName],
  );
  return scalar(rows[0]?.value, "RELEASE_LOCK");
}

function scalar(value: unknown, operation: string): number {
  if (value === 1 || value === "1") return 1;
  if (value === 0 || value === "0") return 0;
  throw new Error(`${operation} returned an invalid lock scalar.`);
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

function utcNow(): string {
  return new Date().toISOString().replace("T", " ").replace("Z", "");
}

async function writeStdout(text: string): Promise<void> {
  await new Promise<void>((resolve, reject) => {
    process.stdout.write(`${text}\n`, (error) =>
      error ? reject(error) : resolve(),
    );
  });
}

try {
  await main();
} catch (error) {
  process.stderr.write(
    `${error instanceof Error ? error.message : "Catalog integration failed."}\n`,
  );
  process.exitCode = 1;
}
