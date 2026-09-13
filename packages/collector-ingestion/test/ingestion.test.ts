import assert from "node:assert/strict";
import test from "node:test";
import {
  type CanonicalCandidate,
  type CanonicalReconciliationResult,
  CollectorIngestionService,
  type CollectorReceipt,
  type CurrentCanonicalState,
  decideSingleSourceSequence,
  type IngestionRepository,
  isExpectedSnapshotDuplicateError,
  type NormalizedScoreObservation,
  normalizeContestRunPayload,
  normalizedFingerprint,
  type ObservationPersistenceResult,
  type ReceiptResult,
  redactReceipt,
  sha256,
} from "../src/index.js";

const encoder = new TextEncoder();
const receipt = (payload: unknown): CollectorReceipt => ({
  sourceId: "1",
  contestId: "2",
  receivedAt: "2026-09-11 12:00:00.000000",
  messageKind: "HTTP_RESPONSE",
  payload: encoder.encode(JSON.stringify(payload)),
  request: {
    path: "/api/displayscore/40?auth=secret",
    headers: { authorization: "secret", accept: "application/json" },
  },
});
const row = (extra: Record<string, unknown> = {}) => ({
  sign: "DM7EE",
  date: "2026-09-11 12:00:00",
  score: 36594,
  qtotal: 342,
  ptotal: 100,
  mtotal: 107,
  q80: 100,
  ...extra,
});

test("contest.run redaction, heterogeneous soft, and unresolved fields are preserved safely", () => {
  const redacted = redactReceipt(
    receipt([
      row({
        soft: "4",
        qtotalc: 1,
        qtotalp: 2,
        qtotalr: 3,
        auth: "never-store",
      }),
    ]),
  );
  const stored = new TextDecoder().decode(redacted.payloadRedacted);
  assert.deepEqual(redacted.payloadSha256, sha256(redacted.payload));
  assert.doesNotMatch(stored, /auth|never-store/);
  assert.doesNotMatch(
    JSON.stringify(redacted.responseHeadersRedacted),
    /secret/,
  );
  const observation = only(normalizeContestRunPayload(redacted).observations);
  assert.equal(observation.qsoTotal, "342");
  assert.equal(observation.sourceTimestamp, null);
  assert.equal(observation.sourceTimestampQuality, "UNZONED_SOURCE_TEXT");
  assert.deepEqual(
    (observation.rawMetrics as Record<string, unknown>).qtotalc,
    1,
  );
  assert.equal((observation.rawMetrics as Record<string, unknown>).soft, "4");
  const numericSoft = only(
    normalizeContestRunPayload(
      redactReceipt(
        receipt([row({ soft: 4, qtotalc: 1, qtotalp: 2, qtotalr: 3 })]),
      ),
    ).observations,
  );
  assert.deepEqual(
    observation.fingerprintEvidence,
    numericSoft.fingerprintEvidence,
  );
});

test("fingerprints are invariant to object and band ordering but retain source timestamp and resets", () => {
  const a = only(
    normalizeContestRunPayload(
      redactReceipt(receipt([row({ q40: 20, m80: 7, m40: 2 })])),
    ).observations,
  );
  const b: typeof a = {
    ...a,
    bands: [...a.bands].reverse(),
    rawMetrics: { unrelated_diagnostic: "changed" },
    fingerprintEvidence: {
      qtotalr: null,
      qtotalp: null,
      qtotalc: null,
      soft: null,
    },
  };
  assert.deepEqual(normalizedFingerprint(a), normalizedFingerprint(b));
  const later: typeof a = { ...a, sourceTimestampRaw: "2026-09-11 12:01:00" };
  assert.notDeepEqual(normalizedFingerprint(a), normalizedFingerprint(later));
  const reset: typeof a = {
    ...a,
    score: "0",
    qsoTotal: "0",
    multTotal: "0",
    sourceTimestampRaw: "2026-09-11 12:02:00",
  };
  assert.notDeepEqual(normalizedFingerprint(a), normalizedFingerprint(reset));
  assert.equal(reset.score, "0");
  assert.equal(reset.qsoTotal, "0");
});

