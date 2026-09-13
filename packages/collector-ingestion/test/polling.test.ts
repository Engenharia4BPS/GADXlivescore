import assert from "node:assert/strict";
import test from "node:test";
import {
  CollectorPollingService,
  type CollectorRunCompletion,
  type CollectorRunStart,
  type CollectorSourceContestMapping,
  collectorMappingLockName,
  type PollingMappingRepository,
  type PollingSourceRunContext,
  PollingSourceRunError,
  type PollingSourceRunner,
  type PollingSourceRunResult,
} from "../src/index.js";
import type {
  AdvisoryLockSession,
  AdvisoryLockSessionProvider,
  PollingClock,
} from "../src/polling.js";

const now = "2026-09-13 12:00:00.000000";

test("two workers for one mapping acquire once and the loser performs no work", async () => {
  const repository = new MemoryPollingRepository([mapping("1")]);
  const locks = new SharedLocks();
  const runner = new GatedRunner();
  const first = service(repository, locks, runner).runCycle({
    environment: "test",
  });
  await runner.started;
  const second = await service(repository, locks, runner).runCycle({
    environment: "test",
  });
  runner.allow();
  const firstResult = await first;

  assert.equal(firstResult.mappingsSucceeded, 1);
  assert.equal(second.results[0]?.outcome, "LOCKED_BY_OTHER");
  assert.equal(runner.fetchCount, 1);
  assert.equal(runner.ingestionCount, 1);
  assert.equal(repository.started.length, 1);
  assert.equal(repository.finalized.length, 1);
  assert.equal(locks.held.size, 0);
});

test("different due mappings run independently with distinct per-mapping locks", async () => {
  const repository = new MemoryPollingRepository([mapping("1"), mapping("2")]);
  const runner = new ConcurrentRunner();
  const result = await service(repository, new SharedLocks(), runner).runCycle({
    environment: "test",
  });

  assert.equal(result.mappingsSucceeded, 2);
  assert.equal(runner.maxActive, 2);
  assert.deepEqual(
    repository.started.map((run) => run.advisoryLockName),
    ["als:test:csc:1", "als:test:csc:2"],
  );
});

test("successful run creates and finalizes one collector run and advances schedule", async () => {
  const repository = new MemoryPollingRepository([
    mapping("1", { pollIntervalSeconds: 60 }),
  ]);
  const locks = new SharedLocks();
  const result = await service(
    repository,
    locks,
    new SuccessfulRunner(),
  ).runCycle({
    environment: "Test",
  });
  const start = only(repository.started);
  const finish = only(repository.finalized);
  const updated = only(repository.mappings);

  assert.equal(result.results[0]?.outcome, "SUCCESS");
  assert.equal(start.environment, "test");
  assert.equal(start.advisoryLockName, "als:test:csc:1");
  assert.equal(finish.completion.outcome, "SUCCESS");
  assert.equal(finish.completion.requestCount, 1);
  assert.equal(finish.completion.receivedMessageCount, 1);
  assert.equal(updated.lastSuccessAt, now);
  assert.equal(updated.lastFailureAt, null);
  assert.equal(updated.nextPollAt, "2026-09-13 12:01:00.000000");
  assert.equal(locks.held.size, 0);
});

test("HTTP and ingestion failures finalize failed runs and release the mapping lock", async () => {
  for (const failure of [
    new PollingSourceRunError("HTTP_TIMEOUT", 1, 0, "timeout"),
    new PollingSourceRunError("INGESTION_FAILED", 1, 1, "failed receipt"),
  ]) {
    const repository = new MemoryPollingRepository([mapping("1")]);
    const locks = new SharedLocks();
    const result = await service(
      repository,
      locks,
      new FailingRunner(failure),
    ).runCycle({
      environment: "test",
    });
    const finish = only(repository.finalized);
    const updated = only(repository.mappings);

    assert.equal(result.results[0]?.outcome, "FAILED");
    assert.equal(result.results[0]?.errorCode, failure.code);
    assert.equal(finish.completion.outcome, "FAILED");
    assert.equal(finish.completion.requestCount, failure.requestCount);
    assert.equal(
      finish.completion.receivedMessageCount,
      failure.receivedMessageCount,
    );
    assert.deepEqual(finish.completion.errorDetails, {
      error_code: failure.code,
    });
    assert.equal(updated.lastSuccessAt, null);
    assert.equal(updated.lastFailureAt, now);
    assert.equal(updated.nextPollAt, "2026-09-13 12:01:00.000000");
    assert.equal(locks.held.size, 0);
  }
});

