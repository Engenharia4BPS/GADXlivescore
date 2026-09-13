import {
  type ContestRunDisplayScoreHttpResponse,
  ContestRunHttpClient,
  ContestRunHttpError,
  isContestRunTestId,
} from "@araucaria/source-adapters";
import { contestRunDisplayScorePayloadAdapter } from "./contest-run.js";
import {
  type CollectorSourceContestMapping,
  type PollingSourceRunContext,
  PollingSourceRunError,
  type PollingSourceRunner,
  type PollingSourceRunResult,
} from "./polling.js";
import type { CollectorIngestionService } from "./service.js";

export interface ContestRunPollingHttpClient {
  displayScore(testId: number): Promise<ContestRunDisplayScoreHttpResponse>;
}

/**
 * Source adapter for one contest.run mapping. It delegates all receipt and
 * observation persistence to CollectorIngestionService.
 */
export class ContestRunPollingRunner implements PollingSourceRunner {
  constructor(
    private readonly ingestion: CollectorIngestionService,
    private readonly client: ContestRunPollingHttpClient = new ContestRunHttpClient(),
  ) {}

  validateMapping(mapping: CollectorSourceContestMapping): string | undefined {
    return contestRunTestId(mapping) === undefined
      ? "INVALID_CONTEST_RUN_TEST_ID"
      : undefined;
  }

  async run(context: PollingSourceRunContext): Promise<PollingSourceRunResult> {
    const testId = contestRunTestId(context.mapping);
    if (testId === undefined) {
      throw new PollingSourceRunError(
        "INVALID_CONTEST_RUN_TEST_ID",
        0,
        0,
        "contest.run mapping has no valid test ID.",
      );
    }
    let response: ContestRunDisplayScoreHttpResponse;
    try {
      response = await this.client.displayScore(testId);
    } catch (error) {
      throw new PollingSourceRunError(
        contestRunErrorCode(error),
        1,
        0,
        "contest.run displayscore request failed.",
      );
    }
    try {
      const receipt = await this.ingestion.ingest(
        {
          sourceId: context.mapping.sourceId,
          contestId: context.mapping.contestId,
          collectorSourceContestId: context.mapping.id,
          collectorRunId: context.collectorRunId,
          receivedAt: context.receivedAt,
          messageKind: "CONTEST_RUN_DISPLAYSCORE",
          payload: response.rawPayload,
          request: {
            method: "GET",
            path: `/api/displayscore/${testId}`,
            responseStatus: response.metadata.status,
            contentType: "application/json",
          },
          metadata: {
            endpoint: response.metadata.endpoint,
            test_id: testId,
            response_bytes: response.metadata.responseBytes,
            duration_ms: response.metadata.durationMs,
          },
        },
        contestRunDisplayScorePayloadAdapter,
      );
      if (receipt.status === "FAILED") {
        throw new PollingSourceRunError(
          "INGESTION_FAILED",
          1,
          1,
          "contest.run receipt ingestion failed.",
        );
      }
      return { requestCount: 1, receivedMessageCount: 1 };
    } catch (error) {
      if (error instanceof PollingSourceRunError) throw error;
      throw new PollingSourceRunError(
        "INGESTION_ERROR",
        1,
        0,
        "contest.run receipt ingestion could not complete.",
      );
    }
  }
}

function contestRunTestId(
  mapping: CollectorSourceContestMapping,
): number | undefined {
  if (mapping.contestExternalId === null) return undefined;
  const parsed = Number(mapping.contestExternalId);
  return isContestRunTestId(parsed) ? parsed : undefined;
}

function contestRunErrorCode(error: unknown): string {
  if (error instanceof ContestRunHttpError) return `HTTP_${error.code}`;
  return "HTTP_ERROR";
}
