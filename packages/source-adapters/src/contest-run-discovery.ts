import type {
  ContestRunCategoriesResponse,
  ContestRunCategoryRecord,
  ContestRunDiscoveryRecord,
} from "./contest-run.js";
import type {
  ContestRunHttpResponse,
  ContestRunHttpResponseMetadata,
} from "./contest-run-http.js";

export interface ContestRunDiscoveryClient {
  nearest(): Promise<
    ContestRunHttpResponse<{ records: readonly ContestRunDiscoveryRecord[] }>
  >;
  month(
    month: number,
  ): Promise<
    ContestRunHttpResponse<{ records: readonly ContestRunDiscoveryRecord[] }>
  >;
  categories(
    testId: number,
  ): Promise<ContestRunHttpResponse<ContestRunCategoriesResponse>>;
}

export interface ContestRunDiscoveryOptions {
  month?: number;
  maxContests?: number;
}

export interface ContestRunDiscoveryEvidence {
  source: "nearest" | "month";
  record: ContestRunDiscoveryRecord;
}

export interface ContestRunDiscoveredContest {
  testId: number;
  discoveryEvidence: readonly ContestRunDiscoveryEvidence[];
  categories: readonly ContestRunCategoryRecord[];
  categoryFetchStatus: "FETCHED" | "NOT_REQUESTED_LIMIT";
}

export interface ContestRunDiscoveryResult {
  contests: readonly ContestRunDiscoveredContest[];
  requests: readonly ContestRunHttpResponseMetadata[];
}

/**
 * Aggregates source discovery evidence without assigning calendar, timezone,
 * activity, or category-mapping semantics. testid is the sole dedup identity.
 */
export class ContestRunDiscoveryService {
  constructor(private readonly client: ContestRunDiscoveryClient) {}

  async discover(
    options: ContestRunDiscoveryOptions = {},
  ): Promise<ContestRunDiscoveryResult> {
    validateMaxContests(options.maxContests);
    validateMonth(options.month);
    const nearest = await this.client.nearest();
    const requests: ContestRunHttpResponseMetadata[] = [nearest.metadata];
    const evidence: ContestRunDiscoveryEvidence[] = nearest.data.records.map(
      (record) => ({ source: "nearest", record }),
    );

    if (options.month !== undefined) {
      const month = await this.client.month(options.month);
      requests.push(month.metadata);
      const monthEvidence: ContestRunDiscoveryEvidence[] =
        month.data.records.map((record) => ({ source: "month", record }));
      evidence.push(...monthEvidence);
    }

    const contests = aggregateDiscoveryEvidence(evidence);
    const maximum = options.maxContests ?? contests.length;
    for (const [index, contest] of contests.entries()) {
      if (index >= maximum) continue;
      const categories = await this.client.categories(contest.testId);
      requests.push(categories.metadata);
      contest.categories = categories.data.records;
      contest.categoryFetchStatus = "FETCHED";
    }
    return { contests, requests };
  }
}

export function aggregateDiscoveryEvidence(
  evidence: readonly ContestRunDiscoveryEvidence[],
): MutableContest[] {
  const byTestId = new Map<number, MutableContest>();
  for (const item of evidence) {
    const existing = byTestId.get(item.record.testid);
    if (existing) {
      existing.discoveryEvidence.push(item);
      continue;
    }
    byTestId.set(item.record.testid, {
      testId: item.record.testid,
      discoveryEvidence: [item],
      categories: [],
      categoryFetchStatus: "NOT_REQUESTED_LIMIT",
    });
  }
  return [...byTestId.values()];
}

interface MutableContest {
  testId: number;
  discoveryEvidence: ContestRunDiscoveryEvidence[];
  categories: readonly ContestRunCategoryRecord[];
  categoryFetchStatus: "FETCHED" | "NOT_REQUESTED_LIMIT";
}

function validateMaxContests(value: number | undefined): void {
  if (value !== undefined && (!Number.isSafeInteger(value) || value < 0)) {
    throw new Error(
      "contest.run maxContests must be a non-negative safe integer.",
    );
  }
}

function validateMonth(value: number | undefined): void {
  if (
    value !== undefined &&
    (!Number.isSafeInteger(value) || value < 1 || value > 12)
  ) {
    throw new Error("contest.run month must be an integer from 1 to 12.");
  }
}
