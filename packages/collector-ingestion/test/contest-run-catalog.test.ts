import assert from "node:assert/strict";
import test from "node:test";
import type {
  ContestRunDiscoveredContest,
  ContestRunDiscoveryResult,
} from "@araucaria/source-adapters";
import {
  type AdvisoryLockSession,
  type AdvisoryLockSessionProvider,
  type CatalogPersistenceInput,
  type CatalogPersistenceResult,
  type ContestRunCatalogDiscovery,
  type ContestRunCatalogRepository,
  type ContestRunCatalogSource,
  ContestRunCatalogSyncService,
  contestRunDiscoveryLockName,
  type DiscoveryRunFinish,
  type DiscoveryRunStart,
} from "../src/index.js";

const now = "2026-09-13 12:00:00.000000";

test("catalog sync provisions idempotent disabled mappings without activity inference", async () => {
  const repository = new MemoryCatalogRepository();
  const discovery = new FixedDiscovery([contest(91), contest(108)]);
  const locks = new SharedLocks();
  const service = catalogService(repository, locks, discovery);

  const first = await service.sync({ environment: "test", maxContests: 2 });
  assert.equal(first.outcome, "SUCCESS");
  assert.equal(first.contestsCreated, 2);
  assert.equal(first.externalIdsCreated, 2);
  assert.equal(first.mappingsCreated, 2);
  assert.equal(first.mappingsReused, 0);
  assert.equal(first.requestCount, 4);
  assert.equal(first.receivedMessageCount, 0);
  for (const stored of repository.contests.values()) {
    assert.equal(stored.status, "DISCOVERED");
    assert.equal(stored.startAt, null);
    assert.equal(stored.endAt, null);
    assert.equal(stored.timeZone, null);
  }
  for (const mapping of repository.mappings.values()) {
    assert.equal(mapping.enabled, 0);
    assert.equal(mapping.pollIntervalSeconds, null);
    assert.equal(mapping.nextPollAt, null);
  }

  const mapping91 = repository.mappings.get("1:contest-91");
  assert(mapping91);
  mapping91.enabled = 1;
  mapping91.pollIntervalSeconds = 90;
  mapping91.configuration = '{"operator":"preserved"}';
  const second = await service.sync({ environment: "test", maxContests: 2 });

  assert.equal(second.outcome, "SUCCESS");
  assert.equal(second.contestsCreated, 0);
  assert.equal(second.contestsReused, 2);
  assert.equal(second.externalIdsCreated, 0);
  assert.equal(second.mappingsCreated, 0);
  assert.equal(second.mappingsReused, 2);
  assert.deepEqual(mapping91, {
    enabled: 1,
    pollIntervalSeconds: 90,
    nextPollAt: null,
    configuration: '{"operator":"preserved"}',
  });
  assert.equal(repository.runs.length, 2);
  assert.equal(repository.runs[0]?.finished?.requestCount, 4);
  assert.equal(repository.runs[0]?.finished?.errorCode, null);
  assert.equal(locks.held.size, 0);
});

test("changed evidence is delivered against the same external identity and missing contests are retained", async () => {
  const repository = new MemoryCatalogRepository();
  const discovery = new FixedDiscovery([
    contest(91, "First name"),
    contest(108),
  ]);
  const service = catalogService(repository, new SharedLocks(), discovery);
  await service.sync({ environment: "test", maxContests: 2 });
  const originalContestId = repository.externalIds.get("1:91")?.contestId;
  discovery.set([contest(91, "Changed source name")]);

  const result = await service.sync({ environment: "test", maxContests: 1 });
  assert.equal(result.contestsCreated, 0);
  assert.equal(
    repository.externalIds.get("1:91")?.contestId,
    originalContestId,
  );
  assert.equal(
    repository.externalIds.get("1:91")?.externalName,
    "Changed source name",
  );
  assert(repository.externalIds.has("1:108"));
  assert(repository.mappings.has("1:contest-108"));
});

