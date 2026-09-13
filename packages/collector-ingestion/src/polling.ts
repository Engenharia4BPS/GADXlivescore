import type {
  DatabaseDateTime,
  DatabaseId,
  JsonValue,
} from "@araucaria/database";

export type PollingMappingOutcome =
  | "SUCCESS"
  | "LOCKED_BY_OTHER"
  | "INVALID_CONFIGURATION"
  | "FAILED";

export interface CollectorSourceContestMapping {
  id: DatabaseId;
  sourceId: DatabaseId;
  contestId: DatabaseId;
  contestExternalId: string | null;
  enabled: number;
  pollIntervalSeconds: number | null;
  nextPollAt: DatabaseDateTime | null;
}

export interface CollectorRunStart {
  advisoryLockName: string;
  environment: string;
  mapping: CollectorSourceContestMapping;
  startedAt: DatabaseDateTime;
}

export interface CollectorRunCompletion {
  errorCode: string | null;
  errorDetails: JsonValue | null;
  finishedAt: DatabaseDateTime;
  outcome: "SUCCESS" | "FAILED";
  receivedMessageCount: number;
  requestCount: number;
}

export interface PollingMappingRepository {
  selectDueMappings(
    now: DatabaseDateTime,
    maxMappings: number,
  ): Promise<CollectorSourceContestMapping[]>;
  startRun(start: CollectorRunStart): Promise<DatabaseId>;
  finalizeRunAndSchedule(
    runId: DatabaseId,
    mapping: CollectorSourceContestMapping,
    completion: CollectorRunCompletion,
    nextPollAt: DatabaseDateTime,
  ): Promise<void>;
}

export interface AdvisoryLockSession {
  tryAcquire(lockName: string): Promise<boolean>;
  release(lockName: string): Promise<boolean>;
  close(): Promise<void>;
}

export interface AdvisoryLockSessionProvider {
  open(): Promise<AdvisoryLockSession>;
}

export interface PollingSourceRunContext {
  collectorRunId: DatabaseId;
  mapping: CollectorSourceContestMapping;
  receivedAt: DatabaseDateTime;
}

export interface PollingSourceRunResult {
  receivedMessageCount: number;
  requestCount: number;
}

export interface PollingSourceRunner {
  validateMapping?(mapping: CollectorSourceContestMapping): string | undefined;
  run(context: PollingSourceRunContext): Promise<PollingSourceRunResult>;
}

export interface PollingClock {
  now(): DatabaseDateTime;
}

export interface PollingCycleOptions {
  environment: string;
  maxMappingsPerCycle?: number;
}

export interface PollingMappingResult {
  advisoryLockName: string | null;
  errorCode: string | null;
  mappingId: DatabaseId;
  outcome: PollingMappingOutcome;
  receivedMessageCount: number;
  requestCount: number;
  runId: DatabaseId | null;
}

export interface PollingCycleResult {
  mappingsConsidered: number;
  mappingsFailed: number;
  mappingsInvalid: number;
  mappingsLockedByOther: number;
  mappingsSucceeded: number;
  results: PollingMappingResult[];
}

const DEFAULT_MAX_MAPPINGS_PER_CYCLE = 10;
const MAX_MAPPINGS_PER_CYCLE = 100;
const MAX_LOCK_NAME_LENGTH = 64;

/**
 * Orchestrates one bounded polling cycle. It intentionally has no source or
 * database implementation detail, keeping its network operation outside any
 * database transaction.
 */
export class CollectorPollingService {
  constructor(
    private readonly mappings: PollingMappingRepository,
    private readonly locks: AdvisoryLockSessionProvider,
    private readonly sourceRunner: PollingSourceRunner,
    private readonly clock: PollingClock = { now: systemUtcClock },
  ) {}

  async runCycle(options: PollingCycleOptions): Promise<PollingCycleResult> {
    const environment = normalizePollingEnvironment(options.environment);
    const maxMappings = validateMaxMappings(options.maxMappingsPerCycle);
    const mappings = await this.mappings.selectDueMappings(
      this.clock.now(),
      maxMappings,
    );
    const results = await Promise.all(
      mappings.map((mapping) => this.runMapping(mapping, environment)),
    );
    return summarizeCycle(results);
  }

