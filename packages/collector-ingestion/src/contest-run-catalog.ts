import type { DatabaseDateTime, DatabaseId } from "@araucaria/database";
import type {
  ContestRunCategoryFetchError,
  ContestRunDiscoveredContest,
  ContestRunDiscoveryResult,
} from "@araucaria/source-adapters";
import {
  ContestRunDiscoveryError,
  ContestRunHttpError,
} from "@araucaria/source-adapters";
import type {
  AdvisoryLockSession,
  AdvisoryLockSessionProvider,
} from "./polling.js";
import { normalizePollingEnvironment } from "./polling.js";

const MAX_LOCK_NAME_LENGTH = 64;
const DEFAULT_MAX_CONTESTS = 20;
const MAX_CONTESTS = 100;

export interface ContestRunCatalogDiscovery {
  discover(options: {
    continueOnCategoryError: true;
    maxCategoryRequests?: number;
    month?: number;
  }): Promise<ContestRunDiscoveryResult>;
}

export interface ContestRunCatalogSource {
  code: string;
  id: DatabaseId;
}

export interface CatalogPersistenceInput {
  contest: ContestRunDiscoveredContest;
  observedAt: DatabaseDateTime;
  source: ContestRunCatalogSource;
}

export interface CatalogPersistenceResult {
  contestCreated: boolean;
  contestExternalIdCreated: boolean;
  contestId: DatabaseId;
  mappingCreated: boolean;
}

export interface ContestRunCatalogRepository {
  findSourceByCode(code: string): Promise<ContestRunCatalogSource | undefined>;
  finishDiscoveryRun(input: DiscoveryRunFinish): Promise<void>;
  startDiscoveryRun(input: DiscoveryRunStart): Promise<DatabaseId>;
  syncDiscoveredContest(
    input: CatalogPersistenceInput,
  ): Promise<CatalogPersistenceResult>;
}

export interface DiscoveryRunStart {
  advisoryLockName: string;
  environment: string;
  observedAt: DatabaseDateTime;
  sourceId: DatabaseId;
}

export interface DiscoveryRunFinish {
  errorCode: string | null;
  finishedAt: DatabaseDateTime;
  requestCount: number;
  runId: DatabaseId;
  sourceId: DatabaseId;
}

export interface CatalogSyncClock {
  now(): DatabaseDateTime;
}

export interface ContestRunCatalogSyncOptions {
  environment: string;
  maxCategoryRequests?: number;
  maxContests?: number;
  month?: number;
  observedAt?: DatabaseDateTime;
  sourceCode?: string;
}

export type ContestRunCatalogSyncOutcome =
  | "SUCCESS"
  | "LOCKED_BY_OTHER"
  | "INVALID_SOURCE_CONFIGURATION"
  | "FAILED";

export interface ContestRunCatalogSyncResult {
  advisoryLockName: string | null;
  categoryErrors: readonly ContestRunCategoryFetchError[];
  contestsCreated: number;
  contestsReused: number;
  errorCode: string | null;
  externalIdsCreated: number;
  mappingsCreated: number;
  mappingsReused: number;
  outcome: ContestRunCatalogSyncOutcome;
  receivedMessageCount: 0;
  requestCount: number;
  runId: DatabaseId | null;
  sourceId: DatabaseId | null;
}

/**
 * A bounded source-catalog synchronization. It makes no activity or calendar
 * inference: contest.run testid is the only identity it assigns.
 */
export class ContestRunCatalogSyncService {
  constructor(
    private readonly repository: ContestRunCatalogRepository,
    private readonly locks: AdvisoryLockSessionProvider,
    private readonly discovery: ContestRunCatalogDiscovery,
    private readonly clock: CatalogSyncClock = { now: systemUtcClock },
  ) {}

