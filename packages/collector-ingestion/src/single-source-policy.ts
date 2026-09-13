import type { DatabaseId } from "@araucaria/database";

export interface CanonicalCandidate {
  acceptanceStatus: string;
  entryId: DatabaseId;
  snapshotId: DatabaseId;
  sourceId: DatabaseId;
  sourceTimestamp: string | null;
  sourceTimestampQuality: string | null;
}

export interface CurrentCanonicalState {
  effectiveAt: string;
  eventId: DatabaseId;
  snapshotId: DatabaseId;
  sourceId: DatabaseId;
}

export type SingleSourcePolicyDecision =
  | { outcome: "CANONICAL_INITIAL" }
  | { outcome: "CANONICAL_ADVANCED" }
  | { outcome: "OUT_OF_ORDER" }
  | { outcome: "DEFERRED_CROSS_SOURCE_POLICY" }
  | { outcome: "INELIGIBLE_TIMESTAMP" };

/** Phase 2D policy only; later multi-source reconciliation replaces this boundary. */
export function decideSingleSourceSequence(
  candidate: CanonicalCandidate,
  current: CurrentCanonicalState | undefined,
): SingleSourcePolicyDecision {
  if (
    candidate.acceptanceStatus !== "ACCEPTED" ||
    candidate.sourceTimestamp === null ||
    candidate.sourceTimestampQuality !== "CONFIRMED_UTC"
  ) {
    return { outcome: "INELIGIBLE_TIMESTAMP" };
  }
  if (!current) return { outcome: "CANONICAL_INITIAL" };
  if (candidate.sourceId !== current.sourceId)
    return { outcome: "DEFERRED_CROSS_SOURCE_POLICY" };
  if (
    compareConfirmedUtcDateTimes(
      candidate.sourceTimestamp,
      current.effectiveAt,
    ) < 0
  )
    return { outcome: "OUT_OF_ORDER" };
  return { outcome: "CANONICAL_ADVANCED" };
}

/**
 * Compares MySQL DATETIME(6) values that represent confirmed UTC timestamps.
 * Fractional seconds are normalized to microseconds before comparison.
 */
function compareConfirmedUtcDateTimes(left: string, right: string): number {
  const leftMicroseconds = parseConfirmedUtcDateTime(left);
  const rightMicroseconds = parseConfirmedUtcDateTime(right);
  if (leftMicroseconds < rightMicroseconds) return -1;
  if (leftMicroseconds > rightMicroseconds) return 1;
  return 0;
}

function parseConfirmedUtcDateTime(value: string): bigint {
  const match =
    /^([1-9]\d{3})-(\d{2})-(\d{2}) (\d{2}):(\d{2}):(\d{2})(?:\.(\d{1,6}))?$/.exec(
      value,
    );
  if (!match) throw new Error(`Invalid confirmed UTC timestamp: ${value}`);
  const year = timestampPart(match[1], value);
  const month = timestampPart(match[2], value);
  const day = timestampPart(match[3], value);
  const hour = timestampPart(match[4], value);
  const minute = timestampPart(match[5], value);
  const second = timestampPart(match[6], value);
  const fraction = (match[7] ?? "").padEnd(6, "0");
  const milliseconds = Number(fraction.slice(0, 3));
  const microsecondRemainder = Number(fraction.slice(3));
  const instant = new Date(
    Date.UTC(year, month - 1, day, hour, minute, second, milliseconds),
  );
  if (
    instant.getUTCFullYear() !== year ||
    instant.getUTCMonth() !== month - 1 ||
    instant.getUTCDate() !== day ||
    instant.getUTCHours() !== hour ||
    instant.getUTCMinutes() !== minute ||
    instant.getUTCSeconds() !== second
  ) {
    throw new Error(`Invalid confirmed UTC timestamp: ${value}`);
  }
  return BigInt(instant.getTime()) * 1000n + BigInt(microsecondRemainder);
}

function timestampPart(value: string | undefined, timestamp: string): number {
  if (value === undefined)
    throw new Error(`Invalid confirmed UTC timestamp: ${timestamp}`);
  return Number(value);
}