test("invalid configuration and lock contention do not create runs or change scheduling", async () => {
  const invalid = mapping("1", { pollIntervalSeconds: null });
  const repository = new MemoryPollingRepository([invalid]);
  const locks = new SharedLocks();
  const invalidResult = await service(
    repository,
    locks,
    new SuccessfulRunner(),
  ).runCycle({ environment: "test" });
  assert.equal(invalidResult.results[0]?.outcome, "INVALID_CONFIGURATION");
  assert.equal(repository.started.length, 0);
  assert.equal(locks.opened, 0);

  const contended = mapping("2", { nextPollAt: null });
  repository.mappings = [contended];
  locks.held.add("als:test:csc:2");
  const before = structuredClone(contended);
  const contentionResult = await service(
    repository,
    locks,
    new SuccessfulRunner(),
  ).runCycle({ environment: "test" });
  assert.equal(contentionResult.results[0]?.outcome, "LOCKED_BY_OTHER");
  assert.equal(repository.started.length, 0);
  assert.deepEqual(only(repository.mappings), before);
});

test("source work occurs outside repository finalization transactions", async () => {
  const repository = new MemoryPollingRepository([mapping("1")]);
  const runner = new SuccessfulRunner(() => {
    assert.equal(repository.inTransaction, false);
  });
  await service(repository, new SharedLocks(), runner).runCycle({
    environment: "test",
  });
  assert.equal(repository.inTransaction, false);
});

test("finalization failures are sanitized and still release the mapping lock", async () => {
  const repository = new FinalizationFailingRepository([mapping("1")]);
  const locks = new SharedLocks();
  const result = await service(
    repository,
    locks,
    new SuccessfulRunner(),
  ).runCycle({
    environment: "test",
  });
  assert.equal(result.results[0]?.outcome, "FAILED");
  assert.equal(result.results[0]?.errorCode, "FINALIZATION_FAILED");
  assert.equal(result.results[0]?.requestCount, 1);
  assert.equal(result.results[0]?.receivedMessageCount, 1);
  assert.equal(locks.held.size, 0);
  assert.equal(locks.closed, 1);
});

test("release anomaly is surfaced without leaking the session", async () => {
  const repository = new MemoryPollingRepository([mapping("1")]);
  const locks = new SharedLocks({ releaseResult: false });
  const result = await service(
    repository,
    locks,
    new SuccessfulRunner(),
  ).runCycle({
    environment: "test",
  });
  assert.equal(result.results[0]?.outcome, "FAILED");
  assert.equal(result.results[0]?.errorCode, "LOCK_RELEASE_ANOMALY");
  assert.equal(repository.finalized.length, 2);
  assert.equal(repository.finalized[1]?.completion.outcome, "FAILED");
  assert.equal(locks.closed, 1);
});

test("lock names are deterministic, bounded, and environment scoped", () => {
  assert.equal(
    collectorMappingLockName("Production", "42"),
    "als:production:csc:42",
  );
  assert.throws(() => collectorMappingLockName("bad space", "42"));
  assert.throws(() => collectorMappingLockName("test", "not-an-id"));
});

function service(
  repository: MemoryPollingRepository,
  locks: SharedLocks,
  runner: PollingSourceRunner,
): CollectorPollingService {
  const clock: PollingClock = { now: () => now };
  return new CollectorPollingService(repository, locks, runner, clock);
}

function mapping(
  id: string,
  overrides: Partial<CollectorSourceContestMapping> = {},
): CollectorSourceContestMapping & {
  lastFailureAt: string | null;
  lastSuccessAt: string | null;
} {
  return {
    id,
    sourceId: `source-${id}`,
    contestId: `contest-${id}`,
    contestExternalId: "91",
    enabled: 1,
    pollIntervalSeconds: 60,
    nextPollAt: null,
    lastFailureAt: null,
    lastSuccessAt: null,
    ...overrides,
  };
}

class MemoryPollingRepository implements PollingMappingRepository {
  mappings: Array<ReturnType<typeof mapping>>;
  readonly started: Array<CollectorRunStart & { id: string }> = [];
  readonly finalized: Array<{
    completion: CollectorRunCompletion;
    nextPollAt: string;
    runId: string;
  }> = [];
  inTransaction = false;

  constructor(mappings: Array<ReturnType<typeof mapping>>) {
    this.mappings = mappings;
  }

