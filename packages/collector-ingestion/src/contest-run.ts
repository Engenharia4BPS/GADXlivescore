import type { ContestRunScoreRecord } from "@araucaria/source-adapters";
import type {
  BatchParseResult,
  NormalizedScoreObservation,
  RedactedReceipt,
} from "./types.js";

const bands = ["160", "80", "40", "20", "15", "10"];
export function normalizeContestRunPayload(
  receipt: RedactedReceipt,
): BatchParseResult {
  const value: unknown = JSON.parse(
    new TextDecoder().decode(receipt.payloadRedacted),
  );
  if (!Array.isArray(value))
    throw new Error("contest.run displayscore payload must be an array.");
  const observations: NormalizedScoreObservation[] = [];
  const rejected: BatchParseResult["rejected"] = [];
  value.forEach((row, index) => {
    try {
      observations.push(
        normalizeContestRunRow(row as ContestRunScoreRecord, receipt),
      );
    } catch (error) {
      rejected.push({
        index,
        error: error instanceof Error ? error.message : "Invalid row.",
      });
    }
  });
  return { observations, rejected };
}
export function normalizeContestRunRow(
  row: ContestRunScoreRecord,
  receipt: RedactedReceipt,
): NormalizedScoreObservation {
  const callsign = typeof row.sign === "string" ? row.sign.trim() : "";
  if (!callsign) throw new Error("contest.run row has no callsign.");
  const sourceTimestampRaw =
    typeof row.date === "string" && row.date.trim() ? row.date.trim() : null;
  const metric = (name: keyof ContestRunScoreRecord): string | null =>
    integerString(row[name]);
  const raw = Object.fromEntries(
    Object.entries(row).filter(([key]) => key !== "auth"),
  );
  return {
    sourceId: receipt.sourceId,
    contestId: requiredContest(receipt),
    normalizedCallsign: callsign.toUpperCase(),
    displayCallsign: callsign,
    categoryId: null,
    categoryRaw: null,
    sourceTimestamp: null,
    sourceTimestampRaw,
    sourceTimestampQuality: sourceTimestampRaw ? "UNZONED_SOURCE_TEXT" : null,
    score: metric("score"),
    qsoTotal: metric("qtotal"),
    pointsTotal: metric("ptotal"),
    multTotal: metric("mtotal"),
    rawMetrics: raw as import("@araucaria/database").JsonValue,
    fingerprintEvidence: {
      soft:
        row.soft === undefined || row.soft === null ? null : String(row.soft),
      qtotalc: row.qtotalc ?? null,
      qtotalp: row.qtotalp ?? null,
      qtotalr: row.qtotalr ?? null,
    },
    bands: bands
      .map((band) => ({
        band: `${band}m`,
        mode: "ALL",
        qso: metric(`q${band}` as keyof ContestRunScoreRecord),
        points: metric(`p${band}` as keyof ContestRunScoreRecord),
        mult1: metric(`m${band}` as keyof ContestRunScoreRecord),
        mult2: null,
      }))
      .filter((band) =>
        Object.values(band).some((v) => v !== null && v !== "ALL"),
      ),
  };
}
function requiredContest(receipt: RedactedReceipt): string {
  if (!receipt.contestId)
    throw new Error("contest.run receipt requires a resolved contest id.");
  return receipt.contestId;
}
function integerString(value: unknown): string | null {
  if (value === undefined || value === null || value === "") return null;
  const number =
    typeof value === "number"
      ? value
      : typeof value === "string"
        ? Number(value)
        : NaN;
  if (!Number.isSafeInteger(number))
    throw new Error("contest.run metric must be a safe integer when present.");
  return String(number);
}
