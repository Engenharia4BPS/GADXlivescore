import assert from "node:assert/strict";
import test from "node:test";
import type { PollingCycleResult } from "../src/polling.js";
import type {
  CollectorRunRecoveryOptions,
  CollectorRunRecoverySummary,
} from "../src/recovery.js";
import {
  type CollectorRuntimeEvent,
  CollectorRuntimeService,
  type PollingCycleRunner,
  type RuntimeSleeper,
} from "../src/runtime.js";

const now = "2026-09-13 12:00:00.000000";

test("runtime executes cycles sequentially and starts the next only after sleep", async () => {
  const controller = new AbortController();
  const runner = new SequentialRunner();
  const sleeper = new CountingSleeper((call) => {
    if (call === 2) controller.abort();
  });
  const result = await runtime(runner, sleeper).run(options(controller));

  assert.equal(result.cyclesStarted, 2);
  assert.equal(result.cyclesCompleted, 2);
  assert.equal(runner.maxActive, 1);
  assert.equal(sleeper.calls.length, 2);
});

test("runtime shutdown during sleep interrupts waiting and starts no further cycle", async () => {
  const controller = new AbortController();
  const runner = new SuccessfulRunner();
  const sleeper = new BlockingSleeper();
  const execution = runtime(runner, sleeper).run(options(controller));
  await sleeper.started;
  controller.abort();
  await execution;

  assert.equal(runner.calls, 1);
  assert.equal(sleeper.calls.length, 1);
});

test("runtime shutdown allows an active cycle to finish without another cycle", async () => {
  const controller = new AbortController();
  const runner = new GatedRunner();
  const sleeper = new CountingSleeper();
  const execution = runtime(runner, sleeper).run(options(controller));
  await runner.started;
  controller.abort();
  assert.equal(sleeper.calls.length, 0);
  runner.complete();
  const result = await execution;

  assert.equal(result.cyclesCompleted, 1);
  assert.equal(runner.calls, 1);
  assert.equal(sleeper.calls.length, 0);
});

test("a mapping-level FAILED result completes the runtime cycle", async () => {
  const controller = new AbortController();
  const events: CollectorRuntimeEvent[] = [];
  const runner: PollingCycleRunner = {
    async runCycle() {
      return cycle({ mappingsFailed: 1 });
    },
  };
  const sleeper = new CountingSleeper(() => controller.abort());
  const result = await runtime(runner, sleeper, events).run(
    options(controller),
  );

  assert.equal(result.cyclesCompleted, 1);
  assert(events.some((event) => event.type === "CYCLE_COMPLETED"));
  assert(!events.some((event) => event.type === "RUNTIME_CYCLE_FAILED"));
});

test("top-level cycle failures emit a sanitized event, back off, and continue", async () => {
  const controller = new AbortController();
  const events: CollectorRuntimeEvent[] = [];
  const runner = new FlakyRunner();
  const sleeper = new CountingSleeper((call) => {
    if (call === 2) controller.abort();
  });
  const result = await runtime(runner, sleeper, events).run({
    ...options(controller),
    cycleIntervalMs: 456,
    runtimeFailureBackoffMs: 123,
    maximumRuntimeFailureBackoffMs: 246,
  });

  assert.equal(result.cyclesStarted, 2);
  assert.equal(result.cyclesCompleted, 1);
  assert.deepEqual(sleeper.calls, [123, 456]);
  const failure = events.find((event) => event.type === "RUNTIME_CYCLE_FAILED");
  assert.deepEqual(failure?.errorCode, "RUNTIME_CYCLE_FAILED");
  assert(!JSON.stringify(events).includes("sensitive-internal-detail"));
});

