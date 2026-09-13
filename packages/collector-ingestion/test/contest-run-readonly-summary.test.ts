import assert from "node:assert/strict";
import test from "node:test";
import { ContestRunHttpClient } from "@araucaria/source-adapters";
import { ContestRunDisplayScoreReadOnlyService } from "../src/index.js";

test("read-only displayscore summary normalizes redacted rows without persistence", async () => {
  let requestCount = 0;
  const client = new ContestRunHttpClient({
    fetch: async (url) => {
      requestCount += 1;
      assert.equal(new URL(url).pathname, "/api/displayscore/108");
      return new Response(
        JSON.stringify([
          {
            sign: "DM7EE",
            date: "2026-09-11 20:35:30",
            score: 36594,
            qtotal: 342,
            ptotal: 100,
            mtotal: 107,
            q80: 10,
            q40: 20,
            p80: 10,
            p40: 20,
            m80: 2,
            m40: 3,
            qtotalc: 7,
            qtotalp: 8,
            qtotalr: 9,
            soft: "4",
            auth: "top-level-secret",
            diagnostic: { AUTH: "nested-secret", retained: true },
          },
          {
            sign: "PA6Y",
            date: "2026-09-11 20:35:31",
            score: 3,
            qtotal: 1,
            ptotal: 1,
            mtotal: 3,
            q40: 1,
            p40: 1,
            m40: 3,
            soft: 4,
          },
          null,
        ]),
        {
          status: 200,
          headers: { "content-type": "application/json" },
        },
      );
    },
  });

  const result = await new ContestRunDisplayScoreReadOnlyService(
    client,
  ).summarize([108], { maxContests: 2 });

  assert.equal(result.scoreRequests, 1);
  assert.equal(requestCount, 1);
  const summary = result.summaries[0];
  assert(summary);
  assert.equal(summary.testId, 108);
  assert.equal(summary.http.endpoint, "displayscore");
  assert.equal(summary.sourceRowCount, 3);
  assert.equal(summary.acceptedObservationCount, 2);
  assert.equal(summary.rejectedObservationCount, 1);
  assert.equal(summary.datePresentCount, 2);
  assert.equal(summary.unzonedSourceTextCount, 2);
  assert.deepEqual(summary.resetLikeEvidence, {
    comparisonPerformed: false,
    observedCount: 0,
  });
  assert.equal(summary.aggregateBandDisagreementCount, 1);
  assert.deepEqual(summary.softObservedTypes, ["number", "string"]);
  assert.deepEqual(summary.unresolvedMetricPresence, {
    qtotalc: 1,
    qtotalp: 1,
    qtotalr: 1,
  });
  assert.equal(summary.authRedactionVerified, true);
  assert.doesNotMatch(JSON.stringify(summary.sample), /auth|secret/i);
  assert.deepEqual(summary.sample[0], {
    callsign: "DM7EE",
    score: "36594",
    qsoTotal: "342",
    pointsTotal: "100",
    multTotal: "107",
  });
});