  private async runMapping(
    mapping: CollectorSourceContestMapping,
    environment: string,
  ): Promise<PollingMappingResult> {
    const interval = validPollInterval(mapping.pollIntervalSeconds);
    const sourceConfigurationError =
      this.sourceRunner.validateMapping?.(mapping);
    if (!interval || sourceConfigurationError) {
      return invalidConfigurationResult(mapping.id);
    }
    const lockName = collectorMappingLockName(environment, mapping.id);
    let session: AdvisoryLockSession | undefined;
    let ownsLock = false;
    let runId: DatabaseId | undefined;
    let result: PollingMappingResult | undefined;
    let sourceResult: PollingSourceRunResult | undefined;

    try {
      session = await this.locks.open();
      ownsLock = await session.tryAcquire(lockName);
      if (!ownsLock) return lockedByOtherResult(mapping.id, lockName);

      const startedAt = this.clock.now();
      runId = await this.mappings.startRun({
        mapping,
        environment,
        advisoryLockName: lockName,
        startedAt,
      });
      sourceResult = await this.sourceRunner.run({
        collectorRunId: runId,
        mapping,
        receivedAt: this.clock.now(),
      });
      const finishedAt = this.clock.now();
      await this.mappings.finalizeRunAndSchedule(
        runId,
        mapping,
        successfulCompletion(sourceResult, finishedAt),
        addUtcSeconds(finishedAt, interval),
      );
      result = {
        mappingId: mapping.id,
        outcome: "SUCCESS",
        runId,
        advisoryLockName: lockName,
        requestCount: sourceResult.requestCount,
        receivedMessageCount: sourceResult.receivedMessageCount,
        errorCode: null,
      };
    } catch (error) {
      const failure = pollingFailure(error, sourceResult);
      const finishedAt = this.clock.now();
      if (runId) {
        try {
          await this.mappings.finalizeRunAndSchedule(
            runId,
            mapping,
            failedCompletion(failure, finishedAt),
            addUtcSeconds(finishedAt, interval),
          );
        } catch {
          return failedResult(
            mapping.id,
            runId,
            lockName,
            "FINALIZATION_FAILED",
            failure.requestCount,
            failure.receivedMessageCount,
          );
        }
      }
      return failedResult(
        mapping.id,
        runId ?? null,
        lockName,
        failure.code,
        failure.requestCount,
        failure.receivedMessageCount,
      );
    } finally {
      const releaseResult = await releaseAndClose(session, lockName, ownsLock);
      if (!releaseResult.ok && result?.outcome === "SUCCESS" && runId) {
        const finishedAt = this.clock.now();
        const failure: PollingFailure = {
          code: "LOCK_RELEASE_ANOMALY",
          requestCount: result.requestCount,
          receivedMessageCount: result.receivedMessageCount,
        };
        try {
          await this.mappings.finalizeRunAndSchedule(
            runId,
            mapping,
            failedCompletion(failure, finishedAt),
            addUtcSeconds(finishedAt, interval),
          );
          result = {
            ...result,
            outcome: "FAILED",
            errorCode: failure.code,
          };
        } catch {
          result = failedResult(
            mapping.id,
            runId,
            lockName,
            "FINALIZATION_FAILED",
            failure.requestCount,
            failure.receivedMessageCount,
          );
        }
      }
    }
    return (
      result ??
      failedResult(mapping.id, runId ?? null, lockName, "UNKNOWN", 0, 0)
    );
  }
}

/** Source runners can preserve known request/receipt counts when they fail. */
export class PollingSourceRunError extends Error {
  constructor(
    readonly code: string,
    readonly requestCount: number,
    readonly receivedMessageCount: number,
    message: string,
  ) {
    super(message);
    this.name = "PollingSourceRunError";
  }
}

export function collectorMappingLockName(
  environment: string,
  mappingId: DatabaseId,
): string {
  const normalizedEnvironment = normalizePollingEnvironment(environment);
  if (!/^\d+$/.test(mappingId)) {
    throw new Error("Collector source contest ID must be an unsigned integer.");
  }
  const lockName = `als:${normalizedEnvironment}:csc:${mappingId}`;
  if (lockName.length > MAX_LOCK_NAME_LENGTH) {
    throw new Error(
      "Collector advisory lock name exceeds the MySQL 5.7 limit.",
    );
  }
  return lockName;
}

export function normalizePollingEnvironment(environment: string): string {
  const normalized = environment.trim().toLowerCase();
  if (!/^[a-z0-9][a-z0-9_-]{0,31}$/.test(normalized)) {
    throw new Error(
      "Collector environment must contain 1-32 lowercase letters, digits, hyphens, or underscores.",
    );
  }
  return normalized;
}

function validPollInterval(value: number | null): number | undefined {
  if (value === null || !Number.isSafeInteger(value) || value <= 0)
    return undefined;
  return value;
}