test("partial category errors preserve discovered contests and are reported separately", async () => {
  const repository = new MemoryCatalogRepository();
  const discovery = new FixedDiscovery(
    [contest(91)],
    [{ testId: 91, code: "CATEGORY_TIMEOUT" }],
  );
  const result = await catalogService(
    repository,
    new SharedLocks(),
    discovery,
  ).sync({
    environment: "test",
  });

  assert.equal(result.outcome, "SUCCESS");
  assert.deepEqual(result.categoryErrors, [
    { testId: 91, code: "CATEGORY_TIMEOUT" },
  ]);
  assert(repository.externalIds.has("1:91"));
});

test("source-global lock contention performs no discovery, creates no run, and mutates nothing", async () => {
  const repository = new MemoryCatalogRepository();
  const locks = new SharedLocks();
  locks.held.add("als:test:source:1:discovery");
  const discovery = new FixedDiscovery([contest(91)]);
  const result = await catalogService(repository, locks, discovery).sync({
    environment: "test",
  });

  assert.equal(result.outcome, "LOCKED_BY_OTHER");
  assert.equal(result.requestCount, 0);
  assert.equal(discovery.calls, 0);
  assert.equal(repository.runs.length, 0);
  assert.equal(repository.externalIds.size, 0);
});

test("missing configured contest.run source fails before lock or HTTP", async () => {
  const repository = new MemoryCatalogRepository(null);
  const locks = new SharedLocks();
  const discovery = new FixedDiscovery([contest(91)]);
  const result = await catalogService(repository, locks, discovery).sync({
    environment: "test",
  });

  assert.equal(result.outcome, "INVALID_SOURCE_CONFIGURATION");
  assert.equal(result.errorCode, "INVALID_SOURCE_CONFIGURATION");
  assert.equal(locks.opened, 0);
  assert.equal(discovery.calls, 0);
});

test("source-resolution persistence errors are sanitized before lock or HTTP", async () => {
  const locks = new SharedLocks();
  const discovery = new FixedDiscovery([contest(91)]);
  const result = await new ContestRunCatalogSyncService(
    new FailingSourceRepository(),
    locks,
    discovery,
    { now: () => now },
  ).sync({ environment: "test" });

  assert.equal(result.outcome, "FAILED");
  assert.equal(result.errorCode, "DISCOVERY_PERSISTENCE_ERROR");
  assert.equal(result.sourceId, null);
  assert.equal(locks.opened, 0);
  assert.equal(discovery.calls, 0);
});

test("discovery locks are separately scoped, deterministic, and bounded", () => {
  assert.equal(
    contestRunDiscoveryLockName("Test", "42"),
    "als:test:source:42:discovery",
  );
  assert.throws(() => contestRunDiscoveryLockName("bad space", "42"));
  assert.throws(() => contestRunDiscoveryLockName("test", "not-an-id"));
});

function catalogService(
  repository: MemoryCatalogRepository,
  locks: SharedLocks,
  discovery: FixedDiscovery,
): ContestRunCatalogSyncService {
  return new ContestRunCatalogSyncService(repository, locks, discovery, {
    now: () => now,
  });
}

function contest(
  testId: number,
  name = `Contest ${testId}`,
): ContestRunDiscoveredContest {
  return {
    testId,
    discoveryEvidence: [
      {
        source: "nearest",
        record: {
          testid: testId,
          name,
          contest: `C${testId}`,
          dat: 902,
          startday: 6,
          starttime: "00:00:00",
          finishday: 7,
          finishtime: "23:59:59",
        },
      },
    ],
    categories: [{ testid: testId, catid: 1, categoryname: "source evidence" }],
    categoryFetchStatus: "FETCHED",
  };
}

class FixedDiscovery implements ContestRunCatalogDiscovery {
  calls = 0;
  constructor(
    private contests: readonly ContestRunDiscoveredContest[],
    private readonly categoryErrors: ContestRunDiscoveryResult["categoryErrors"] = [],
  ) {}

  set(contests: readonly ContestRunDiscoveredContest[]): void {
    this.contests = contests;
  }