test("only the named snapshot fingerprint duplicate is classified as duplicate", () => {
  assert.equal(
    isExpectedSnapshotDuplicateError({
      code: "ER_DUP_ENTRY",
      errno: 1062,
      sqlMessage:
        "Duplicate entry for key 'uq_score_snapshots_entry_source_fingerprint'",
    }),
    true,
  );
  assert.equal(
    isExpectedSnapshotDuplicateError({
      code: "ER_DUP_ENTRY",
      errno: 1062,
      sqlMessage: "Duplicate entry for key 'uq_entries_contest_callsign'",
    }),
    false,
  );
  assert.equal(
    isExpectedSnapshotDuplicateError({
      code: "ER_DATA_TOO_LONG",
      errno: 1406,
      sqlMessage: "Data too long",
    }),
    false,
  );
});

test("aggregate qtotal remains authoritative when bands differ", () => {
  const observation = only(
    normalizeContestRunPayload(
      redactReceipt(receipt([row({ qtotal: 342, q80: 10, q40: 20 })])),
    ).observations,
  );
  assert.equal(observation.qsoTotal, "342");
  assert.equal(
    observation.bands.reduce((sum, band) => sum + Number(band.qso ?? 0), 0),
    30,
  );
});

test("single-source policy defers a different source without mutating canonical state", () => {
  const candidate: CanonicalCandidate = Object.freeze({
    acceptanceStatus: "ACCEPTED",
    entryId: "10",
    snapshotId: "20",
    sourceId: "2",
    sourceTimestamp: "2026-09-11 12:01:00.000000",
    sourceTimestampQuality: "CONFIRMED_UTC",
  });
  const current: CurrentCanonicalState = Object.freeze({
    effectiveAt: "2026-09-11 12:00:00.000000",
    eventId: "30",
    snapshotId: "19",
    sourceId: "1",
  });
  const before = structuredClone({ candidate, current });

  assert.deepEqual(decideSingleSourceSequence(candidate, current), {
    outcome: "DEFERRED_CROSS_SOURCE_POLICY",
  });
  assert.deepEqual({ candidate, current }, before);
});

test("same-source timestamp-only observations create the next canonical event", async () => {
  const repository = new MemoryRepository();
  const service = new CollectorIngestionService(repository);
  const first = confirmedObservation("2026-09-11 12:00:00.000000");
  const second: NormalizedScoreObservation = {
    ...first,
    sourceTimestamp: "2026-09-11 12:01:00.000000",
    sourceTimestampRaw: "2026-09-11 12:01:00.000000 UTC",
  };

  const firstResult = await service.ingest(receipt({ fixture: "first" }), {
    parse: () => ({ observations: [first], rejected: [] }),
  });
  const firstSnapshotId = repository.snapshotIdFor(first);
  assert.equal(firstResult.acceptedCount, 1);
  assert.equal(
    repository.reconciliationResultFor(firstSnapshotId)?.outcome,
    "CANONICAL_INITIAL",
  );

  const secondResult = await service.ingest(receipt({ fixture: "second" }), {
    parse: () => ({ observations: [second], rejected: [] }),
  });
  const secondSnapshotId = repository.snapshotIdFor(second);
  assert.notEqual(firstSnapshotId, secondSnapshotId);
  assert.notDeepEqual(
    normalizedFingerprint(first),
    normalizedFingerprint(second),
  );
  assert.equal(secondResult.acceptedCount, 1);
  assert.equal(
    repository.reconciliationResultFor(secondSnapshotId)?.outcome,
    "CANONICAL_ADVANCED",
  );
  assert.equal(repository.canonicalEventCountFor(secondSnapshotId), 1);
  assert.deepEqual(repository.currentFor("entry-TEST1"), {
    eventId: repository.canonicalEventIdFor(secondSnapshotId),
    snapshotId: secondSnapshotId,
  });

  assert.deepEqual(
    decideSingleSourceSequence(
      {
        acceptanceStatus: "ACCEPTED",
        entryId: "entry-TEST1",
        snapshotId: "equal-effective-at",
        sourceId: "source-A",
        sourceTimestamp: "2026-09-11 12:00:00",
        sourceTimestampQuality: "CONFIRMED_UTC",
      },
      {
        effectiveAt: "2026-09-11 12:00:00.000000",
        eventId: "event-first",
        snapshotId: "snapshot-first",
        sourceId: "source-A",
      },
    ),
    { outcome: "CANONICAL_ADVANCED" },
  );
});

