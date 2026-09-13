import type { DatabaseDateTime, DatabaseId } from "@araucaria/database";
import {
  type AdvisoryLockSession,
  type AdvisoryLockSessionProvider,
  collectorMappingLockName,
  normalizePollingEnvironment,
  type PollingClock,
} from "./polling.js";
import { addUtcMilliseconds } from "./runtime-time.js";

export type RecoveryRunOutcome =
  | "RECOVERED"
  | "RECOVERED_DISABLED_MAPPING"
  | "RECOVERED_INVALID_MAPPING_INTERVAL"
  | "RECOVERED_WITHOUT_MAPPING"
  | "ACTIVE_LOCK_HELD"
  | "ALREADY_FINALIZED"
  | "FAILED";

export interface StaleCollectorRun {
  collectorSourceContestId: DatabaseId | null;
  id: DatabaseId;
  startedAt: DatabaseDateTime;
}

export type RecoveryFinalizationOutcome =
  | "RECOVERED"
  | "RECOVERED_DISABLED_MAPPING"
  | "RECOVERED_INVALID_MAPPING_INTERVAL"
  | "RECOVERED_WITHOUT_MAPPING"
  | "ALREADY_FINALIZED";

export interface RecoveryFinalizationResult {
  outcome: RecoveryFinalizationOutcome;
}

export interface CollectorRunRecoveryRepository {
  selectStaleRunningRuns(input: {
    environment: string;
    maxRuns: number;
    startedBefore: DatabaseDateTime;
  }): Promise<StaleCollectorRun[]>;
  finalizeStaleRunningRun(input: {
    recoveredAt: DatabaseDateTime;
    runId: DatabaseId;
  }): Promise<RecoveryFinalizationResult>;
}

export interface CollectorRunRecoveryOptions {
  environment: string;
  maxRecoveryRuns?: number;
  staleRunThresholdMs: number;
}

export interface CollectorRunRecoveryResult {
  advisoryLockName: string | null;
  errorCode: string | null;
  mappingId: DatabaseId | null;
  outcome: RecoveryRunOutcome;
  runId: DatabaseId;
}

export interface CollectorRunRecoverySummary {
  activeLockSkippedCount: number;
  candidates: number;
  failedCount: number;
  recoveredCount: number;
  results: CollectorRunRecoveryResult[];
}

const DEFAULT_MAX_RECOVERY_RUNS = 50;
const MAX_RECOVERY_RUNS = 100;

/**
 * Recovers only old RUNNING rows whose mapping lock can be reacquired. A
 * RUNNING row is audit state, never proof of currently-held lock ownership.
 */
export class CollectorRunRecoveryService {
  constructor(
    private readonly repository: CollectorRunRecoveryRepository,
    private readonly locks: AdvisoryLockSessionProvider,
    private readonly clock: PollingClock,
  ) {}

  async recover(
    options: CollectorRunRecoveryOptions,
  ): Promise<CollectorRunRecoverySummary> {
    const environment = normalizePollingEnvironment(options.environment);
    const maxRuns = validateMaxRecoveryRuns(options.maxRecoveryRuns);
    validateStaleThreshold(options.staleRunThresholdMs);
    const now = this.clock.now();
    const candidates = await this.repository.selectStaleRunningRuns({
      environment,
      maxRuns,
      startedBefore: addUtcMilliseconds(now, -options.staleRunThresholdMs),
    });
    const results: CollectorRunRecoveryResult[] = [];
    for (const candidate of candidates) {
      results.push(await this.recoverOne(candidate, environment, now));
    }
    return {
      candidates: candidates.length,
      recoveredCount: results.filter(isRecovered).length,
      activeLockSkippedCount: results.filter(
        (result) => result.outcome === "ACTIVE_LOCK_HELD",
      ).length,
      failedCount: results.filter((result) => result.outcome === "FAILED")
        .length,
      results,
    };
  }

