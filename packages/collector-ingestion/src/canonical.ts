import { createHash } from "node:crypto";
import type { JsonValue } from "@araucaria/database";
import type {
  BandObservation,
  NormalizedScoreObservation,
  RedactedReceipt,
} from "./types.js";

const sensitive =
  /authorization|cookie|password|passwd|token|secret|api[_-]?key|^auth$/i;

export function redactReceipt(
  receipt: import("./types.js").CollectorReceipt,
): RedactedReceipt {
  const text = new TextDecoder().decode(receipt.payload);
  const parsed = tryJson(text);
  const redacted = parsed === undefined ? text : redactValue(parsed);
  const encoded = new TextEncoder().encode(
    typeof redacted === "string" ? redacted : JSON.stringify(redacted),
  );
  return {
    ...receipt,
    payloadRedacted: encoded,
    payloadSha256: sha256(receipt.payload),
    redactionMetadata: parsed === undefined ? null : { redacted_keys: true },
    requestPathRedacted: receipt.request?.path
      ? redactPath(receipt.request.path)
      : null,
    responseHeadersRedacted: receipt.request?.headers
      ? redactValue(receipt.request.headers)
      : null,
  };
}

export function normalizedFingerprint(
  observation: NormalizedScoreObservation,
): Uint8Array {
  const value = {
    version: 1,
    source_id: observation.sourceId,
    contest_id: observation.contestId,
    normalized_callsign: observation.normalizedCallsign,
    category_id: observation.categoryId,
    category_raw: observation.categoryRaw,
    source_timestamp: observation.sourceTimestamp,
    source_timestamp_raw: observation.sourceTimestampRaw,
    source_timestamp_quality: observation.sourceTimestampQuality,
    score: observation.score,
    qso_total: observation.qsoTotal,
    points_total: observation.pointsTotal,
    mult_total: observation.multTotal,
    source_evidence: observation.fingerprintEvidence,
    bands: [...observation.bands]
      .sort(compareBand)
      .map((band) => ({ ...band })),
  };
  return sha256(new TextEncoder().encode(stableJson(value)));
}

export function stableJson(value: unknown): string {
  if (value === null || typeof value !== "object") return JSON.stringify(value);
  if (Array.isArray(value)) return `[${value.map(stableJson).join(",")}]`;
  const object = value as Record<string, unknown>;
  return `{${Object.keys(object)
    .sort()
    .map((key) => `${JSON.stringify(key)}:${stableJson(object[key])}`)
    .join(",")}}`;
}
export function sha256(value: Uint8Array): Uint8Array {
  return createHash("sha256").update(value).digest();
}
function compareBand(a: BandObservation, b: BandObservation): number {
  return a.band.localeCompare(b.band) || a.mode.localeCompare(b.mode);
}
function tryJson(value: string): unknown | undefined {
  try {
    return JSON.parse(value);
  } catch {
    return undefined;
  }
}
function redactValue(value: unknown): JsonValue {
  if (Array.isArray(value)) return value.map(redactValue);
  if (value && typeof value === "object")
    return Object.fromEntries(
      Object.entries(value as Record<string, unknown>)
        .filter(([key]) => !sensitive.test(key))
        .map(([key, entry]) => [key, redactValue(entry)]),
    );
  if (
    typeof value === "string" ||
    typeof value === "number" ||
    typeof value === "boolean" ||
    value === null
  )
    return value;
  return String(value);
}
function redactPath(path: string): string {
  return path.replace(
    /([?&])([^=&]*?(?:auth|token|key|password)[^=&]*)=[^&]*/gi,
    "$1$2=[REDACTED]",
  );
}
