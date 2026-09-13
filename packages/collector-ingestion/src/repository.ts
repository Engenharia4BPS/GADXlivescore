import { createHash } from "node:crypto";
import {
  type Database,
  type DatabaseId,
  type JsonValue,
  serializeJson,
} from "@araucaria/database";
import { type InsertResult, type Kysely, sql } from "kysely";
import { normalizedFingerprint } from "./canonical.js";
import {
  type CurrentCanonicalState,
  decideSingleSourceSequence,
} from "./single-source-policy.js";
import type {
  CanonicalReconciliationResult,
  NormalizedScoreObservation,
  ObservationPersistenceResult,
  ReceiptResult,
  RedactedReceipt,
} from "./types.js";

export interface IngestionRepository {
  createReceipt(receipt: RedactedReceipt): Promise<DatabaseId>;
  claim(rawMessageId: DatabaseId, now: string): Promise<void>;
  persistObservations(
    rawMessageId: DatabaseId,
    receivedAt: string,
    observations: NormalizedScoreObservation[],
  ): Promise<ObservationPersistenceResult[]>;
  reconcileAcceptedSnapshot(
    snapshotId: DatabaseId,
    reconciledAt: string,
  ): Promise<CanonicalReconciliationResult>;
  finish(
    rawMessageId: DatabaseId,
    result: ReceiptResult,
    parseError?: JsonValue | null,
  ): Promise<void>;
}

