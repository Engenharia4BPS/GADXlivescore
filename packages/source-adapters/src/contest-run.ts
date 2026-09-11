export const CONTEST_RUN_BASE_URL = "https://contest.run";

export type ContestRunEndpointName =
  | "nearest"
  | "month"
  | "categories"
  | "displayscore";

export type ContestRunScalar = string | number | boolean | null;

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
 * known. The potentially sensitive `auth` field must never leave the adapter.
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
  auth?: string;
  [field: string]: ContestRunScalar | unknown;
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