function validateMaxMappings(value: number | undefined): number {
  if (value === undefined) return DEFAULT_MAX_MAPPINGS_PER_CYCLE;
  if (
    !Number.isSafeInteger(value) ||
    value < 1 ||
    value > MAX_MAPPINGS_PER_CYCLE
  ) {
    throw new Error(
      `maxMappingsPerCycle must be an integer from 1 to ${MAX_MAPPINGS_PER_CYCLE}.`,
    );
  }
  return value;
}

function successfulCompletion(
  source: PollingSourceRunResult,
  finishedAt: DatabaseDateTime,
): CollectorRunCompletion {
  return {
    outcome: "SUCCESS",
    finishedAt,
    requestCount: source.requestCount,
    receivedMessageCount: source.receivedMessageCount,
    errorCode: null,
    errorDetails: null,
  };
}

function failedCompletion(
  failure: PollingFailure,
  finishedAt: DatabaseDateTime,
): CollectorRunCompletion {
  return {
    outcome: "FAILED",
    finishedAt,
    requestCount: failure.requestCount,
    receivedMessageCount: failure.receivedMessageCount,
    errorCode: failure.code,
    errorDetails: { error_code: failure.code },
  };
}

interface PollingFailure {
  code: string;
  receivedMessageCount: number;
  requestCount: number;
}

function pollingFailure(
  error: unknown,
  completedSourceRun: PollingSourceRunResult | undefined,
): PollingFailure {
  if (error instanceof PollingSourceRunError) {
    return {
      code: sanitizeErrorCode(error.code),
      requestCount: error.requestCount,
      receivedMessageCount: error.receivedMessageCount,
    };
  }
  return {
    code: "POLLING_ERROR",
    requestCount: completedSourceRun?.requestCount ?? 0,
    receivedMessageCount: completedSourceRun?.receivedMessageCount ?? 0,
  };
}

function sanitizeErrorCode(value: string): string {
  const sanitized = value.toUpperCase().replaceAll(/[^A-Z0-9_]/g, "_");
  return sanitized.slice(0, 128) || "POLLING_ERROR";
}

function invalidConfigurationResult(
  mappingId: DatabaseId,
): PollingMappingResult {
  return {
    mappingId,
    outcome: "INVALID_CONFIGURATION",
    runId: null,
    advisoryLockName: null,
    requestCount: 0,
    receivedMessageCount: 0,
    errorCode: "INVALID_MAPPING_CONFIGURATION",
  };
}

function lockedByOtherResult(
  mappingId: DatabaseId,
  lockName: string,
): PollingMappingResult {
  return {
    mappingId,
    outcome: "LOCKED_BY_OTHER",
    runId: null,
    advisoryLockName: lockName,
    requestCount: 0,
    receivedMessageCount: 0,
    errorCode: null,
  };
}

function failedResult(
  mappingId: DatabaseId,
  runId: DatabaseId | null,
  lockName: string,
  errorCode: string,
  requestCount: number,
  receivedMessageCount: number,
): PollingMappingResult {
  return {
    mappingId,
    outcome: "FAILED",
    runId,
    advisoryLockName: lockName,
    requestCount,
    receivedMessageCount,
    errorCode: sanitizeErrorCode(errorCode),
  };
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

function addUtcSeconds(
  value: DatabaseDateTime,
  seconds: number,
): DatabaseDateTime {
  const timestamp = new Date(`${value.replace(" ", "T")}Z`);
  if (Number.isNaN(timestamp.getTime())) {
    throw new Error("Polling clock must return a UTC MySQL datetime string.");
  }
  timestamp.setUTCSeconds(timestamp.getUTCSeconds() + seconds);
  return formatUtcDateTime(timestamp);
}

function systemUtcClock(): DatabaseDateTime {
  return formatUtcDateTime(new Date());
}

function formatUtcDateTime(value: Date): DatabaseDateTime {
  const part = (number: number, width = 2) =>
    String(number).padStart(width, "0");
  return `${part(value.getUTCFullYear(), 4)}-${part(value.getUTCMonth() + 1)}-${part(value.getUTCDate())} ${part(value.getUTCHours())}:${part(value.getUTCMinutes())}:${part(value.getUTCSeconds())}.${part(value.getUTCMilliseconds(), 3)}000`;
}

function summarizeCycle(results: PollingMappingResult[]): PollingCycleResult {
  return {
    mappingsConsidered: results.length,
    mappingsSucceeded: results.filter((result) => result.outcome === "SUCCESS")
      .length,
    mappingsLockedByOther: results.filter(
      (result) => result.outcome === "LOCKED_BY_OTHER",
    ).length,
    mappingsInvalid: results.filter(
      (result) => result.outcome === "INVALID_CONFIGURATION",
    ).length,
    mappingsFailed: results.filter((result) => result.outcome === "FAILED")
      .length,
    results,
  };
}