export class KyselyIngestionRepository implements IngestionRepository {
  constructor(private readonly database: Kysely<Database>) {}
  async createReceipt(receipt: RedactedReceipt): Promise<DatabaseId> {
    const result = await this.database
      .insertInto("raw_messages")
      .values({
        source_id: receipt.sourceId,
        contest_id: receipt.contestId,
        collector_source_contest_id: receipt.collectorSourceContestId ?? null,
        collector_run_id: receipt.collectorRunId ?? null,
        received_at: receipt.receivedAt,
        processing_status: "RECEIVED",
        processing_attempts: 0,
        processing_started_at: null,
        processed_at: null,
        observation_count: 0,
        accepted_count: 0,
        duplicate_count: 0,
        rejected_count: 0,
        message_kind: receipt.messageKind,
        request_method: receipt.request?.method ?? null,
        request_path_redacted: receipt.requestPathRedacted,
        response_status: receipt.request?.responseStatus ?? null,
        response_content_type: receipt.request?.contentType ?? null,
        response_headers_redacted: serializeJson(
          receipt.responseHeadersRedacted,
        ),
        payload_redacted: receipt.payloadRedacted,
        payload_sha256: receipt.payloadSha256,
        redaction_metadata: serializeJson(receipt.redactionMetadata),
        parse_error: null,
        validation_error: null,
        metadata: serializeJson(receipt.metadata ?? null),
        created_at: receipt.receivedAt,
      })
      .executeTakeFirstOrThrow();
    if (result.insertId === undefined)
      throw new Error("Raw receipt insert returned no id.");
    return String(result.insertId);
  }
  async claim(rawMessageId: DatabaseId, now: string): Promise<void> {
    const result = await this.database
      .updateTable("raw_messages")
      .set({
        processing_status: "PROCESSING",
        processing_started_at: now,
        processing_attempts: sql`processing_attempts + 1`,
      })
      .where("id", "=", rawMessageId)
      .where("processing_status", "=", "RECEIVED")
      .executeTakeFirst();
    if (!result.numUpdatedRows)
      throw new Error("Raw receipt is not available for processing.");
  }
  async persistObservations(
    rawMessageId: DatabaseId,
    receivedAt: string,
    observations: NormalizedScoreObservation[],
  ): Promise<ObservationPersistenceResult[]> {
    return this.database.transaction().execute(async (trx) => {
      const results: ObservationPersistenceResult[] = [];
      for (const observation of observations) {
        if (
          observation.categoryId &&
          !(await categoryBelongsToContest(
            trx,
            observation.categoryId,
            observation.contestId,
          ))
        ) {
          results.push({
            outcome: "REJECTED",
            reason:
              "Resolved category does not belong to the observation contest.",
          });
          continue;
        }
        const fingerprint = normalizedFingerprint(observation);
        const entryId = await resolveEntry(trx, observation, receivedAt);
        const existing = await trx
          .selectFrom("score_snapshots")
          .select("id")
          .where("entry_id", "=", entryId)
          .where("source_id", "=", observation.sourceId)
          .where("normalized_fingerprint", "=", fingerprint)
          .executeTakeFirst();
        if (existing) {
          results.push({ outcome: "DUPLICATE", entryId });
          continue;
        }
        let inserted: InsertResult;
        try {
          inserted = await trx
            .insertInto("score_snapshots")
            .values({
              entry_id: entryId,
              contest_id: observation.contestId,
              source_id: observation.sourceId,
              raw_message_id: rawMessageId,
              category_id: observation.categoryId,
              category_raw: serializeJson(observation.categoryRaw),
              source_timestamp: observation.sourceTimestamp,
              source_timestamp_raw: observation.sourceTimestampRaw,
              source_timestamp_quality: observation.sourceTimestampQuality,
              received_at: receivedAt,
              score: observation.score,
              qso_total: observation.qsoTotal,
              points_total: observation.pointsTotal,
              mult_total: observation.multTotal,
              raw_metrics: serializeJson(observation.rawMetrics),
              normalized_fingerprint: fingerprint,
              acceptance_status: "ACCEPTED",
              anomaly_flags: null,
              created_at: receivedAt,
            })
            .executeTakeFirstOrThrow();
        } catch (error) {
          if (isExpectedSnapshotDuplicateError(error)) {
            results.push({ outcome: "DUPLICATE", entryId });
            continue;
          }
          throw error;
        }
        if (inserted.insertId === undefined)
          throw new Error("Score snapshot insert returned no id.");
        const snapshotId = String(inserted.insertId);
        results.push({ outcome: "ACCEPTED", entryId, snapshotId });
        if (observation.bands.length)
          await trx
            .insertInto("band_snapshots")
            .values(
              observation.bands.map((band) => ({
                snapshot_id: snapshotId,
                band: band.band,
                mode: band.mode,
                qso: band.qso,
                points: band.points,
                mult1: band.mult1,
                mult2: band.mult2,
              })),
            )
            .execute();
      }
      return results;
    });
  }
  async reconcileAcceptedSnapshot(
    snapshotId: DatabaseId,
    reconciledAt: string,
  ): Promise<CanonicalReconciliationResult> {
    return this.database.transaction().execute(async (trx) => {
      const candidate = await trx
        .selectFrom("score_snapshots")
        .select([
          "acceptance_status as acceptanceStatus",
          "entry_id as entryId",
          "id as snapshotId",
          "source_id as sourceId",
          "source_timestamp as sourceTimestamp",
          "source_timestamp_quality as sourceTimestampQuality",
        ])
        .where("id", "=", snapshotId)
        .executeTakeFirst();
      if (!candidate)
        throw new Error("Accepted snapshot disappeared before reconciliation.");

      await trx
        .selectFrom("entries")
        .select("id")
        .where("id", "=", candidate.entryId)
        .forUpdate()
        .executeTakeFirstOrThrow();
      const current = await trx
        .selectFrom("current_scores as current")
        .innerJoin(
          "canonical_score_events as event",
          "event.id",
          "current.canonical_event_id",
        )
        .innerJoin(
          "score_snapshots as snapshot",
          "snapshot.id",
          "event.score_snapshot_id",
        )
        .select([
          "event.effective_at as effectiveAt",
          "event.id as eventId",
          "snapshot.id as snapshotId",
          "snapshot.source_id as sourceId",
        ])
        .where("current.entry_id", "=", candidate.entryId)
        .executeTakeFirst();
      const decision = decideSingleSourceSequence(candidate, current);

      if (decision.outcome === "INELIGIBLE_TIMESTAMP") return decision;
      if (decision.outcome === "DEFERRED_CROSS_SOURCE_POLICY") return decision;
      if (decision.outcome === "OUT_OF_ORDER") {
        await appendOutOfOrderFlag(
          trx,
          candidate.snapshotId,
          reconciledAt,
          current,
        );
        return decision;
      }
      const effectiveAt = candidate.sourceTimestamp;
      if (effectiveAt === null)
        throw new Error("Eligible snapshot is missing a source timestamp.");

      const event = await trx
        .insertInto("canonical_score_events")
        .values({
          entry_id: candidate.entryId,
          score_snapshot_id: candidate.snapshotId,
          selected_at: reconciledAt,
          effective_at: effectiveAt,
          selection_basis: "SINGLE_SOURCE_SEQUENCE",
          selection_reason:
            decision.outcome === "CANONICAL_INITIAL"
              ? "INITIAL_CANONICAL"
              : "SAME_SOURCE_NONDECREASING_EFFECTIVE_AT",
          context: null,
        })
        .executeTakeFirstOrThrow();
      const eventId = String(event.insertId);
      if (current) {
        await trx
          .updateTable("current_scores")
          .set({
            canonical_event_id: eventId,
            canonical_snapshot_id: candidate.snapshotId,
            updated_at: reconciledAt,
          })
          .where("entry_id", "=", candidate.entryId)
          .execute();
      } else {
        await trx
          .insertInto("current_scores")
          .values({
            entry_id: candidate.entryId,
            canonical_event_id: eventId,
            canonical_snapshot_id: candidate.snapshotId,
            updated_at: reconciledAt,
          })
          .execute();
      }
      return { outcome: decision.outcome, canonicalEventId: eventId };
    });
  }
  async finish(
    rawMessageId: DatabaseId,
    result: ReceiptResult,
    parseError: JsonValue | null = null,
  ): Promise<void> {
    await this.database
      .updateTable("raw_messages")
      .set({
        processing_status: result.status,
        processed_at:
          result.status === "PROCESSING" || result.status === "RECEIVED"
            ? null
            : new Date().toISOString().replace("T", " ").replace("Z", ""),
        observation_count: result.observationCount,
        accepted_count: result.acceptedCount,
        duplicate_count: result.duplicateCount,
        rejected_count: result.rejectedCount,
        parse_error: serializeJson(parseError),
      })
      .where("id", "=", rawMessageId)
      .execute();
  }
}
async function appendOutOfOrderFlag(
  database: Kysely<Database>,
  snapshotId: DatabaseId,
  detectedAt: string,
  current: CurrentCanonicalState | undefined,
): Promise<void> {
  const diagnosticFingerprint = createHash("sha256")
    .update(`OUT_OF_ORDER|${snapshotId}`, "utf8")
    .digest();
  const existing = await database
    .selectFrom("score_snapshot_flags")
    .select("id")
    .where("snapshot_id", "=", snapshotId)
    .where("diagnostic_fingerprint", "=", diagnosticFingerprint)
    .executeTakeFirst();
  if (existing) return;
  try {
    await database
      .insertInto("score_snapshot_flags")
      .values({
        snapshot_id: snapshotId,
        flag: "OUT_OF_ORDER",
        detected_at: detectedAt,
        details: serializeJson(
          current
            ? {
                current_canonical_event_id: current.eventId,
                current_canonical_snapshot_id: current.snapshotId,
                current_effective_at: current.effectiveAt,
              }
            : null,
        ),
        diagnostic_fingerprint: diagnosticFingerprint,
      })
      .execute();
  } catch (error) {
    if (!isExpectedSnapshotFlagDuplicateError(error)) throw error;
  }
}
export function isExpectedSnapshotDuplicateError(error: unknown): boolean {
  if (!error || typeof error !== "object") return false;
  const mysql = error as {
    code?: unknown;
    errno?: unknown;
    sqlMessage?: unknown;
    message?: unknown;
  };
  const message =
    typeof mysql.sqlMessage === "string"
      ? mysql.sqlMessage
      : typeof mysql.message === "string"
        ? mysql.message
        : "";
  return (
    mysql.code === "ER_DUP_ENTRY" &&
    mysql.errno === 1062 &&
    message.includes("uq_score_snapshots_entry_source_fingerprint")
  );
}
function isExpectedSnapshotFlagDuplicateError(error: unknown): boolean {
  if (!error || typeof error !== "object") return false;
  const mysql = error as {
    code?: unknown;
    errno?: unknown;
    sqlMessage?: unknown;
    message?: unknown;
  };
  const message =
    typeof mysql.sqlMessage === "string"
      ? mysql.sqlMessage
      : typeof mysql.message === "string"
        ? mysql.message
        : "";
  return (
    mysql.code === "ER_DUP_ENTRY" &&
    mysql.errno === 1062 &&
    message.includes("uq_score_snapshot_flags_snapshot_diagnostic")
  );
}
async function resolveEntry(
  database: Kysely<Database>,
  observation: NormalizedScoreObservation,
  now: string,
): Promise<DatabaseId> {
  await database
    .insertInto("entries")
    .values({
      contest_id: observation.contestId,
      normalized_callsign: observation.normalizedCallsign,
      display_callsign: observation.displayCallsign,
      current_category_id: observation.categoryId,
      current_category_observed_at: observation.categoryId ? now : null,
      metadata: null,
      created_at: now,
      updated_at: now,
    })
    .onDuplicateKeyUpdate({
      display_callsign: observation.displayCallsign,
      current_category_id: observation.categoryId,
      current_category_observed_at: observation.categoryId ? now : null,
      updated_at: now,
    })
    .execute();
  const entry = await database
    .selectFrom("entries")
    .select("id")
    .where("contest_id", "=", observation.contestId)
    .where("normalized_callsign", "=", observation.normalizedCallsign)
    .executeTakeFirst();
  if (!entry) throw new Error("Unable to resolve entry after upsert.");
  return entry.id;
}
async function categoryBelongsToContest(
  database: Kysely<Database>,
  categoryId: DatabaseId,
  contestId: DatabaseId,
): Promise<boolean> {
  const category = await database
    .selectFrom("contest_categories")
    .select("id")
    .where("id", "=", categoryId)
    .where("contest_id", "=", contestId)
    .executeTakeFirst();
  return category !== undefined;
}
