import { normalizePollingEnvironment } from "./polling.js";
import type { CollectorRuntimeOptions } from "./runtime.js";

export interface CollectorRuntimeEnvironmentConfig
  extends Omit<CollectorRuntimeOptions, "signal"> {}

const DEFAULT_CYCLE_INTERVAL_MS = 30_000;
const DEFAULT_MAX_MAPPINGS_PER_CYCLE = 10;
const DEFAULT_MAX_RECOVERY_RUNS = 50;
const DEFAULT_STALE_RUN_THRESHOLD_MS = 15 * 60_000;
const DEFAULT_RUNTIME_FAILURE_BACKOFF_MS = 5_000;
const DEFAULT_MAXIMUM_RUNTIME_FAILURE_BACKOFF_MS = 60_000;

/** Reads only non-secret collector operational configuration. */
export function collectorRuntimeConfigFromEnvironment(
  environment: NodeJS.ProcessEnv = process.env,
): CollectorRuntimeEnvironmentConfig {
  const collectorEnvironment = environment.COLLECTOR_ENVIRONMENT;
  if (!collectorEnvironment) {
    throw new Error("COLLECTOR_ENVIRONMENT must be configured.");
  }
  const runtimeFailureBackoffMs = parseInteger(
    environment.COLLECTOR_RUNTIME_FAILURE_BACKOFF_MS,
    "COLLECTOR_RUNTIME_FAILURE_BACKOFF_MS",
    DEFAULT_RUNTIME_FAILURE_BACKOFF_MS,
    100,
    3_600_000,
  );
  return {
    environment: normalizePollingEnvironment(collectorEnvironment),
    cycleIntervalMs: parseInteger(
      environment.COLLECTOR_CYCLE_INTERVAL_MS,
      "COLLECTOR_CYCLE_INTERVAL_MS",
      DEFAULT_CYCLE_INTERVAL_MS,
      100,
      3_600_000,
    ),
    maxMappingsPerCycle: parseInteger(
      environment.COLLECTOR_MAX_MAPPINGS_PER_CYCLE,
      "COLLECTOR_MAX_MAPPINGS_PER_CYCLE",
      DEFAULT_MAX_MAPPINGS_PER_CYCLE,
      1,
      100,
    ),
    maxRecoveryRuns: parseInteger(
      environment.COLLECTOR_MAX_RECOVERY_RUNS,
      "COLLECTOR_MAX_RECOVERY_RUNS",
      DEFAULT_MAX_RECOVERY_RUNS,
      1,
      100,
    ),
    staleRunThresholdMs: parseInteger(
      environment.COLLECTOR_STALE_RUN_THRESHOLD_MS,
      "COLLECTOR_STALE_RUN_THRESHOLD_MS",
      DEFAULT_STALE_RUN_THRESHOLD_MS,
      1_000,
      30 * 24 * 3_600_000,
    ),
    runtimeFailureBackoffMs,
    maximumRuntimeFailureBackoffMs: parseInteger(
      environment.COLLECTOR_MAX_RUNTIME_FAILURE_BACKOFF_MS,
      "COLLECTOR_MAX_RUNTIME_FAILURE_BACKOFF_MS",
      DEFAULT_MAXIMUM_RUNTIME_FAILURE_BACKOFF_MS,
      runtimeFailureBackoffMs,
      3_600_000,
    ),
  };
}

function parseInteger(
  value: string | undefined,
  name: string,
  fallback: number,
  minimum: number,
  maximum: number,
): number {
  if (value === undefined) return fallback;
  if (!/^(0|[1-9]\d*)$/.test(value)) {
    throw new Error(
      `${name} must be an integer from ${minimum} to ${maximum}.`,
    );
  }
  const parsed = Number(value);
  if (!Number.isSafeInteger(parsed) || parsed < minimum || parsed > maximum) {
    throw new Error(
      `${name} must be an integer from ${minimum} to ${maximum}.`,
    );
  }
  return parsed;
}
