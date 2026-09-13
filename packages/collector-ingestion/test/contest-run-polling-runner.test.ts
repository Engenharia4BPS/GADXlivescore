import assert from "node:assert/strict";
import test from "node:test";
import type { ContestRunDisplayScoreHttpResponse } from "@araucaria/source-adapters";
import {
  type CollectorIngestionService,
  type CollectorReceipt,
  type CollectorSourceContestMapping,
  type ContestRunPollingHttpClient,
  ContestRunPollingRunner,
  PollingSourceRunError,
} from "../src/index.js";

const mapping: CollectorSourceContestMapping = {
  id: "7",
  sourceId: "3",
  contestId: "5",
  contestExternalId: "91",
  enabled: 1,
  pollIntervalSeconds: 60,
  nextPollAt: null,
};

test("contest.run runner links one receipt for redacted persistence to its run and mapping", async () => {
  const received: CollectorReceipt[] = [];
  const ingestion = {
    ingest: async (receipt: CollectorReceipt) => {
      received.push(receipt);
      return {
        rawMessageId: "11",
        status: "PROCESSED" as const,
        observationCount: 5,
        acceptedCount: 5,
        duplicateCount: 0,
        rejectedCount: 0,
      };
    },
  } as unknown as CollectorIngestionService;
  const result = await new ContestRunPollingRunner(
    ingestion,
    new SuccessfulContestRunClient(),
  ).run({
    collectorRunId: "9",
    mapping,
    receivedAt: "2026-09-13 12:00:00.000000",
  });

  assert.deepEqual(result, { requestCount: 1, receivedMessageCount: 1 });
  assert.deepEqual(only(received), {
    sourceId: "3",
    contestId: "5",
    collectorSourceContestId: "7",
    collectorRunId: "9",
    receivedAt: "2026-09-13 12:00:00.000000",
    messageKind: "CONTEST_RUN_DISPLAYSCORE",
    payload: new TextEncoder().encode('[{"sign":"TEST"}]'),
    request: {
      method: "GET",
      path: "/api/displayscore/91",
      responseStatus: 200,
      contentType: "application/json",
    },
    metadata: {
      endpoint: "displayscore",
      test_id: 91,
      response_bytes: 17,
      duration_ms: 4,
    },
  });
});

test("contest.run runner reports durable failed receipts and invalid mappings safely", async () => {
  const failedIngestion = {
    ingest: async () => ({
      rawMessageId: "11",
      status: "FAILED" as const,
      observationCount: 0,
      acceptedCount: 0,
      duplicateCount: 0,
      rejectedCount: 0,
    }),
  } as unknown as CollectorIngestionService;
  const runner = new ContestRunPollingRunner(
    failedIngestion,
    new SuccessfulContestRunClient(),
  );
  await assert.rejects(
    runner.run({
      collectorRunId: "9",
      mapping,
      receivedAt: "2026-09-13 12:00:00.000000",
    }),
    (error: unknown) => {
      assert(error instanceof PollingSourceRunError);
      assert.equal(error.code, "INGESTION_FAILED");
      assert.equal(error.requestCount, 1);
      assert.equal(error.receivedMessageCount, 1);
      return true;
    },
  );
  assert.equal(
    runner.validateMapping({ ...mapping, contestExternalId: "not-a-testid" }),
    "INVALID_CONTEST_RUN_TEST_ID",
  );
});

class SuccessfulContestRunClient implements ContestRunPollingHttpClient {
  async displayScore(): Promise<ContestRunDisplayScoreHttpResponse> {
    return {
      data: { records: [{ sign: "TEST" }] },
      rawPayload: new TextEncoder().encode('[{"sign":"TEST"}]'),
      metadata: {
        endpoint: "displayscore",
        status: 200,
        durationMs: 4,
        responseBytes: 17,
      },
    };
  }
}

function only<T>(values: readonly T[]): T {
  const value = values[0];
  if (value === undefined) throw new Error("Expected one value.");
  return value;
}
