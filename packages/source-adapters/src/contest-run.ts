export const CONTEST_RUN_BASE_URL = "https://contest.run";

export type ContestRunJsonPrimitive = boolean | null | number | string;
export type ContestRunJsonValue =
  | ContestRunJsonPrimitive
  | ContestRunJsonObject
  | ContestRunJsonValue[];
export interface ContestRunJsonObject {
  [field: string]: ContestRunJsonValue;
}

export type ContestRunEndpointName =
  | "nearest"
  | "month"
  | "categories"
  | "displayscore";

export type ContestRunScalar = string | number | boolean | null;

export interface ContestRunDiscoveryResponse {
  records: readonly ContestRunDiscoveryRecord[];
}

export interface ContestRunCategoriesResponse {
  records: readonly ContestRunCategoryRecord[];
}

export interface ContestRunDisplayScoreResponse {
  records: readonly ContestRunScoreRecord[];
}

/**
 * Fields observed in the 2026-09-11 read-only POC. `dat` deliberately has no
 * date semantics here: its year, timezone, and encoding remain unresolved.
 */
export interface ContestRunDiscoveryRecord {
  testid: number;
  contest?: string;
  dat?: number;
  startday?: number;
  starttime?: string;
  finishday?: number;
  finishtime?: string;
  name?: string;
  [field: string]: unknown;
}

/**
 * Observed category rows carry numeric codes alongside display labels. Sentinel
 * values are source evidence and must be interpreted by the normalizer, not here.
 */
export interface ContestRunCategoryRecord {
  catid?: number;
  testid?: number;
  ctdom?: string | null;
  "ct-dom"?: string | null;
  ctwac?: number;
  "ct-wac"?: string;
  ctoper?: number;
  "ct-oper"?: string;
  cttrans?: number;
  "ct-trans"?: string;
  ctband?: number;
  "ct-band"?: string;
  ctpwr?: number;
  "ct-power"?: string;
  ctmode?: number;
  "ct-mode"?: string;
  ctassis?: number;
  "ct-assis"?: string;
  ctstatn?: number;
  "ct-statn"?: string;
  cttime?: number;
  "ct-time"?: string;
  ctoverl?: number;
  "ct-overl"?: string;
  categoryname?: string;
  wherescores?: string;
  [field: string]: unknown;
}

/**
 * Observed score rows. These are external boundary types, not canonical types.
 * Fields without confirmed semantics remain raw even when their observed type is
 * known. Parsed DTOs recursively remove potentially sensitive `auth` fields.
 */
export interface ContestRunScoreRecord {
  rownum?: number;
  sign?: string;
  date?: string;
  score?: number;
  qtotal?: number;
  ptotal?: number;
  mtotal?: number;
  qtotalc?: number;
  qtotalp?: number;
  qtotalr?: number;
  q160?: number;
  q80?: number;
  q40?: number;
  q20?: number;
  q15?: number;
  q10?: number;
  p160?: number;
  p80?: number;
  p40?: number;
  p20?: number;
  p15?: number;
  p10?: number;
  m160?: number;
  m80?: number;
  m40?: number;
  m20?: number;
  m15?: number;
  m10?: number;
  mctotal?: number;
  mptotal?: number;
  mstotal?: number;
  mztotal?: number;
  soft?: string | number;
  [field: string]: ContestRunScalar | unknown;
}

/** Parses an observed JSON HTTP body without performing I/O or persistence. */
export function parseContestRunDiscoveryResponse(
  body: string | Uint8Array,
): ContestRunDiscoveryResponse {
  const records = parseArrayBody(body, "contest discovery");
  return {
    records: records.flatMap((record) => {
      if (!isJsonObject(record) || !isContestRunTestId(record.testid))
        return [];
      return [record as ContestRunDiscoveryRecord];
    }),
  };
}

/** Parses an observed JSON HTTP body without interpreting category semantics. */
export function parseContestRunCategoriesResponse(
  body: string | Uint8Array,
): ContestRunCategoriesResponse {
  const records = parseArrayBody(body, "contest categories");
  return {
    records: records.flatMap((record) =>
      isJsonObject(record) ? [record as ContestRunCategoryRecord] : [],
    ),
  };
}

/**
 * Parses a displayscore response into source DTOs. Invalid row shapes remain
 * positional empty DTOs so collector normalization can reject only those rows.
 */
export function parseContestRunDisplayScoreResponse(
  body: string | Uint8Array,
): ContestRunDisplayScoreResponse {
  const records = parseArrayBody(body, "displayscore");
  return {
    records: records.map((record) =>
      isJsonObject(record)
        ? (redactContestRunAuth(record) as ContestRunScoreRecord)
        : {},
    ),
  };
}

/**
 * Removes `auth` keys case-insensitively from JSON-shaped source evidence.
 * This is deliberately recursive: source-specific nested diagnostic objects
 * must not carry credentials across the source-adapter boundary either.
 */
export function redactContestRunAuth(value: unknown): ContestRunJsonValue {
  if (Array.isArray(value)) return value.map(redactContestRunAuth);
  if (isJsonObject(value)) {
    return Object.fromEntries(
      Object.entries(value)
        .filter(([field]) => field.toLowerCase() !== "auth")
        .map(([field, nested]) => [field, redactContestRunAuth(nested)]),
    );
  }
  if (
    value === null ||
    typeof value === "boolean" ||
    typeof value === "number" ||
    typeof value === "string"
  ) {
    return value;
  }
  return String(value);
}

export function isContestRunTestId(value: unknown): value is number {
  return (
    typeof value === "number" &&
    Number.isSafeInteger(value) &&
    value > 0 &&
    value <= 2_147_483_647
  );
}

export function contestRunEndpoint(
  endpoint: ContestRunEndpointName,
  value?: number,
): string {
  switch (endpoint) {
    case "nearest":
      return new URL("/api/contest/nearest", CONTEST_RUN_BASE_URL).toString();
    case "month":
      if (!isMonth(value)) {
        throw new Error("contest.run month must be an integer from 1 to 12.");
      }
      return new URL(
        `/api/contest/month/${value}`,
        CONTEST_RUN_BASE_URL,
      ).toString();
    case "categories":
      return new URL(
        `/api/category/contest/${requireTestId(value)}`,
        CONTEST_RUN_BASE_URL,
      ).toString();
    case "displayscore":
      return new URL(
        `/api/displayscore/${requireTestId(value)}`,
        CONTEST_RUN_BASE_URL,
      ).toString();
  }
}

function isMonth(value: unknown): value is number {
  return (
    typeof value === "number" &&
    Number.isInteger(value) &&
    value >= 1 &&
    value <= 12
  );
}

function requireTestId(value: unknown): number {
  if (!isContestRunTestId(value)) {
    throw new Error("contest.run testid must be a positive 32-bit integer.");
  }

  return value;
}

function parseArrayBody(
  body: string | Uint8Array,
  endpoint: string,
): ContestRunJsonValue[] {
  let value: unknown;
  try {
    value = JSON.parse(
      typeof body === "string" ? body : new TextDecoder().decode(body),
    );
  } catch {
    throw new Error(`contest.run ${endpoint} response is not valid JSON.`);
  }
  if (!Array.isArray(value)) {
    throw new Error(`contest.run ${endpoint} response must be a JSON array.`);
  }
  return value as ContestRunJsonValue[];
}

function isJsonObject(value: unknown): value is ContestRunJsonObject {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}