test("runtime always recovers before polling and emits structured lifecycle events", async () => {
  const controller = new AbortController();
  const events: CollectorRuntimeEvent[] = [];
  const order: string[] = [];
  const recovery = {
    async recover(_options: CollectorRunRecoveryOptions) {
      order.push("recovery");
      return summary({ candidates: 1, recoveredCount: 1 });
    },
  };
  const runner: PollingCycleRunner = {
    async runCycle() {
      order.push("cycle");
      return cycle();
    },
  };
  const sleeper = new CountingSleeper(() => controller.abort());
  const service = new CollectorRuntimeService(
    runner,
    recovery,
    { now: () => now },
    sleeper,
    { emit: (event) => void events.push(event) },
  );
  await service.run(options(controller));

  assert.deepEqual(order, ["recovery", "cycle"]);
  assert(events.some((event) => event.type === "RUNTIME_STARTED"));
  assert(events.some((event) => event.type === "RECOVERY_STARTED"));
  assert(events.some((event) => event.type === "RECOVERY_COMPLETED"));
  assert(events.some((event) => event.type === "SHUTDOWN_REQUESTED"));
  assert(events.some((event) => event.type === "RUNTIME_STOPPED"));
});

function runtime(
  runner: PollingCycleRunner,
  sleeper: RuntimeSleeper,
  events: CollectorRuntimeEvent[] = [],
): CollectorRuntimeService {
  return new CollectorRuntimeService(
    runner,
    { recover: async () => summary() },
    { now: () => now },
    sleeper,
    { emit: (event) => void events.push(event) },
  );
}

function options(controller: AbortController) {
  return {
    environment: "test",
    signal: controller.signal,
    cycleIntervalMs: 100,
    maxMappingsPerCycle: 1,
    staleRunThresholdMs: 1_000,
    runtimeFailureBackoffMs: 100,
  };
}

function cycle(
  overrides: Partial<PollingCycleResult> = {},
): PollingCycleResult {
  return {
    mappingsConsidered: 0,
    mappingsSucceeded: 0,
    mappingsLockedByOther: 0,
    mappingsInvalid: 0,
    mappingsFailed: 0,
    results: [],
    ...overrides,
  };
}

function summary(
  overrides: Partial<CollectorRunRecoverySummary> = {},
): CollectorRunRecoverySummary {
  return {
    candidates: 0,
    recoveredCount: 0,
    activeLockSkippedCount: 0,
    failedCount: 0,
    results: [],
    ...overrides,
  };
}

class SuccessfulRunner implements PollingCycleRunner {
  calls = 0;
  async runCycle(): Promise<PollingCycleResult> {
    this.calls += 1;
    return cycle();
  }
}

class SequentialRunner implements PollingCycleRunner {
  active = 0;
  maxActive = 0;
  async runCycle(): Promise<PollingCycleResult> {
    this.active += 1;
    this.maxActive = Math.max(this.maxActive, this.active);
    await Promise.resolve();
    this.active -= 1;
    return cycle();
  }
}

class GatedRunner implements PollingCycleRunner {
  calls = 0;
  private allow: (() => void) | undefined;
  private startedResolve: (() => void) | undefined;
  readonly started = new Promise<void>((resolve) => {
    this.startedResolve = resolve;
  });
  private readonly completeCycle = new Promise<void>((resolve) => {
    this.allow = resolve;
  });

  async runCycle(): Promise<PollingCycleResult> {
    this.calls += 1;
    this.startedResolve?.();
    await this.completeCycle;
    return cycle();
  }

  complete(): void {
    this.allow?.();
  }
}

class FlakyRunner implements PollingCycleRunner {
  calls = 0;
  async runCycle(): Promise<PollingCycleResult> {
    this.calls += 1;
    if (this.calls === 1) throw new Error("sensitive-internal-detail");
    return cycle();
  }
}

class CountingSleeper implements RuntimeSleeper {
  readonly calls: number[] = [];
  constructor(
    private readonly onSleep: ((call: number) => void) | undefined = undefined,
  ) {}
  async sleep(milliseconds: number): Promise<void> {
    this.calls.push(milliseconds);
    this.onSleep?.(this.calls.length);
  }
}

class BlockingSleeper implements RuntimeSleeper {
  readonly calls: number[] = [];
  private startedResolve: (() => void) | undefined;
  readonly started = new Promise<void>((resolve) => {
    this.startedResolve = resolve;
  });

  async sleep(milliseconds: number, signal?: AbortSignal): Promise<void> {
    this.calls.push(milliseconds);
    this.startedResolve?.();
    if (signal?.aborted) return;
    await new Promise<void>((resolve) => {
      signal?.addEventListener("abort", () => resolve(), { once: true });
    });
  }
}
