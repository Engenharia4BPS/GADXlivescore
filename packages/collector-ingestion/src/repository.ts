import type { Database, DatabaseId, JsonValue } from "@araucaria/database";
import { type InsertResult, type Kysely, sql } from "kysely";
import { normalizedFingerprint } from "./canonical.js";
import type {
  NormalizedScoreObservation,
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
  ): Promise<{ accepted: number; duplicates: number }>;
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
        response_headers_redacted: receipt.responseHeadersRedacted,
        payload_redacted: receipt.payloadRedacted,
        payload_sha256: receipt.payloadSha256,
        redaction_metadata: receipt.redactionMetadata,
        parse_error: null,
        validation_error: null,
        metadata: receipt.metadata ?? null,
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
  ): Promise<{ accepted: number; duplicates: number }> {
    return this.database.transaction().execute(async (trx) => {
      let accepted = 0;
      let duplicates = 0;
      for (const observation of observations) {
        const entryId = await resolveEntry(trx, observation, receivedAt);
        if (observation.categoryId)
          await assertCategory(
            trx,
            observation.categoryId,
            observation.contestId,
          );
        const fingerprint = normalizedFingerprint(observation);
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
              category_raw: observation.categoryRaw,
              source_timestamp: observation.sourceTimestamp,
              source_timestamp_raw: observation.sourceTimestampRaw,
              source_timestamp_quality: observation.sourceTimestampQuality,
              received_at: receivedAt,
              score: observation.score,
              qso_total: observation.qsoTotal,
              points_total: observation.pointsTotal,
              mult_total: observation.multTotal,
              raw_metrics: observation.rawMetrics,
              normalized_fingerprint: fingerprint,
              acceptance_status: "ACCEPTED",
              anomaly_flags: null,
              created_at: receivedAt,
            })
            .executeTakeFirstOrThrow();
        } catch (error) {
          if (isExpectedSnapshotDuplicateError(error)) {
            duplicates += 1;
            continue;
          }
          throw error;
        }
        const snapshotId = String(inserted.insertId);
        accepted += 1;
        if (observation.bands.length)
          await trx
            .insertInto("band_snapshots")
            .values(
              observation.bands.map((band) => ({
                score_snapshot_id: snapshotId,
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
      return { accepted, duplicates };
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
        parse_error: parseError,
      })
      .where("id", "=", rawMessageId)
      .execute();
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
async function assertCategory(
  database: Kysely<Database>,
  categoryId: DatabaseId,
  contestId: DatabaseId,
): Promise<void> {
  const category = await database
    .selectFrom("contest_categories")
    .select("id")
    .where("id", "=", categoryId)
    .where("contest_id", "=", contestId)
    .executeTakeFirst();
  if (!category)
    throw new Error(
      "Resolved category does not belong to the observation contest.",
    );
}