  async sync(
    options: ContestRunCatalogSyncOptions,
  ): Promise<ContestRunCatalogSyncResult> {
    const environment = normalizePollingEnvironment(options.environment);
    const sourceCode = options.sourceCode ?? "CONTEST_RUN";
    const maximum = validateMaxContests(options.maxContests);
    const observedAt = options.observedAt ?? this.clock.now();
    let source: ContestRunCatalogSource | undefined;
    try {
      source = await this.repository.findSourceByCode(sourceCode);
    } catch {
      return failedWithoutSource("DISCOVERY_PERSISTENCE_ERROR");
    }
    if (!source) return invalidSourceConfigurationResult();

    const lockName = contestRunDiscoveryLockName(environment, source.id);
    let session: AdvisoryLockSession | undefined;
    let ownsLock = false;
    let runId: DatabaseId | undefined;
    let successful: ContestRunCatalogSyncResult | undefined;
    let failure: ContestRunCatalogSyncResult | undefined;
    const counters = emptyCounters();
    let categoryErrors: readonly ContestRunCategoryFetchError[] = [];
    let requestCount = 0;

    try {
      session = await this.locks.open();
      ownsLock = await session.tryAcquire(lockName);
      if (!ownsLock) return lockedResult(lockName, source.id);

      runId = await this.repository.startDiscoveryRun({
        sourceId: source.id,
        environment,
        advisoryLockName: lockName,
        observedAt,
      });
      const discovery = await this.discovery.discover({
        continueOnCategoryError: true,
        ...(options.month === undefined ? {} : { month: options.month }),
        ...(options.maxCategoryRequests === undefined
          ? {}
          : { maxCategoryRequests: options.maxCategoryRequests }),
      });
      requestCount = discovery.requestCount;
      categoryErrors = discovery.categoryErrors;
      let persistenceFailed = false;
      for (const contest of discovery.contests.slice(0, maximum)) {
        try {
          const persisted = await this.repository.syncDiscoveredContest({
            source,
            contest,
            observedAt,
          });
          incrementCounters(counters, persisted);
        } catch {
          persistenceFailed = true;
        }
      }
      const errorCode = persistenceFailed
        ? "DISCOVERY_PERSISTENCE_ERROR"
        : null;
      await this.repository.finishDiscoveryRun({
        runId,
        sourceId: source.id,
        requestCount,
        errorCode,
        finishedAt: this.clock.now(),
      });
      const result: ContestRunCatalogSyncResult = {
        ...counters,
        outcome: errorCode ? "FAILED" : "SUCCESS",
        errorCode,
        requestCount,
        categoryErrors,
        runId,
        sourceId: source.id,
        advisoryLockName: lockName,
        receivedMessageCount: 0,
      };
      if (errorCode) failure = result;
      else successful = result;
    } catch (error) {
      const errorCode = discoveryErrorCode(error);
      requestCount = requestCountFromError(error) || requestCount;
      if (runId) {
        try {
          await this.repository.finishDiscoveryRun({
            runId,
            sourceId: source.id,
            requestCount,
            errorCode,
            finishedAt: this.clock.now(),
          });
        } catch {
          failure = failedResult(
            lockName,
            source.id,
            runId,
            "DISCOVERY_PERSISTENCE_ERROR",
            requestCount,
            counters,
            categoryErrors,
          );
        }
      }
      failure ??= failedResult(
        lockName,
        source.id,
        runId ?? null,
        errorCode,
        requestCount,
        counters,
        categoryErrors,
      );
    } finally {
      const lockReleased = await releaseAndClose(session, lockName, ownsLock);
      if (!lockReleased && successful) {
        failure = failedResult(
          lockName,
          source.id,
          runId ?? null,
          "DISCOVERY_LOCK_RELEASE_ANOMALY",
          successful.requestCount,
          counters,
          categoryErrors,
        );
      }
    }
    return (
      failure ??
      successful ??
      failedResult(
        lockName,
        source.id,
        runId ?? null,
        "DISCOVERY_ERROR",
        requestCount,
        counters,
        categoryErrors,
      )
    );
  }
}

export function contestRunDiscoveryLockName(
  environment: string,
  sourceId: DatabaseId,
): string {
  const normalizedEnvironment = normalizePollingEnvironment(environment);
  if (!/^\d+$/.test(sourceId)) {
    throw new Error("Source ID must be an unsigned integer.");
  }
  const lockName = `als:${normalizedEnvironment}:source:${sourceId}:discovery`;
  if (lockName.length > MAX_LOCK_NAME_LENGTH) {
    throw new Error(
      "Discovery advisory lock name exceeds the MySQL 5.7 limit.",
    );
  }
  return lockName;
}

