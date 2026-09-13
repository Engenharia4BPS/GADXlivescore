import type { JsonObject } from "@araucaria/database";

/** All fixture-owned children precede their referential parents. */
export const contestRunIngestionFixtureCleanupOrder = [
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
] as const;

export function phase2E4FixtureNamespace(token: string): string {
  const normalized = token.replaceAll("-", "").toUpperCase();
  if (!/^[A-Z0-9]{16,64}$/.test(normalized)) {
    throw new Error("Phase 2E.4 fixture token must be a UUID-like identifier.");
  }
  return `PHASE2E4_TEST_${normalized}`;
}

/**
 * This is evidence, not a calendar interpretation: it deliberately contains
 * no inferred year, timezone, start, finish, or activity state.
 */
export function contestRunFixtureEvidence(
  namespace: string,
  testId: number,
): JsonObject {
  if (!Number.isInteger(testId) || testId <= 0) {
    throw new Error("contest.run fixture testId must be a positive integer.");
  }
  return {
    fixture_namespace: namespace,
    contest_run: {
      testid: testId,
      discovery_calendar_evidence: null,
    },
  };
}
