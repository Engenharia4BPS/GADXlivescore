import assert from "node:assert/strict";
import test from "node:test";
import { collectorRuntimeConfigFromEnvironment } from "../src/index.js";

test("runtime environment configuration normalizes environment and uses intentional defaults", () => {
  const config = collectorRuntimeConfigFromEnvironment({
    COLLECTOR_ENVIRONMENT: "Production",
  });

  assert.deepEqual(config, {
    environment: "production",
    cycleIntervalMs: 30_000,
    maxMappingsPerCycle: 10,
    maxRecoveryRuns: 50,
    staleRunThresholdMs: 900_000,
    runtimeFailureBackoffMs: 5_000,
    maximumRuntimeFailureBackoffMs: 60_000,
  });
});

test("runtime environment configuration rejects missing and malformed operational values", () => {
  assert.throws(() => collectorRuntimeConfigFromEnvironment({}));
  assert.throws(() =>
    collectorRuntimeConfigFromEnvironment({
      COLLECTOR_ENVIRONMENT: "test",
      COLLECTOR_CYCLE_INTERVAL_MS: "1.5",
    }),
  );
  assert.throws(() =>
    collectorRuntimeConfigFromEnvironment({
      COLLECTOR_ENVIRONMENT: "test",
      COLLECTOR_RUNTIME_FAILURE_BACKOFF_MS: "1000",
      COLLECTOR_MAX_RUNTIME_FAILURE_BACKOFF_MS: "999",
    }),
  );
});
