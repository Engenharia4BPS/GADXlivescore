import type { DatabaseId, JsonValue } from "@araucaria/database";

export type RawMessageStatus =
  | "RECEIVED"
  | "PROCESSING"
  | "PROCESSED"
  | "PARTIAL"
  | "FAILED";

export interface CollectorReceipt {
  sourceId: DatabaseId;
  contestId: DatabaseId | null;
  collectorSourceContestId?: DatabaseId | null;
  collectorRunId?: DatabaseId | null;
  receivedAt: string;
  messageKind: string;
  payload: Uint8Array;
  request?: {
    method?: string;
    path?: string;
    responseStatus?: number;
    contentType?: string;
    headers?: Record<string, unknown>;
  };
  metadata?: JsonValue;
}

export interface RedactedReceipt extends CollectorReceipt {
  payloadRedacted: Uint8Array;
  payloadSha256: Uint8Array;
  redactionMetadata: JsonValue | null;
  requestPathRedacted: string | null;
  responseHeadersRedacted: JsonValue | null;
}

export interface BandObservation {
  band: string;
  mode: string;
  qso: string | null;
  points: string | null;
  mult1: string | null;
  mult2: string | null;
}

export interface NormalizedScoreObservation {
  sourceId: DatabaseId;
  contestId: DatabaseId;
  normalizedCallsign: string;
  displayCallsign: string;
  categoryId: DatabaseId | null;
  categoryRaw: JsonValue | null;
  sourceTimestamp: string | null;
  sourceTimestampRaw: string | null;
  sourceTimestampQuality: string | null;
  score: string | null;
  qsoTotal: string | null;
  pointsTotal: string | null;
  multTotal: string | null;
  rawMetrics: JsonValue | null;
  /** Only source fields deliberately admitted to snapshot identity. */
  fingerprintEvidence: JsonValue | null;
  bands: BandObservation[];
}

export interface BatchParseResult {
  observations: NormalizedScoreObservation[];
  rejected: Array<{ index: number; error: string }>;
}

export type ObservationPersistenceResult =
  | {
      outcome: "ACCEPTED";
      entryId: DatabaseId;
      snapshotId: DatabaseId;
    }
  | {
      outcome: "DUPLICATE";
      entryId: DatabaseId;
    }
  | {
      outcome: "REJECTED";
      reason: string;
    };

export type CanonicalReconciliationResult =
  | { outcome: "CANONICAL_INITIAL"; canonicalEventId: DatabaseId }
  | { outcome: "CANONICAL_ADVANCED"; canonicalEventId: DatabaseId }
  | { outcome: "OUT_OF_ORDER" }
  | { outcome: "DEFERRED_CROSS_SOURCE_POLICY" }
  | { outcome: "INELIGIBLE_TIMESTAMP" };
export interface PayloadAdapter {
  parse(receipt: RedactedReceipt): BatchParseResult;
}
export interface ReceiptResult {
  rawMessageId: DatabaseId;
  status: RawMessageStatus;
  observationCount: number;
  acceptedCount: number;
  duplicateCount: number;
  rejectedCount: number;
}