  async discover(): Promise<ContestRunDiscoveryResult> {
    this.calls += 1;
    return {
      contests: this.contests,
      categoryErrors: this.categoryErrors,
      requestCount: 4,
      requests: [],
    };
  }
}

class MemoryCatalogRepository implements ContestRunCatalogRepository {
  readonly contests = new Map<
    string,
    { endAt: null; startAt: null; status: string; timeZone: null }
  >();
  readonly externalIds = new Map<
    string,
    { contestId: string; externalName: string | null }
  >();
  readonly mappings = new Map<
    string,
    {
      configuration: string | null;
      enabled: number;
      nextPollAt: null;
      pollIntervalSeconds: number | null;
    }
  >();
  readonly runs: Array<{
    finished?: DiscoveryRunFinish;
    id: string;
    started: DiscoveryRunStart;
  }> = [];

  constructor(
    private readonly source: ContestRunCatalogSource | null = {
      id: "1",
      code: "CONTEST_RUN",
    },
  ) {}

  async findSourceByCode(): Promise<ContestRunCatalogSource | undefined> {
    return this.source ?? undefined;
  }

  async startDiscoveryRun(started: DiscoveryRunStart): Promise<string> {
    const id = `run-${this.runs.length + 1}`;
    this.runs.push({ id, started });
    return id;
  }

  async finishDiscoveryRun(finish: DiscoveryRunFinish): Promise<void> {
    const run = this.runs.find((candidate) => candidate.id === finish.runId);
    assert(run);
    run.finished = finish;
  }

  async syncDiscoveredContest(
    input: CatalogPersistenceInput,
  ): Promise<CatalogPersistenceResult> {
    const identity = `${input.source.id}:${input.contest.testId}`;
    let external = this.externalIds.get(identity);
    let contestCreated = false;
    if (!external) {
      const contestId = `contest-${input.contest.testId}`;
      this.contests.set(contestId, {
        status: "DISCOVERED",
        startAt: null,
        endAt: null,
        timeZone: null,
      });
      external = {
        contestId,
        externalName: input.contest.discoveryEvidence[0]?.record.name ?? null,
      };
      this.externalIds.set(identity, external);
      contestCreated = true;
    } else {
      external.externalName =
        input.contest.discoveryEvidence[0]?.record.name ?? null;
    }
    const mappingIdentity = `${input.source.id}:${external.contestId}`;
    const mappingCreated = !this.mappings.has(mappingIdentity);
    if (mappingCreated) {
      this.mappings.set(mappingIdentity, {
        enabled: 0,
        pollIntervalSeconds: null,
        nextPollAt: null,
        configuration: null,
      });
    }
    return {
      contestId: external.contestId,
      contestCreated,
      contestExternalIdCreated: contestCreated,
      mappingCreated,
    };
  }
}

class FailingSourceRepository implements ContestRunCatalogRepository {
  async findSourceByCode(): Promise<ContestRunCatalogSource | undefined> {
    throw new Error("fixture database failure");
  }

  async finishDiscoveryRun(): Promise<void> {
    throw new Error("unreachable");
  }

  async startDiscoveryRun(): Promise<string> {
    throw new Error("unreachable");
  }

  async syncDiscoveredContest(): Promise<CatalogPersistenceResult> {
    throw new Error("unreachable");
  }
}

class SharedLocks implements AdvisoryLockSessionProvider {
  readonly held = new Set<string>();
  opened = 0;

  async open(): Promise<AdvisoryLockSession> {
    this.opened += 1;
    return new MemoryLock(this);
  }
}

class MemoryLock implements AdvisoryLockSession {
  private owned: string | undefined;
  constructor(private readonly locks: SharedLocks) {}

  async tryAcquire(name: string): Promise<boolean> {
    if (this.locks.held.has(name)) return false;
    this.locks.held.add(name);
    this.owned = name;
    return true;
  }

  async release(name: string): Promise<boolean> {
    if (this.owned !== name) return false;
    this.locks.held.delete(name);
    this.owned = undefined;
    return true;
  }

  async close(): Promise<void> {
    if (this.owned) this.locks.held.delete(this.owned);
  }
}