  private async recoverOne(
    candidate: StaleCollectorRun,
    environment: string,
    recoveredAt: DatabaseDateTime,
  ): Promise<CollectorRunRecoveryResult> {
    if (candidate.collectorSourceContestId === null) {
      return this.finalizeWithoutLock(candidate, recoveredAt);
    }
    const lockName = collectorMappingLockName(
      environment,
      candidate.collectorSourceContestId,
    );
    let session: AdvisoryLockSession | undefined;
    let ownsLock = false;
    let result: CollectorRunRecoveryResult;
    let release: { ok: boolean } | undefined;
    try {
      session = await this.locks.open();
      ownsLock = await session.tryAcquire(lockName);
      if (!ownsLock) {
        result = {
          runId: candidate.id,
          mappingId: candidate.collectorSourceContestId,
          advisoryLockName: lockName,
          outcome: "ACTIVE_LOCK_HELD",
          errorCode: null,
        };
      } else {
        const finalization = await this.repository.finalizeStaleRunningRun({
          runId: candidate.id,
          recoveredAt,
        });
        result = finalizationResult(candidate, lockName, finalization);
      }
    } catch {
      result = {
        runId: candidate.id,
        mappingId: candidate.collectorSourceContestId,
        advisoryLockName: lockName,
        outcome: "FAILED",
        errorCode: "RECOVERY_ERROR",
      };
    } finally {
      release = await releaseAndClose(session, lockName, ownsLock);
    }
    if (!release?.ok && ownsLock) {
      return {
        ...result,
        outcome: "FAILED",
        errorCode: "LOCK_RELEASE_ANOMALY",
      };
    }
    return result;
  }

  private async finalizeWithoutLock(
    candidate: StaleCollectorRun,
    recoveredAt: DatabaseDateTime,
  ): Promise<CollectorRunRecoveryResult> {
    try {
      const finalization = await this.repository.finalizeStaleRunningRun({
        runId: candidate.id,
        recoveredAt,
      });
      return finalizationResult(candidate, null, finalization);
    } catch {
      return {
        runId: candidate.id,
        mappingId: null,
        advisoryLockName: null,
        outcome: "FAILED",
        errorCode: "RECOVERY_ERROR",
      };
    }
  }
}

function finalizationResult(
  candidate: StaleCollectorRun,
  lockName: string | null,
  finalization: RecoveryFinalizationResult,
): CollectorRunRecoveryResult {
  return {
    runId: candidate.id,
    mappingId: candidate.collectorSourceContestId,
    advisoryLockName: lockName,
    outcome: finalization.outcome,
    errorCode:
      finalization.outcome === "ALREADY_FINALIZED"
        ? null
        : "ABANDONED_RUN_RECOVERED",
  };
}

function isRecovered(result: CollectorRunRecoveryResult): boolean {
  return (
    result.outcome === "RECOVERED" ||
    result.outcome === "RECOVERED_DISABLED_MAPPING" ||
    result.outcome === "RECOVERED_INVALID_MAPPING_INTERVAL" ||
    result.outcome === "RECOVERED_WITHOUT_MAPPING"
  );
}

async function releaseAndClose(
  session: AdvisoryLockSession | undefined,
  lockName: string,
  ownsLock: boolean,
): Promise<{ ok: boolean }> {
  if (!session) return { ok: false };
  let ok = true;
  if (ownsLock) {
    try {
      ok = await session.release(lockName);
    } catch {
      ok = false;
    }
  }
  try {
    await session.close();
  } catch {
    ok = false;
  }
  return { ok };
}

function validateMaxRecoveryRuns(value: number | undefined): number {
  if (value === undefined) return DEFAULT_MAX_RECOVERY_RUNS;
  if (!Number.isSafeInteger(value) || value < 1 || value > MAX_RECOVERY_RUNS) {
    throw new Error(
      `maxRecoveryRuns must be an integer from 1 to ${MAX_RECOVERY_RUNS}.`,
    );
  }
  return value;
}

function validateStaleThreshold(value: number): void {
  if (!Number.isSafeInteger(value) || value < 1_000) {
    throw new Error("staleRunThresholdMs must be an integer of at least 1000.");
  }
}
