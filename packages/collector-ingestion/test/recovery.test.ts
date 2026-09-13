import assert from "node:assert/strict";
import test from "node:test";
import {
  type CollectorRunRecoveryRepository,
  CollectorRunRecoveryService,
  type RecoveryFinalizationResult,
  type StaleCollectorRun,
} from "../src/index.js";
import type {
  AdvisoryLockSession,
  AdvisoryLockSessionProvider,
} from "../src/polling.js";

const now = "2026-09-13 12:00:00.000000";

test("stale RUNNING with a free mapping lock is recovered and releases the lock", async () => {
  const repository = new RecoveryRepository([candidate("1", "7")], "RECOVERED");
  const locks = new RecoveryLocks();
  const result = await recovery(repository, locks).recover({
    environment: "test",
    staleRunThresholdMs: 60_000,
  });

  assert.equal(result.recoveredCount, 1);
  assert.deepEqual(result.results[0], {
    runId: "1",
    mappingId: "7",
    advisoryLockName: "als:test:csc:7",
    outcome: "RECOVERED",
    errorCode: "ABANDONED_RUN_RECOVERED",
  });
  assert.equal(repository.finalized.length, 1);
  assert.equal(repository.finalized[0]?.recoveredAt, now);
  assert.equal(locks.held.size, 0);
  assert.equal(locks.releases, 1);
});

test("an apparently active stale run is left unchanged when its mapping lock is held", async () => {
  const repository = new RecoveryRepository([candidate("1", "7")], "RECOVERED");
  const locks = new RecoveryLocks(["als:test:csc:7"]);
  const result = await recovery(repository, locks).recover({
    environment: "test",
    staleRunThresholdMs: 60_000,
  });

  assert.equal(result.activeLockSkippedCount, 1);
  assert.equal(result.results[0]?.outcome, "ACTIVE_LOCK_HELD");
  assert.equal(repository.finalized.length, 0);
  assert.equal(locks.releases, 0);
});

test("a conditional finalization race is reported without overwriting the completed run", async () => {
  const repository = new RecoveryRepository(
    [candidate("1", "7")],
    "ALREADY_FINALIZED",
  );
  const result = await recovery(repository, new RecoveryLocks()).recover({
    environment: "test",
    staleRunThresholdMs: 60_000,
  });

  assert.equal(result.recoveredCount, 0);
  assert.equal(result.results[0]?.outcome, "ALREADY_FINALIZED");
  assert.equal(result.results[0]?.errorCode, null);
});

test("fresh RUNNING rows are ignored by the bounded stale query", async () => {
  const repository = new RecoveryRepository([], "RECOVERED");
  const result = await recovery(repository, new RecoveryLocks()).recover({
    environment: "test",
    staleRunThresholdMs: 60_000,
  });

  assert.equal(result.candidates, 0);
  assert.equal(
    repository.selection?.startedBefore,
    "2026-09-13 11:59:00.000000",
  );
});

test("disabled, invalid-interval, and unmapped stale runs finalize without invented scheduling", async () => {
  for (const outcome of [
    "RECOVERED_DISABLED_MAPPING",
    "RECOVERED_INVALID_MAPPING_INTERVAL",
    "RECOVERED_WITHOUT_MAPPING",
  ] as const) {
    const mappingId = outcome === "RECOVERED_WITHOUT_MAPPING" ? null : "7";
    const repository = new RecoveryRepository(
      [candidate("1", mappingId)],
      outcome,
    );
    const result = await recovery(repository, new RecoveryLocks()).recover({
      environment: "test",
      staleRunThresholdMs: 60_000,
    });

    assert.equal(result.recoveredCount, 1);
    assert.equal(result.results[0]?.outcome, outcome);
    assert.equal(result.results[0]?.errorCode, "ABANDONED_RUN_RECOVERED");
  }
});

test("recovery reports a release anomaly with a sanitized error code", async () => {
  const repository = new RecoveryRepository([candidate("1", "7")], "RECOVERED");
  const locks = new RecoveryLocks([], false);
  const result = await recovery(repository, locks).recover({
    environment: "test",
    staleRunThresholdMs: 60_000,
  });

  assert.equal(result.results[0]?.outcome, "FAILED");
  assert.equal(result.results[0]?.errorCode, "LOCK_RELEASE_ANOMALY");
  assert.equal(locks.closed, 1);
});

function recovery(
  repository: RecoveryRepository,
  locks: RecoveryLocks,
): CollectorRunRecoveryService {
  return new CollectorRunRecoveryService(repository, locks, { now: () => now });
}

function candidate(
  id: string,
  collectorSourceContestId: string | null,
): StaleCollectorRun {
  return {
    id,
    collectorSourceContestId,
    startedAt: "2026-09-13 11:00:00.000000",
  };
}

class RecoveryRepository implements CollectorRunRecoveryRepository {
  selection:
    | { environment: string; maxRuns: number; startedBefore: string }
    | undefined;
  readonly finalized: Array<{ recoveredAt: string; runId: string }> = [];

  constructor(
    private readonly candidates: StaleCollectorRun[],
    private readonly outcome: RecoveryFinalizationResult["outcome"],
  ) {}

  async selectStaleRunningRuns(input: {
    environment: string;
    maxRuns: number;
    startedBefore: string;
  }): Promise<StaleCollectorRun[]> {
    this.selection = input;
    return this.candidates;
  }

  async finalizeStaleRunningRun(input: {
    recoveredAt: string;
    runId: string;
  }): Promise<RecoveryFinalizationResult> {
    this.finalized.push(input);
    return { outcome: this.outcome };
  }
}

class RecoveryLocks implements AdvisoryLockSessionProvider {
  readonly held: Set<string>;
  releases = 0;
  closed = 0;

  constructor(
    held: string[] = [],
    readonly releaseResult = true,
  ) {
    this.held = new Set(held);
  }

  async open(): Promise<AdvisoryLockSession> {
    return new RecoveryLockSession(this);
  }
}

class RecoveryLockSession implements AdvisoryLockSession {
  private owned: string | undefined;
  constructor(private readonly locks: RecoveryLocks) {}

  async tryAcquire(lockName: string): Promise<boolean> {
    if (this.locks.held.has(lockName)) return false;
    this.locks.held.add(lockName);
    this.owned = lockName;
    return true;
  }

  async release(lockName: string): Promise<boolean> {
    if (this.owned !== lockName) return false;
    this.owned = undefined;
    this.locks.held.delete(lockName);
    this.locks.releases += 1;
    return this.locks.releaseResult;
  }

  async close(): Promise<void> {
    this.locks.closed += 1;
    if (this.owned) this.locks.held.delete(this.owned);
  }
}