test("batch lifecycle preserves valid rows and marks malformed mixed batches partial", async () => {
  const repository = new MemoryRepository();
  const service = new CollectorIngestionService(repository);
  const result = await service.ingest(
    receipt([
      row(),
      { sign: "" },
      row({ sign: "K1ABC", date: "2026-09-11 12:01:00" }),
    ]),
    { parse: normalizeContestRunPayload },
  );
  assert.equal(result.status, "PARTIAL");
  assert.equal(result.observationCount, 3);
  assert.equal(result.acceptedCount, 2);
  assert.equal(result.rejectedCount, 1);
});

test("exact duplicates do not create another snapshot and all-invalid batches fail", async () => {
  const repository = new MemoryRepository();
  const service = new CollectorIngestionService(repository);
  const adapter = { parse: normalizeContestRunPayload };
  assert.equal(
    (await service.ingest(receipt([row()]), adapter)).acceptedCount,
    1,
  );
  const duplicate = await service.ingest(receipt([row()]), adapter);
  assert.equal(duplicate.status, "PROCESSED");
  assert.equal(duplicate.duplicateCount, 1);
  const failed = await service.ingest(receipt([{ sign: "" }]), adapter);
  assert.equal(failed.status, "FAILED");
  assert.equal(failed.rejectedCount, 1);
});

test("repository-level rejection is counted as a rejected observation", async () => {
  const result = await new CollectorIngestionService(
    new RejectingRepository(),
  ).ingest(receipt([row()]), { parse: normalizeContestRunPayload });
  assert.equal(result.status, "FAILED");
  assert.equal(result.acceptedCount, 0);
  assert.equal(result.duplicateCount, 0);
  assert.equal(result.rejectedCount, 1);
});

test("unexpected persistence failure is failed, not counted as a duplicate or acceptance", async () => {
  const repository = new FailingRepository();
  const result = await new CollectorIngestionService(repository).ingest(
    receipt([row()]),
    { parse: normalizeContestRunPayload },
  );
  assert.equal(result.status, "FAILED");
  assert.equal(result.acceptedCount, 0);
  assert.equal(result.duplicateCount, 0);
  assert.equal(result.observationCount, 1);
  assert.equal(repository.finished?.acceptedCount, 0);
});

