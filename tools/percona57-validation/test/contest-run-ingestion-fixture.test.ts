import assert from "node:assert/strict";
import test from "node:test";
import {
  contestRunFixtureEvidence,
  contestRunIngestionFixtureCleanupOrder,
  phase2E4FixtureNamespace,
} from "../src/contest-run-ingestion-fixture.js";

test("Phase 2E.4 fixture cleanup removes mapped children before parents", () => {
  assert.deepEqual(contestRunIngestionFixtureCleanupOrder, [
    "current_scores",
    "score_snapshot_flags",
    "canonical_score_events",
    "band_snapshots",
    "score_snapshots",
    "raw_messages",
    "collector_runs",
    "collector_source_contests",
    "contest_category_external_ids",
    "entries",
    "contest_categories",
    "contest_external_ids",
    "contests",
    "sources",
  ]);
});

test("Phase 2E.4 mapping evidence keeps only raw contest.run identity", () => {
  const namespace = phase2E4FixtureNamespace(
    "6f8a4f7c-8a11-4c34-8a3f-0ca3dac1c27f",
  );
  const evidence = contestRunFixtureEvidence(namespace, 91);
  assert.equal(namespace, "PHASE2E4_TEST_6F8A4F7C8A114C348A3F0CA3DAC1C27F");
  assert.deepEqual(evidence, {
    fixture_namespace: namespace,
    contest_run: { testid: 91, discovery_calendar_evidence: null },
  });
  assert.equal("year" in evidence, false);
  assert.equal("time_zone" in evidence, false);
});