  async selectDueMappings(
    current: string,
    maximum: number,
  ): Promise<CollectorSourceContestMapping[]> {
    return this.mappings
      .filter(
        (entry) =>
          entry.enabled === 1 &&
          (entry.nextPollAt === null || entry.nextPollAt <= current),
      )
      .sort(
        (left, right) =>
          Number(left.nextPollAt !== null) -
            Number(right.nextPollAt !== null) ||
          (left.nextPollAt ?? "").localeCompare(right.nextPollAt ?? "") ||
          Number(left.id) - Number(right.id),
      )
      .slice(0, maximum);
  }

  async startRun(start: CollectorRunStart): Promise<string> {
    const id = `run-${this.started.length + 1}`;
    this.started.push({ ...start, id });
    return id;
  }

  async finalizeRunAndSchedule(
    runId: string,
    polled: CollectorSourceContestMapping,
    completion: CollectorRunCompletion,
    nextPollAt: string,
  ): Promise<void> {
    this.inTransaction = true;
    try {
      const entry = this.mappings.find(
        (candidate) => candidate.id === polled.id,
      );
      assert(entry, "Missing fixture mapping.");
      if (completion.outcome === "SUCCESS")
        entry.lastSuccessAt = completion.finishedAt;
      else entry.lastFailureAt = completion.finishedAt;
      entry.nextPollAt = nextPollAt;
      this.finalized.push({ runId, completion, nextPollAt });
    } finally {
      this.inTransaction = false;
    }
  }
}

class SharedLocks implements AdvisoryLockSessionProvider {
  readonly held = new Set<string>();
  opened = 0;
  closed = 0;

  constructor(readonly options: { releaseResult?: boolean } = {}) {}

  async open(): Promise<AdvisoryLockSession> {
    this.opened += 1;
    return new MemoryLockSession(this);
  }
}

class FinalizationFailingRepository extends MemoryPollingRepository {
  override async finalizeRunAndSchedule(): Promise<void> {
    throw new Error("Simulated database finalization failure.");
  }
}

class MemoryLockSession implements AdvisoryLockSession {
  private owned: string | undefined;

  constructor(private readonly locks: SharedLocks) {}

  async tryAcquire(lockName: string): Promise<boolean> {
    if (this.locks.held.has(lockName)) return false;
    this.locks.held.add(lockName);
    this.owned = lockName;
    return true;
  }

  async release(lockName: string): Promise<boolean> {
    if (this.owned !== lockName) return false;
    this.locks.held.delete(lockName);
    this.owned = undefined;
    return this.locks.options.releaseResult ?? true;
  }

  async close(): Promise<void> {
    this.locks.closed += 1;
    if (this.owned) this.locks.held.delete(this.owned);
  }
}

class SuccessfulRunner implements PollingSourceRunner {
  constructor(private readonly onRun: (() => void) | undefined = undefined) {}

  async run(
    _context: PollingSourceRunContext,
  ): Promise<PollingSourceRunResult> {
    this.onRun?.();
    return { requestCount: 1, receivedMessageCount: 1 };
  }
}

class FailingRunner implements PollingSourceRunner {
  constructor(private readonly error: PollingSourceRunError) {}

  async run(): Promise<PollingSourceRunResult> {
    throw this.error;
  }
}

class GatedRunner implements PollingSourceRunner {
  fetchCount = 0;
  ingestionCount = 0;
  private resolveStarted: (() => void) | undefined;
  private resolveAllowed: (() => void) | undefined;
  readonly started = new Promise<void>((resolve) => {
    this.resolveStarted = resolve;
  });
  private readonly allowed = new Promise<void>((resolve) => {
    this.resolveAllowed = resolve;
  });

  async run(): Promise<PollingSourceRunResult> {
    this.fetchCount += 1;
    this.resolveStarted?.();
    await this.allowed;
    this.ingestionCount += 1;
    return { requestCount: 1, receivedMessageCount: 1 };
  }

  allow(): void {
    this.resolveAllowed?.();
  }
}

class ConcurrentRunner implements PollingSourceRunner {
  active = 0;
  maxActive = 0;

  async run(): Promise<PollingSourceRunResult> {
    this.active += 1;
    this.maxActive = Math.max(this.maxActive, this.active);
    await Promise.resolve();
    this.active -= 1;
    return { requestCount: 1, receivedMessageCount: 1 };
  }
}

function only<T>(values: readonly T[]): T {
  const value = values[0];
  if (value === undefined)
    throw new Error("Expected exactly one fixture value.");
  return value;
}
