import type { DatabaseDateTime } from "@araucaria/database";
import type { PollingCycleResult } from "./polling.js";
import { normalizePollingEnvironment } from "./polling.js";
import type {
  CollectorRunRecoveryService,
  CollectorRunRecoverySummary,
} from "./recovery.js";
import { systemUtcDateTime } from "./runtime-time.js";

export interface PollingCycleRunner {
  runCycle(options: {
    environment: string;
    maxMappingsPerCycle?: number;
  }): Promise<PollingCycleResult>;
}

export interface RuntimeClock {
  now(): DatabaseDateTime;
}

export interface RuntimeSleeper {
  sleep(milliseconds: number, signal?: AbortSignal): Promise<void>;
}

export type CollectorRuntimeEventType =
  | "RUNTIME_STARTED"
  | "RECOVERY_STARTED"
  | "RECOVERY_RUN_RECOVERED"
  | "RECOVERY_RUN_SKIPPED_ACTIVE_LOCK"
  | "RECOVERY_COMPLETED"
  | "RECOVERY_FAILED"
  | "CYCLE_STARTED"
  | "CYCLE_COMPLETED"
  | "RUNTIME_CYCLE_FAILED"
  | "SHUTDOWN_REQUESTED"
  | "RUNTIME_STOPPED";

export interface CollectorRuntimeEvent {
  at?: DatabaseDateTime;
  cycleSequence?: number;
  durationMs?: number;
  environment: string;
  errorCode?: string;
  mappingId?: string;
  runId?: string;
  type: CollectorRuntimeEventType;
  value?: number;
}

export interface CollectorRuntimeEventSink {
  emit(event: CollectorRuntimeEvent): void | Promise<void>;
}

export interface CollectorRuntimeOptions {
  cycleIntervalMs: number;
  environment: string;
  maxMappingsPerCycle?: number;
  maxRecoveryRuns?: number;
  maximumRuntimeFailureBackoffMs?: number;
  runtimeFailureBackoffMs: number;
  signal?: AbortSignal;
  staleRunThresholdMs: number;
}

export interface CollectorRuntimeResult {
  cyclesCompleted: number;
  cyclesStarted: number;
  recovery: CollectorRunRecoverySummary | null;
  stoppedBySignal: boolean;
}

/**
 * Sequential process lifecycle around the bounded polling service. It keeps
 * polling policy separate from process signals, timers, and observability.
 */
export class CollectorRuntimeService {
  constructor(
    private readonly polling: PollingCycleRunner,
    private readonly recovery: Pick<CollectorRunRecoveryService, "recover">,
    private readonly clock: RuntimeClock = { now: systemUtcDateTime },
    private readonly sleeper: RuntimeSleeper = { sleep: abortableSleep },
    private readonly events: CollectorRuntimeEventSink = { emit: () => {} },
  ) {}

  async run(options: CollectorRuntimeOptions): Promise<CollectorRuntimeResult> {
    const config = validateRuntimeOptions(options);
    let cyclesStarted = 0;
    let cyclesCompleted = 0;
    let failureBackoffMs = config.runtimeFailureBackoffMs;
    let recovery: CollectorRunRecoverySummary | null = null;
    let recoveryComplete = false;
    await this.emit({
      type: "RUNTIME_STARTED",
      environment: config.environment,
    });

    while (!config.signal?.aborted) {
      if (!recoveryComplete) {
        try {
          await this.emit({
            type: "RECOVERY_STARTED",
            environment: config.environment,
          });
          recovery = await this.recovery.recover({
            environment: config.environment,
            staleRunThresholdMs: config.staleRunThresholdMs,
            ...(config.maxRecoveryRuns === undefined
              ? {}
              : { maxRecoveryRuns: config.maxRecoveryRuns }),
          });
          await this.emitRecoveryEvents(config.environment, recovery);
          await this.emit({
            type: "RECOVERY_COMPLETED",
            environment: config.environment,
            value: recovery.candidates,
          });
          recoveryComplete = true;
          failureBackoffMs = config.runtimeFailureBackoffMs;
        } catch {
          await this.emit({
            type: "RECOVERY_FAILED",
            environment: config.environment,
            errorCode: "RECOVERY_ERROR",
          });
          await this.sleep(failureBackoffMs, config.signal);
          failureBackoffMs = nextFailureBackoff(failureBackoffMs, config);
          continue;
        }
      }
      if (config.signal?.aborted) break;

      const cycleSequence = ++cyclesStarted;
      const startedAt = Date.now();
      await this.emit({
        type: "CYCLE_STARTED",
        environment: config.environment,
        cycleSequence,
      });
      try {
        const result = await this.polling.runCycle({
          environment: config.environment,
          ...(config.maxMappingsPerCycle === undefined
            ? {}
            : { maxMappingsPerCycle: config.maxMappingsPerCycle }),
        });
        cyclesCompleted += 1;
        failureBackoffMs = config.runtimeFailureBackoffMs;
        await this.emit({
          type: "CYCLE_COMPLETED",
          environment: config.environment,
          cycleSequence,
          durationMs: Math.max(0, Date.now() - startedAt),
          value: result.mappingsConsidered,
        });
        if (config.signal?.aborted) break;
        await this.sleep(config.cycleIntervalMs, config.signal);
      } catch {
        await this.emit({
          type: "RUNTIME_CYCLE_FAILED",
          environment: config.environment,
          cycleSequence,
          errorCode: "RUNTIME_CYCLE_FAILED",
        });
        await this.sleep(failureBackoffMs, config.signal);
        failureBackoffMs = nextFailureBackoff(failureBackoffMs, config);
      }
    }

    const stoppedBySignal = config.signal?.aborted ?? false;
    if (stoppedBySignal) {
      await this.emit({
        type: "SHUTDOWN_REQUESTED",
        environment: config.environment,
      });
    }
    await this.emit({
      type: "RUNTIME_STOPPED",
      environment: config.environment,
    });
    return { cyclesStarted, cyclesCompleted, recovery, stoppedBySignal };
  }

