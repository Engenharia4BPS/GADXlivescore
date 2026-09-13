import type {
  ContestRunDisplayScoreResponse,
  ContestRunHttpResponse,
  ContestRunHttpResponseMetadata,
} from "@araucaria/source-adapters";
import { isContestRunTestId } from "@araucaria/source-adapters";
import { normalizeContestRunDisplayScoreResponse } from "./contest-run.js";
import type {
  BatchParseResult,
  NormalizedScoreObservation,
  RedactedReceipt,
} from "./types.js";

const defaultMaximumContests = 2;
const maximumSampleObservations = 3;

export interface ContestRunDisplayScoreClient {
  displayScore(
    testId: number,
  ): Promise<ContestRunHttpResponse<ContestRunDisplayScoreResponse>>;
}

export interface ContestRunDisplayScoreSummaryOptions {
  maxContests?: number;
}

export interface ContestRunDisplayScoreSummary {
  testId: number;
  http: ContestRunHttpResponseMetadata;
  sourceRowCount: number;
  /** Successfully normalized rows; this read-only path has no DB acceptance. */
  acceptedObservationCount: number;
  rejectedObservationCount: number;
  datePresentCount: number;
  unzonedSourceTextCount: number;
  resetLikeEvidence: {
    comparisonPerformed: false;
    observedCount: 0;
  };
  aggregateBandDisagreementCount: number;
  softObservedTypes: readonly ("number" | "string")[];
  unresolvedMetricPresence: {
    qtotalc: number;
    qtotalp: number;
    qtotalr: number;
  };
  authRedactionVerified: boolean;
  sample: readonly ContestRunDisplayScoreSample[];
}

export interface ContestRunDisplayScoreSample {
  callsign: string;
  score: string | null;
  qsoTotal: string | null;
  pointsTotal: string | null;
  multTotal: string | null;
}

export interface ContestRunDisplayScoreProbeResult {
  scoreRequests: number;
  summaries: readonly ContestRunDisplayScoreSummary[];
}

/**
 * Read-only source validation helper. It never persists a receipt or
 * observation: the receipt context exists solely to exercise the established
 * collector normalizer after the source adapter has parsed and redacted bytes.
 */
export class ContestRunDisplayScoreReadOnlyService {
  constructor(private readonly client: ContestRunDisplayScoreClient) {}

  async summarize(
    testIds: readonly number[],
    options: ContestRunDisplayScoreSummaryOptions = {},
  ): Promise<ContestRunDisplayScoreProbeResult> {
    const maximumContests = options.maxContests ?? defaultMaximumContests;
    validateInputs(testIds, maximumContests);
    const selectedTestIds = [...new Set(testIds)].slice(0, maximumContests);
    const summaries: ContestRunDisplayScoreSummary[] = [];

    for (const testId of selectedTestIds) {
      const response = await this.client.displayScore(testId);
      const normalized = normalizeContestRunDisplayScoreResponse(
        response.data,
        readOnlyReceipt(testId, response.metadata),
      );
      summaries.push(summarizeResponse(testId, response, normalized));
    }

    return { scoreRequests: summaries.length, summaries };
  }
}

