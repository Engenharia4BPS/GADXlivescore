import {
  ContestRunHttpClient,
  ContestRunHttpError,
} from "@araucaria/source-adapters";
import { ContestRunDisplayScoreReadOnlyService } from "./contest-run-readonly-summary.js";

const discoveredTestIds = [108, 91] as const;
const maxScoreRequests = 2;

async function main(): Promise<void> {
  const result = await new ContestRunDisplayScoreReadOnlyService(
    new ContestRunHttpClient(),
  ).summarize(discoveredTestIds, { maxContests: maxScoreRequests });

  await writeStdout(
    JSON.stringify(
      {
        status: "PASS",
        probe: "contest.run displayscore read-only normalization",
        readOnly: true,
        scoreRequests: result.scoreRequests,
        maxScoreRequests,
        contests: result.summaries,
      },
      null,
      2,
    ),
  );
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
          probe: "contest.run displayscore read-only normalization",
          readOnly: true,
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
