import {
  ContestRunDiscoveryService,
  ContestRunHttpClient,
  ContestRunHttpError,
} from "@araucaria/source-adapters";

const maxCategoryRequests = 2;
const maxRequestCount = 2 + maxCategoryRequests;

async function main(): Promise<void> {
  const month = new Date().getUTCMonth() + 1;
  const result = await new ContestRunDiscoveryService(
    new ContestRunHttpClient(),
  ).discover({ month, maxContests: maxCategoryRequests });

  const summary = {
    status: "PASS",
    probe: "contest.run discovery read-only",
    readOnly: true,
    month,
    requestCount: result.requests.length,
    maxRequestCount,
    scoreRequests: 0,
    requests: result.requests.map((request) => ({
      endpoint: request.endpoint,
      status: request.status,
      durationMs: request.durationMs,
      responseBytes: request.responseBytes,
    })),
    contests: result.contests.map((contest) => ({
      testId: contest.testId,
      discoverySources: contest.discoveryEvidence.map(
        (evidence) => evidence.source,
      ),
      categoryCount: contest.categories.length,
      categoryFetchStatus: contest.categoryFetchStatus,
    })),
  };
  await writeStdout(JSON.stringify(summary, null, 2));
}

async function writeStdout(text: string): Promise<void> {
  await new Promise<void>((resolve, reject) => {
    process.stdout.write(`${text}\n`, (error) => {
      if (error) reject(error);
      else resolve();
    });
  });
}

try {
  await main();
} catch (error) {
  const detail =
    error instanceof ContestRunHttpError
      ? { code: error.code, endpoint: error.endpoint }
      : { code: "UNEXPECTED" };
  try {
    await writeStdout(
      JSON.stringify(
        {
          status: "FAIL",
          probe: "contest.run discovery read-only",
          ...detail,
        },
        null,
        2,
      ),
    );
  } finally {
    process.exitCode = 1;
  }
}