function summarizeResponse(
  testId: number,
  response: ContestRunHttpResponse<ContestRunDisplayScoreResponse>,
  normalized: BatchParseResult,
): ContestRunDisplayScoreSummary {
  const observations = normalized.observations;
  const softObservedTypes = [
    ...new Set(
      response.data.records.flatMap((record) =>
        typeof record.soft === "string" || typeof record.soft === "number"
          ? [typeof record.soft]
          : [],
      ),
    ),
  ].sort() as ("number" | "string")[];
  const containsAuth =
    containsAuthKey(response.data.records) ||
    observations.some((observation) => containsAuthKey(observation.rawMetrics));
  const diagnosticsSafe = normalized.rejected.every(
    (rejected) =>
      Object.keys(rejected).every(
        (key) => key === "index" || key === "error",
      ) && !rejected.error.toLowerCase().includes("auth"),
  );

  return {
    testId,
    http: response.metadata,
    sourceRowCount: response.data.records.length,
    acceptedObservationCount: observations.length,
    rejectedObservationCount: normalized.rejected.length,
    datePresentCount: observations.filter(
      (observation) => observation.sourceTimestampRaw !== null,
    ).length,
    unzonedSourceTextCount: observations.filter(
      (observation) =>
        observation.sourceTimestamp === null &&
        observation.sourceTimestampQuality === "UNZONED_SOURCE_TEXT",
    ).length,
    resetLikeEvidence: { comparisonPerformed: false, observedCount: 0 },
    aggregateBandDisagreementCount: observations.filter(aggregateBandDisagrees)
      .length,
    softObservedTypes,
    unresolvedMetricPresence: {
      qtotalc: countPresent(response.data.records, "qtotalc"),
      qtotalp: countPresent(response.data.records, "qtotalp"),
      qtotalr: countPresent(response.data.records, "qtotalr"),
    },
    authRedactionVerified: !containsAuth && diagnosticsSafe,
    sample: observations
      .slice(0, maximumSampleObservations)
      .map((observation) => ({
        callsign: observation.displayCallsign,
        score: observation.score,
        qsoTotal: observation.qsoTotal,
        pointsTotal: observation.pointsTotal,
        multTotal: observation.multTotal,
      })),
  };
}

function readOnlyReceipt(
  testId: number,
  metadata: ContestRunHttpResponseMetadata,
): RedactedReceipt {
  return {
    sourceId: "read-only-contest-run",
    contestId: `read-only-contest.run-${testId}`,
    receivedAt: "1970-01-01 00:00:00.000000",
    messageKind: "HTTP_RESPONSE",
    payload: new Uint8Array(),
    payloadRedacted: new Uint8Array(),
    payloadSha256: new Uint8Array(),
    redactionMetadata: null,
    requestPathRedacted: `/api/displayscore/${testId}`,
    responseHeadersRedacted: null,
    request: {
      method: "GET",
      path: `/api/displayscore/${testId}`,
      responseStatus: metadata.status,
      contentType: "application/json",
    },
  };
}

function aggregateBandDisagrees(
  observation: NormalizedScoreObservation,
): boolean {
  return (
    aggregateDiffers(
      observation.qsoTotal,
      observation.bands.map((band) => band.qso),
    ) ||
    aggregateDiffers(
      observation.pointsTotal,
      observation.bands.map((band) => band.points),
    ) ||
    aggregateDiffers(
      observation.multTotal,
      observation.bands.map((band) => band.mult1),
    )
  );
}

function aggregateDiffers(
  aggregate: string | null,
  values: readonly (string | null)[],
): boolean {
  const presentValues = values.filter(
    (value): value is string => value !== null,
  );
  if (aggregate === null || presentValues.length === 0) return false;
  return (
    BigInt(aggregate) !==
    presentValues.reduce((total, value) => total + BigInt(value), 0n)
  );
}

function countPresent(
  records: ContestRunDisplayScoreResponse["records"],
  field: "qtotalc" | "qtotalp" | "qtotalr",
): number {
  return records.filter(
    (record) => record[field] !== undefined && record[field] !== null,
  ).length;
}

function containsAuthKey(value: unknown): boolean {
  if (Array.isArray(value)) return value.some(containsAuthKey);
  if (value === null || typeof value !== "object") return false;
  return Object.entries(value).some(
    ([key, nested]) => key.toLowerCase() === "auth" || containsAuthKey(nested),
  );
}

function validateInputs(
  testIds: readonly number[],
  maximumContests: number,
): void {
  if (!Number.isSafeInteger(maximumContests) || maximumContests < 1) {
    throw new Error("contest.run maxContests must be a positive safe integer.");
  }
  if (testIds.length === 0) {
    throw new Error("contest.run displayscore requires at least one testid.");
  }
  if (!testIds.every(isContestRunTestId)) {
    throw new Error(
      "contest.run displayscore testids must be positive 32-bit integers.",
    );
  }
}