  private async emitRecoveryEvents(
    environment: string,
    summary: CollectorRunRecoverySummary,
  ): Promise<void> {
    for (const result of summary.results) {
      if (result.outcome === "ACTIVE_LOCK_HELD") {
        await this.emit({
          type: "RECOVERY_RUN_SKIPPED_ACTIVE_LOCK",
          environment,
          runId: result.runId,
          ...(result.mappingId === null ? {} : { mappingId: result.mappingId }),
        });
      } else if (
        result.outcome === "RECOVERED" ||
        result.outcome === "RECOVERED_DISABLED_MAPPING" ||
        result.outcome === "RECOVERED_INVALID_MAPPING_INTERVAL" ||
        result.outcome === "RECOVERED_WITHOUT_MAPPING"
      ) {
        await this.emit({
          type: "RECOVERY_RUN_RECOVERED",
          environment,
          runId: result.runId,
          ...(result.mappingId === null ? {} : { mappingId: result.mappingId }),
          ...(result.errorCode === null ? {} : { errorCode: result.errorCode }),
        });
      }
    }
  }

  private async emit(event: CollectorRuntimeEvent): Promise<void> {
    await this.events.emit({ ...event, at: this.clock.now() });
  }

  private async sleep(
    milliseconds: number,
    signal?: AbortSignal,
  ): Promise<void> {
    try {
      await this.sleeper.sleep(milliseconds, signal);
    } catch {
      if (!signal?.aborted) throw new Error("Runtime sleeper failed.");
    }
  }
}

export function abortableSleep(
  milliseconds: number,
  signal?: AbortSignal,
): Promise<void> {
  if (signal?.aborted) return Promise.resolve();
  return new Promise<void>((resolve) => {
    const timeout = setTimeout(finish, milliseconds);
    function finish(): void {
      clearTimeout(timeout);
      signal?.removeEventListener("abort", finish);
      resolve();
    }
    signal?.addEventListener("abort", finish, { once: true });
  });
}

function validateRuntimeOptions(
  options: CollectorRuntimeOptions,
): CollectorRuntimeOptions {
  const environment = normalizePollingEnvironment(options.environment);
  validateMilliseconds(
    "cycleIntervalMs",
    options.cycleIntervalMs,
    100,
    3_600_000,
  );
  validateMilliseconds(
    "staleRunThresholdMs",
    options.staleRunThresholdMs,
    1_000,
    30 * 24 * 3_600_000,
  );
  validateMilliseconds(
    "runtimeFailureBackoffMs",
    options.runtimeFailureBackoffMs,
    100,
    3_600_000,
  );
  const maximumRuntimeFailureBackoffMs =
    options.maximumRuntimeFailureBackoffMs ?? options.runtimeFailureBackoffMs;
  validateMilliseconds(
    "maximumRuntimeFailureBackoffMs",
    maximumRuntimeFailureBackoffMs,
    options.runtimeFailureBackoffMs,
    3_600_000,
  );
  if (
    options.maxMappingsPerCycle !== undefined &&
    (!Number.isSafeInteger(options.maxMappingsPerCycle) ||
      options.maxMappingsPerCycle < 1 ||
      options.maxMappingsPerCycle > 100)
  ) {
    throw new Error("maxMappingsPerCycle must be an integer from 1 to 100.");
  }
  if (
    options.maxRecoveryRuns !== undefined &&
    (!Number.isSafeInteger(options.maxRecoveryRuns) ||
      options.maxRecoveryRuns < 1 ||
      options.maxRecoveryRuns > 100)
  ) {
    throw new Error("maxRecoveryRuns must be an integer from 1 to 100.");
  }
  return { ...options, environment, maximumRuntimeFailureBackoffMs };
}

function validateMilliseconds(
  name: string,
  value: number,
  minimum: number,
  maximum: number,
): void {
  if (!Number.isSafeInteger(value) || value < minimum || value > maximum) {
    throw new Error(
      `${name} must be an integer from ${minimum} to ${maximum}.`,
    );
  }
}

function nextFailureBackoff(
  current: number,
  options: CollectorRuntimeOptions,
): number {
  return Math.min(
    current * 2,
    options.maximumRuntimeFailureBackoffMs ?? current,
  );
}