class MemoryRepository implements IngestionRepository {
  private next = 1;
  private readonly fingerprints = new Set<string>();
  private readonly snapshots = new Map<string, CanonicalCandidate>();
  private readonly snapshotIdsByFingerprint = new Map<string, string>();
  private readonly canonicalEvents = new Map<string, string>();
  private readonly current = new Map<
    string,
    {
      eventId: string;
      snapshotId: string;
      sourceId: string;
      effectiveAt: string;
    }
  >();
  private readonly reconciliationResults = new Map<
    string,
    CanonicalReconciliationResult
  >();
  async createReceipt(): Promise<string> {
    return String(this.next++);
  }
  async claim(): Promise<void> {}
  async persistObservations(
    _raw: string,
    _at: string,
    observations: NormalizedScoreObservation[],
  ): Promise<ObservationPersistenceResult[]> {
    const results: ObservationPersistenceResult[] = [];
    for (const observation of observations) {
      const fingerprint = Buffer.from(
        normalizedFingerprint(observation),
      ).toString("hex");
      const entryId = `entry-${observation.normalizedCallsign}`;
      if (this.fingerprints.has(fingerprint))
        results.push({ outcome: "DUPLICATE", entryId });
      else {
        this.fingerprints.add(fingerprint);
        const snapshotId = `snapshot-${this.next++}`;
        this.snapshotIdsByFingerprint.set(fingerprint, snapshotId);
        this.snapshots.set(snapshotId, {
          acceptanceStatus: "ACCEPTED",
          entryId,
          snapshotId,
          sourceId: observation.sourceId,
          sourceTimestamp: observation.sourceTimestamp,
          sourceTimestampQuality: observation.sourceTimestampQuality,
        });
        results.push({
          outcome: "ACCEPTED",
          entryId,
          snapshotId,
        });
      }
    }
    return results;
  }
  async reconcileAcceptedSnapshot(
    snapshotId: string,
  ): Promise<CanonicalReconciliationResult> {
    const candidate = this.snapshots.get(snapshotId);
    if (!candidate) throw new Error("Unknown snapshot.");
    const current = this.current.get(candidate.entryId);
    const decision = decideSingleSourceSequence(candidate, current);
    if (
      decision.outcome === "CANONICAL_INITIAL" ||
      decision.outcome === "CANONICAL_ADVANCED"
    ) {
      const eventId = `event-${this.next++}`;
      this.canonicalEvents.set(snapshotId, eventId);
      this.current.set(candidate.entryId, {
        eventId,
        snapshotId,
        sourceId: candidate.sourceId,
        effectiveAt: candidate.sourceTimestamp as string,
      });
      const result = { ...decision, canonicalEventId: eventId };
      this.reconciliationResults.set(snapshotId, result);
      return result;
    }
    this.reconciliationResults.set(snapshotId, decision);
    return decision;
  }
  async finish(_raw: string, _result: ReceiptResult): Promise<void> {}
  snapshotIdFor(observation: NormalizedScoreObservation): string {
    const fingerprint = Buffer.from(
      normalizedFingerprint(observation),
    ).toString("hex");
    const snapshotId = this.snapshotIdsByFingerprint.get(fingerprint);
    if (!snapshotId) throw new Error("Snapshot was not persisted.");
    return snapshotId;
  }
  canonicalEventIdFor(snapshotId: string): string {
    const eventId = this.canonicalEvents.get(snapshotId);
    if (!eventId) throw new Error("Snapshot was not canonicalized.");
    return eventId;
  }
  canonicalEventCountFor(snapshotId: string): number {
    return this.canonicalEvents.has(snapshotId) ? 1 : 0;
  }
  currentFor(
    entryId: string,
  ): { eventId: string; snapshotId: string } | undefined {
    const current = this.current.get(entryId);
    return current
      ? { eventId: current.eventId, snapshotId: current.snapshotId }
      : undefined;
  }
  reconciliationResultFor(
    snapshotId: string,
  ): CanonicalReconciliationResult | undefined {
    return this.reconciliationResults.get(snapshotId);
  }
}

class FailingRepository extends MemoryRepository {
  finished: ReceiptResult | undefined;
  override async persistObservations(): Promise<
    ObservationPersistenceResult[]
  > {
    throw Object.assign(new Error("Data too long"), {
      code: "ER_DATA_TOO_LONG",
      errno: 1406,
    });
  }
  override async finish(_raw: string, result: ReceiptResult): Promise<void> {
    this.finished = result;
  }
}

class RejectingRepository extends MemoryRepository {
  override async persistObservations(): Promise<
    ObservationPersistenceResult[]
  > {
    return [{ outcome: "REJECTED", reason: "Fixture category mismatch." }];
  }
}

function confirmedObservation(
  sourceTimestamp: string,
): NormalizedScoreObservation {
  return {
    sourceId: "source-A",
    contestId: "contest-A",
    normalizedCallsign: "TEST1",
    displayCallsign: "TEST1",
    categoryId: null,
    categoryRaw: null,
    sourceTimestamp,
    sourceTimestampRaw: `${sourceTimestamp} UTC`,
    sourceTimestampQuality: "CONFIRMED_UTC",
    score: "100",
    qsoTotal: "10",
    pointsTotal: "900",
    multTotal: "4",
    rawMetrics: null,
    fingerprintEvidence: null,
    bands: [],
  };
}

function only<T>(values: T[]): T {
  const value = values[0];
  if (value === undefined) throw new Error("Expected exactly one observation.");
  return value;
}