function validateMaxContests(value: number | undefined): number {
  if (value === undefined) return DEFAULT_MAX_CONTESTS;
  if (!Number.isSafeInteger(value) || value < 1 || value > MAX_CONTESTS) {
    throw new Error(
      `maxContests must be an integer from 1 to ${MAX_CONTESTS}.`,
    );
  }
  return value;
}

function emptyCounters(): Pick<
  ContestRunCatalogSyncResult,
  | "contestsCreated"
  | "contestsReused"
  | "externalIdsCreated"
  | "mappingsCreated"
  | "mappingsReused"
> {
  return {
    contestsCreated: 0,
    contestsReused: 0,
    externalIdsCreated: 0,
    mappingsCreated: 0,
    mappingsReused: 0,
  };
}

function incrementCounters(
  counters: ReturnType<typeof emptyCounters>,
  persisted: CatalogPersistenceResult,
): void {
  if (persisted.contestCreated) counters.contestsCreated += 1;
  else counters.contestsReused += 1;
  if (persisted.contestExternalIdCreated) counters.externalIdsCreated += 1;
  if (persisted.mappingCreated) counters.mappingsCreated += 1;
  else counters.mappingsReused += 1;
}

function invalidSourceConfigurationResult(): ContestRunCatalogSyncResult {
  return {
    ...emptyCounters(),
    outcome: "INVALID_SOURCE_CONFIGURATION",
    errorCode: "INVALID_SOURCE_CONFIGURATION",
    sourceId: null,
    runId: null,
    advisoryLockName: null,
    requestCount: 0,
    receivedMessageCount: 0,
    categoryErrors: [],
  };
}

function lockedResult(
  lockName: string,
  sourceId: DatabaseId,
): ContestRunCatalogSyncResult {
  return {
    ...emptyCounters(),
    outcome: "LOCKED_BY_OTHER",
    errorCode: "DISCOVERY_LOCKED_BY_OTHER",
    sourceId,
    runId: null,
    advisoryLockName: lockName,
    requestCount: 0,
    receivedMessageCount: 0,
    categoryErrors: [],
  };
}

function failedResult(
  lockName: string,
  sourceId: DatabaseId,
  runId: DatabaseId | null,
  errorCode: string,
  requestCount: number,
  counters = emptyCounters(),
  categoryErrors: readonly ContestRunCategoryFetchError[] = [],
): ContestRunCatalogSyncResult {
  return {
    ...counters,
    outcome: "FAILED",
    errorCode,
    sourceId,
    runId,
    advisoryLockName: lockName,
    requestCount,
    receivedMessageCount: 0,
    categoryErrors,
  };
}

function failedWithoutSource(errorCode: string): ContestRunCatalogSyncResult {
  return {
    ...emptyCounters(),
    outcome: "FAILED",
    errorCode,
    sourceId: null,
    runId: null,
    advisoryLockName: null,
    requestCount: 0,
    receivedMessageCount: 0,
    categoryErrors: [],
  };
}

function discoveryErrorCode(error: unknown): string {
  const root = error instanceof ContestRunDiscoveryError ? error.cause : error;
  if (root instanceof ContestRunHttpError) {
    return root.code === "ADAPTER_PARSE"
      ? "DISCOVERY_PARSE_ERROR"
      : "DISCOVERY_HTTP_ERROR";
  }
  return "DISCOVERY_PERSISTENCE_ERROR";
}

function requestCountFromError(error: unknown): number {
  return error instanceof ContestRunDiscoveryError ? error.requestCount : 0;
}

async function releaseAndClose(
  session: AdvisoryLockSession | undefined,
  lockName: string,
  ownsLock: boolean,
): Promise<boolean> {
  if (!session) return false;
  let released = true;
  if (ownsLock) {
    try {
      released = await session.release(lockName);
    } catch {
      released = false;
    }
  }
  try {
    await session.close();
  } catch {
    released = false;
  }
  return released;
}

function systemUtcClock(): DatabaseDateTime {
  const value = new Date();
  const part = (number: number, width = 2) =>
    String(number).padStart(width, "0");
  return `${part(value.getUTCFullYear(), 4)}-${part(value.getUTCMonth() + 1)}-${part(value.getUTCDate())} ${part(value.getUTCHours())}:${part(value.getUTCMinutes())}:${part(value.getUTCSeconds())}.${part(value.getUTCMilliseconds(), 3)}000`;
}
