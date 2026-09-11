import { createHash } from "node:crypto";
import { mkdir, writeFile } from "node:fs/promises";
import { resolve } from "node:path";

import {
  CONTEST_RUN_BASE_URL,
  contestRunEndpoint,
  isContestRunTestId,
} from "@araucaria/source-adapters";

const MAX_RESPONSE_BYTES = 2 * 1024 * 1024;
const REQUEST_TIMEOUT_MS = 20_000;
const MIN_REQUEST_DELAY_MS = 500;
const OBSERVATION_GAP_MS = 900_000;
const MAX_REQUESTS = 9;
const MAX_CANDIDATES = 2;
const USER_AGENT =
  "Araucaria-LiveScore-POC/0.1 (read-only; contact: araucariadx.com)";

type JsonValue =
  | null
  | boolean
  | number
  | string
  | JsonValue[]
  | { [key: string]: JsonValue };

type JsonObject = { [key: string]: JsonValue };
type Scalar = null | boolean | number | string;
type HypothesisResult = "SUPPORTED" | "CONTRADICTED" | "UNRESOLVED";
type ObservationPhase = "T0" | "T_PLUS_15M";

interface PocConfig {
  months: readonly [number, number, number];
  candidateCount: number;
  maxRequests: number;
  requestDelayMs: number;
  observationGapMs: number;
  outputDirectory: string;
}

interface ResponseObservation {
  label: string;
  endpoint: string;
  method: "GET";
  requestStartedAtUtc: string;
  responseReceivedAtUtc: string;
  durationMs: number;
  status: number | null;
  statusText: string | null;
  redirectLocation: string | null;
  httpDate: string | null;
  headers: Record<string, string>;
  contentType: string | null;
  responseBytes: number | null;
  payloadSha256: string | null;
  artifact: string | null;
  parsingStatus:
    | "NOT_ATTEMPTED"
    | "JSON"
    | "INVALID_JSON"
    | "NON_JSON"
    | "TOO_LARGE";
  error: string | null;
}

interface DiscoveryContest {
  testId: number;
  name: string | null;
  contest: string | null;
  dat: Scalar;
  startday: Scalar;
  starttime: Scalar;
  finishday: Scalar;
  finishtime: Scalar;
  source: string;
  sourcePosition: number;
}

interface SelectedCandidate {
  testId: number;
  name: string | null;
  selection: "NEAREST_MONTH_9_INTERSECTION" | "NEAREST_FALLBACK";
  nearestPosition: number;
}

interface MembershipRow {
  testId: number;
  name: string | null;
  nearestT0: boolean;
  month8: boolean;
  month9: boolean;
  month10: boolean;
  nearestTPlus15m: boolean;
}

interface ScoreRow {
  callsign: string | null;
  rowIndex: number;
  date: Scalar;
  score: Scalar;
  qso: Scalar;
  mult: Scalar;
  bands: Record<string, Scalar>;
}

interface ScoreSnapshot {
  testId: number;
  phase: ObservationPhase;
  label: string;
  rowCount: number;
  rows: ScoreRow[];
  newestSourceDate: string | null;
  httpDate: string | null;
  requestStartedAtUtc: string | null;
  responseReceivedAtUtc: string | null;
  naiveNewestSourceLagToHttpDateMs: number | null;
  naiveNewestSourceLagToReceiptMs: number | null;
}

interface ScoreChange {
  callsign: string | null;
  rowIndexT0: number;
  rowIndexTPlus15m: number;
  date: { before: Scalar; after: Scalar } | null;
  score: { before: Scalar; after: Scalar } | null;
  qso: { before: Scalar; after: Scalar } | null;
  mult: { before: Scalar; after: Scalar } | null;
  bands: Record<string, { before: Scalar; after: Scalar }>;
}

interface StaleDistribution {
  testId: number;
  phase: ObservationPhase;
  rowCount: number;
  missingDate: number;
  explicitOffset: number;
  noOffset: number;
  unparseable: number;
  conservativelyOlderThanFiveMinutes: number;
  timezoneDependent: number;
  futureOrIndeterminate: number;
}

interface HypothesisAssessment {
  id: "H1" | "H2" | "H3" | "H4";
  result: HypothesisResult;
  rationale: string;
}

interface PocReport {
  poc: "contest.run phase 0.7 read-only calendar and freshness observation";
  baseUrl: string;
  startedAtUtc: string;
  completedAtUtc: string;
  configuration: PocConfig;
  safeguards: {
    method: "GET only";
    retries: "none";
    redirects: "not followed";
    maxResponseBytes: number;
    maxRequests: number;
    userAgent: string;
    candidateIds: "discovery responses only";
    rawPayloadStorage: "sanitized artifacts only";
  };
  requestCount: number;
  observations: ResponseObservation[];
  selectedCandidates: SelectedCandidate[];
  discoveryMembership: MembershipRow[];
  discoveryFieldEvidence: DiscoveryContest[];
  scoreSnapshots: ScoreSnapshot[];
  scoreChanges: ScoreChange[];
  staleDistribution: StaleDistribution[];
  hypotheses: HypothesisAssessment[];
}

interface BodyReadResult {
  bytes: Uint8Array | null;
  tooLarge: boolean;
}

class ReadOnlyContestRunClient {
  private readonly observations: ResponseObservation[] = [];

  constructor(private readonly config: PocConfig) {}

  get requestCount(): number {
    return this.observations.length;
  }

  get records(): readonly ResponseObservation[] {
    return this.observations;
  }

  async observe(
    label: string,
    endpoint: string,
    outputDirectory: string,
  ): Promise<JsonValue | null> {
    if (this.observations.length >= this.config.maxRequests) {
      return null;
    }

    if (this.observations.length > 0) {
      await delay(this.config.requestDelayMs);
    }

    const requestStartedAtUtc = new Date().toISOString();
    const startedAtMs = Date.now();
    let response: Response | null = null;
    let bytes: Uint8Array | null = null;
    let tooLarge = false;
    let error: string | null = null;

    try {
      response = await fetch(endpoint, {
        method: "GET",
        redirect: "manual",
        headers: {
          Accept: "application/json",
          "User-Agent": USER_AGENT,
        },
        signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
      });

      const body = await readBoundedBody(response);
      bytes = body.bytes;
      tooLarge = body.tooLarge;
    } catch (caught) {
      error = sanitizeError(caught);
    }

    const responseReceivedAtUtc = new Date().toISOString();
    const observation = createObservation({
      label,
      endpoint,
      requestStartedAtUtc,
      responseReceivedAtUtc,
      durationMs: Date.now() - startedAtMs,
      response,
      bytes,
      tooLarge,
      error,
    });

    let parsed: JsonValue | null = null;
    if (bytes && !tooLarge) {
      try {
        parsed = JSON.parse(new TextDecoder().decode(bytes)) as JsonValue;
        const artifact = `${safeArtifactName(label)}.json`;
        await writeJson(
          resolve(outputDirectory, artifact),
          sanitizeJson(parsed),
        );
        observation.artifact = artifact;
        observation.parsingStatus = "JSON";
      } catch (caught) {
        observation.parsingStatus = isJsonContentType(observation.contentType)
          ? "INVALID_JSON"
          : "NON_JSON";
        if (observation.parsingStatus === "INVALID_JSON") {
          observation.error = sanitizeError(caught);
        }
      }
    }

    this.observations.push(observation);
    console.log(
      `${observation.method} ${endpoint} -> ${observation.status ?? "NETWORK_ERROR"} (${observation.durationMs} ms)`,
    );
    return parsed;
  }

  find(label: string): ResponseObservation | null {
    return (
      this.observations.find((observation) => observation.label === label) ??
      null
    );
  }
}

async function main(): Promise<void> {
  const config = parseArguments(process.argv.slice(2));
  const outputDirectory = resolve(config.outputDirectory);
  const startedAtUtc = new Date().toISOString();
  const client = new ReadOnlyContestRunClient(config);

  await mkdir(outputDirectory, { recursive: true });

  const nearestT0 = await client.observe(
    "discovery-nearest-t0",
    contestRunEndpoint("nearest"),
    outputDirectory,
  );
  const nearestT0Records = extractDiscoveryContests(nearestT0, "nearest-t0");
  const calendarRecords = new Map<number, DiscoveryContest[]>();

  for (const month of config.months) {
    const payload = await client.observe(
      `discovery-month-${String(month).padStart(2, "0")}-t0`,
      contestRunEndpoint("month", month),
      outputDirectory,
    );
    calendarRecords.set(
      month,
      extractDiscoveryContests(payload, `month-${month}`),
    );
  }

  const candidates = selectCandidates(
    nearestT0Records,
    calendarRecords.get(9) ?? [],
    config.candidateCount,
  );
  const scorePayloads = new Map<string, JsonValue | null>();

  for (const candidate of candidates) {
    const label = `displayscore-${candidate.testId}-t0`;
    scorePayloads.set(
      label,
      await client.observe(
        label,
        contestRunEndpoint("displayscore", candidate.testId),
        outputDirectory,
      ),
    );
  }

  await delay(config.observationGapMs);

  const nearestTPlus15m = await client.observe(
    "discovery-nearest-t-plus-15m",
    contestRunEndpoint("nearest"),
    outputDirectory,
  );
  const nearestTPlus15mRecords = extractDiscoveryContests(
    nearestTPlus15m,
    "nearest-t-plus-15m",
  );

  for (const candidate of candidates) {
    const label = `displayscore-${candidate.testId}-t-plus-15m`;
    scorePayloads.set(
      label,
      await client.observe(
        label,
        contestRunEndpoint("displayscore", candidate.testId),
        outputDirectory,
      ),
    );
  }

  const scoreSnapshots = buildScoreSnapshots(candidates, scorePayloads, client);
  const discoveryFieldEvidence = [
    ...nearestT0Records,
    ...config.months.flatMap((month) => calendarRecords.get(month) ?? []),
    ...nearestTPlus15mRecords,
  ];
  const report: PocReport = {
    poc: "contest.run phase 0.7 read-only calendar and freshness observation",
    baseUrl: CONTEST_RUN_BASE_URL,
    startedAtUtc,
    completedAtUtc: new Date().toISOString(),
    configuration: config,
    safeguards: {
      method: "GET only",
      retries: "none",
      redirects: "not followed",
      maxResponseBytes: MAX_RESPONSE_BYTES,
      maxRequests: MAX_REQUESTS,
      userAgent: USER_AGENT,
      candidateIds: "discovery responses only",
      rawPayloadStorage: "sanitized artifacts only",
    },
    requestCount: client.requestCount,
    observations: [...client.records],
    selectedCandidates: candidates,
    discoveryMembership: buildMembershipMatrix(
      nearestT0Records,
      calendarRecords,
      nearestTPlus15mRecords,
    ),
    discoveryFieldEvidence,
    scoreSnapshots,
    scoreChanges: compareScoreSnapshots(scoreSnapshots),
    staleDistribution: buildStaleDistribution(scoreSnapshots),
    hypotheses: assessHypotheses(
      calendarRecords,
      scoreSnapshots,
      compareScoreSnapshots(scoreSnapshots),
    ),
  };

  await writeJson(resolve(outputDirectory, "report.json"), report);
  await writeFile(
    resolve(outputDirectory, "report.md"),
    renderMarkdown(report),
    "utf8",
  );
  console.log(`Observation report written to ${outputDirectory}`);
}

function parseArguments(args: string[]): PocConfig {
  const values = new Map<string, string>();

  for (let index = 0; index < args.length; index += 1) {
    const argument = args[index];
    if (argument === "--") {
      continue;
    }
    if (argument === "--help") {
      printUsage();
      process.exit(0);
    }
    if (!argument?.startsWith("--")) {
      throw new Error(`Unexpected argument: ${argument ?? ""}`);
    }

    const value = args[index + 1];
    if (!value || value.startsWith("--")) {
      throw new Error(`Missing value for ${argument}.`);
    }
    values.set(argument, value);
    index += 1;
  }

  const months = monthListOption(values.get("--months") ?? "8,9,10");
  const candidateCount = integerOption(
    values,
    "--candidate-count",
    2,
    1,
    MAX_CANDIDATES,
  );
  const maxRequests = integerOption(
    values,
    "--max-requests",
    MAX_REQUESTS,
    7,
    MAX_REQUESTS,
  );
  const requestDelayMs = integerOption(
    values,
    "--request-delay-ms",
    1_000,
    MIN_REQUEST_DELAY_MS,
    60_000,
  );
  const observationGapMs = integerOption(
    values,
    "--observation-gap-ms",
    OBSERVATION_GAP_MS,
    OBSERVATION_GAP_MS,
    OBSERVATION_GAP_MS,
  );
  const outputDirectory =
    values.get("--output-dir") ?? defaultOutputDirectory();

  const knownOptions = new Set([
    "--months",
    "--candidate-count",
    "--max-requests",
    "--request-delay-ms",
    "--observation-gap-ms",
    "--output-dir",
  ]);
  for (const option of values.keys()) {
    if (!knownOptions.has(option)) {
      throw new Error(`Unsupported option: ${option}`);
    }
  }

  const plannedRequests = 5 + candidateCount * 2;
  if (maxRequests < plannedRequests) {
    throw new Error(
      `--max-requests must be at least ${plannedRequests} for ${candidateCount} candidates.`,
    );
  }

  return {
    months,
    candidateCount,
    maxRequests,
    requestDelayMs,
    observationGapMs,
    outputDirectory,
  };
}

function monthListOption(value: string): readonly [number, number, number] {
  const months = value.split(",").map((part) => Number(part));
  if (
    months.length !== 3 ||
    months.some(
      (month) => !Number.isInteger(month) || month < 1 || month > 12,
    ) ||
    new Set(months).size !== 3 ||
    !months.includes(9)
  ) {
    throw new Error(
      "--months must be three distinct months from 1 to 12 and include month 9.",
    );
  }

  return [months[0] as number, months[1] as number, months[2] as number];
}

function integerOption(
  values: ReadonlyMap<string, string>,
  option: string,
  fallback: number,
  minimum: number,
  maximum: number,
): number {
  const raw = values.get(option);
  if (raw === undefined) {
    return fallback;
  }
  const parsed = Number(raw);
  if (!Number.isInteger(parsed) || parsed < minimum || parsed > maximum) {
    throw new Error(
      `${option} must be an integer from ${minimum} to ${maximum}.`,
    );
  }
  return parsed;
}

function defaultOutputDirectory(): string {
  const timestamp = new Date().toISOString().replaceAll(":", "-");
  return `runtime/contest-run-poc/phase-0-7-${timestamp}`;
}

function selectCandidates(
  nearest: readonly DiscoveryContest[],
  month9: readonly DiscoveryContest[],
  maximum: number,
): SelectedCandidate[] {
  const month9Ids = new Set(month9.map((contest) => contest.testId));
  const selected: SelectedCandidate[] = [];
  const selectedIds = new Set<number>();

  for (const contest of nearest) {
    if (!month9Ids.has(contest.testId) || selectedIds.has(contest.testId)) {
      continue;
    }
    selected.push({
      testId: contest.testId,
      name: contest.name,
      selection: "NEAREST_MONTH_9_INTERSECTION",
      nearestPosition: contest.sourcePosition,
    });
    selectedIds.add(contest.testId);
    if (selected.length === maximum) {
      return selected;
    }
  }

  for (const contest of nearest) {
    if (selectedIds.has(contest.testId)) {
      continue;
    }
    selected.push({
      testId: contest.testId,
      name: contest.name,
      selection: "NEAREST_FALLBACK",
      nearestPosition: contest.sourcePosition,
    });
    selectedIds.add(contest.testId);
    if (selected.length === maximum) {
      return selected;
    }
  }

  return selected;
}

function extractDiscoveryContests(
  payload: JsonValue | null,
  source: string,
): DiscoveryContest[] {
  if (!Array.isArray(payload)) {
    return [];
  }

  const records: DiscoveryContest[] = [];
  for (const [sourcePosition, value] of payload.entries()) {
    if (!isJsonObject(value) || !isContestRunTestId(value.testid)) {
      continue;
    }
    records.push({
      testId: value.testid,
      name: stringOrNull(value.name),
      contest: stringOrNull(value.contest),
      dat: scalarOrNull(value.dat),
      startday: scalarOrNull(value.startday),
      starttime: scalarOrNull(value.starttime),
      finishday: scalarOrNull(value.finishday),
      finishtime: scalarOrNull(value.finishtime),
      source,
      sourcePosition,
    });
  }
  return records;
}

function buildMembershipMatrix(
  nearestT0: readonly DiscoveryContest[],
  calendarRecords: ReadonlyMap<number, readonly DiscoveryContest[]>,
  nearestTPlus15m: readonly DiscoveryContest[],
): MembershipRow[] {
  const rows = new Map<number, MembershipRow>();
  const orderedIds: number[] = [];
  const sources: readonly [
    string,
    readonly DiscoveryContest[],
    keyof Omit<MembershipRow, "testId" | "name">,
  ][] = [
    ["nearest-t0", nearestT0, "nearestT0"],
    ["month-8", calendarRecords.get(8) ?? [], "month8"],
    ["month-9", calendarRecords.get(9) ?? [], "month9"],
    ["month-10", calendarRecords.get(10) ?? [], "month10"],
    ["nearest-t-plus-15m", nearestTPlus15m, "nearestTPlus15m"],
  ];

  for (const [, contests, column] of sources) {
    for (const contest of contests) {
      let row = rows.get(contest.testId);
      if (!row) {
        row = {
          testId: contest.testId,
          name: contest.name,
          nearestT0: false,
          month8: false,
          month9: false,
          month10: false,
          nearestTPlus15m: false,
        };
        rows.set(contest.testId, row);
        orderedIds.push(contest.testId);
      }
      if (row.name === null && contest.name !== null) {
        row.name = contest.name;
      }
      row[column] = true;
    }
  }

  return orderedIds.map((testId) => rows.get(testId) as MembershipRow);
}

function buildScoreSnapshots(
  candidates: readonly SelectedCandidate[],
  payloads: ReadonlyMap<string, JsonValue | null>,
  client: ReadOnlyContestRunClient,
): ScoreSnapshot[] {
  const snapshots: ScoreSnapshot[] = [];
  for (const candidate of candidates) {
    for (const [phase, suffix] of [
      ["T0", "t0"],
      ["T_PLUS_15M", "t-plus-15m"],
    ] as const) {
      const label = `displayscore-${candidate.testId}-${suffix}`;
      const rows = extractScoreRows(payloads.get(label) ?? null);
      const observation = client.find(label);
      const newestSourceDate = newestSourceDateValue(rows);
      snapshots.push({
        testId: candidate.testId,
        phase,
        label,
        rowCount: rows.length,
        rows,
        newestSourceDate,
        httpDate: observation?.httpDate ?? null,
        requestStartedAtUtc: observation?.requestStartedAtUtc ?? null,
        responseReceivedAtUtc: observation?.responseReceivedAtUtc ?? null,
        naiveNewestSourceLagToHttpDateMs: differenceToDate(
          observation?.httpDate ?? null,
          newestSourceDate,
        ),
        naiveNewestSourceLagToReceiptMs: differenceToDate(
          observation?.responseReceivedAtUtc ?? null,
          newestSourceDate,
        ),
      });
    }
  }
  return snapshots;
}

function extractScoreRows(payload: JsonValue | null): ScoreRow[] {
  if (!Array.isArray(payload)) {
    return [];
  }
  const rows: ScoreRow[] = [];
  for (const [rowIndex, value] of payload.entries()) {
    if (!isJsonObject(value)) {
      continue;
    }
    const bands: Record<string, Scalar> = {};
    for (const [key, fieldValue] of Object.entries(value)) {
      if (/^[qpm]\d+$/.test(key)) {
        bands[key] = scalarOrNull(fieldValue);
      }
    }
    rows.push({
      callsign: stringOrNull(value.sign),
      rowIndex,
      date: scalarOrNull(value.date),
      score: scalarOrNull(value.score),
      qso: scalarOrNull(value.qtotal),
      mult: scalarOrNull(value.mtotal),
      bands,
    });
  }
  return rows;
}

function newestSourceDateValue(rows: readonly ScoreRow[]): string | null {
  const values = rows
    .map((row) => (typeof row.date === "string" ? row.date : null))
    .filter((value): value is string => value !== null)
    .sort();
  return values.at(-1) ?? null;
}

function differenceToDate(
  newer: string | null,
  sourceDate: string | null,
): number | null {
  if (!newer || !sourceDate) {
    return null;
  }
  const newerMs = Date.parse(newer);
  const sourceMs = parseSourceDateAsUtc(sourceDate);
  return Number.isFinite(newerMs) && sourceMs !== null
    ? newerMs - sourceMs
    : null;
}

function compareScoreSnapshots(
  snapshots: readonly ScoreSnapshot[],
): ScoreChange[] {
  const changes: ScoreChange[] = [];
  const byTestId = new Map<number, ScoreSnapshot[]>();
  for (const snapshot of snapshots) {
    const grouped = byTestId.get(snapshot.testId) ?? [];
    grouped.push(snapshot);
    byTestId.set(snapshot.testId, grouped);
  }

  for (const group of byTestId.values()) {
    const t0 = group.find((snapshot) => snapshot.phase === "T0");
    const tPlus15m = group.find((snapshot) => snapshot.phase === "T_PLUS_15M");
    if (!t0 || !tPlus15m) {
      continue;
    }
    const t0Rows = indexScoreRows(t0.rows);
    const tPlus15mRows = indexScoreRows(tPlus15m.rows);
    for (const [key, before] of t0Rows) {
      const after = tPlus15mRows.get(key);
      if (!after) {
        continue;
      }
      const bands = changedBands(before.bands, after.bands);
      const change: ScoreChange = {
        callsign: before.callsign,
        rowIndexT0: before.rowIndex,
        rowIndexTPlus15m: after.rowIndex,
        date: changedValue(before.date, after.date),
        score: changedValue(before.score, after.score),
        qso: changedValue(before.qso, after.qso),
        mult: changedValue(before.mult, after.mult),
        bands,
      };
      if (
        change.date ||
        change.score ||
        change.qso ||
        change.mult ||
        Object.keys(change.bands).length > 0
      ) {
        changes.push(change);
      }
    }
  }
  return changes;
}

function indexScoreRows(rows: readonly ScoreRow[]): Map<string, ScoreRow> {
  const indexed = new Map<string, ScoreRow>();
  for (const row of rows) {
    const identity = row.callsign ?? `missing-callsign-${row.rowIndex}`;
    const duplicateCount = [...indexed.keys()].filter(
      (key) => key === identity,
    ).length;
    indexed.set(
      duplicateCount === 0 ? identity : `${identity}-${row.rowIndex}`,
      row,
    );
  }
  return indexed;
}

function changedBands(
  before: Readonly<Record<string, Scalar>>,
  after: Readonly<Record<string, Scalar>>,
): Record<string, { before: Scalar; after: Scalar }> {
  const changes: Record<string, { before: Scalar; after: Scalar }> = {};
  const fields = new Set([...Object.keys(before), ...Object.keys(after)]);
  for (const field of fields) {
    const previous = before[field] ?? null;
    const next = after[field] ?? null;
    if (!scalarEquals(previous, next)) {
      changes[field] = { before: previous, after: next };
    }
  }
  return changes;
}

function changedValue(
  before: Scalar,
  after: Scalar,
): { before: Scalar; after: Scalar } | null {
  return scalarEquals(before, after) ? null : { before, after };
}

function scalarEquals(left: Scalar, right: Scalar): boolean {
  return left === right;
}

function buildStaleDistribution(
  snapshots: readonly ScoreSnapshot[],
): StaleDistribution[] {
  return snapshots.map((snapshot) => {
    const distribution: StaleDistribution = {
      testId: snapshot.testId,
      phase: snapshot.phase,
      rowCount: snapshot.rowCount,
      missingDate: 0,
      explicitOffset: 0,
      noOffset: 0,
      unparseable: 0,
      conservativelyOlderThanFiveMinutes: 0,
      timezoneDependent: 0,
      futureOrIndeterminate: 0,
    };
    const receiptMs = snapshot.responseReceivedAtUtc
      ? Date.parse(snapshot.responseReceivedAtUtc)
      : Number.NaN;

    for (const row of snapshot.rows) {
      if (typeof row.date !== "string" || row.date.length === 0) {
        distribution.missingDate += 1;
        continue;
      }
      if (hasExplicitOffset(row.date)) {
        distribution.explicitOffset += 1;
      } else {
        distribution.noOffset += 1;
      }
      const sourceMs = parseSourceDateAsUtc(row.date);
      if (sourceMs === null || !Number.isFinite(receiptMs)) {
        distribution.unparseable += 1;
        continue;
      }
      const naiveAgeMs = receiptMs - sourceMs;
      if (naiveAgeMs > 14 * 60 * 60 * 1000 + 5 * 60 * 1000) {
        distribution.conservativelyOlderThanFiveMinutes += 1;
      } else if (naiveAgeMs >= 0) {
        distribution.timezoneDependent += 1;
      } else {
        distribution.futureOrIndeterminate += 1;
      }
    }
    return distribution;
  });
}

function assessHypotheses(
  calendarRecords: ReadonlyMap<number, readonly DiscoveryContest[]>,
  scoreSnapshots: readonly ScoreSnapshot[],
  changes: readonly ScoreChange[],
): HypothesisAssessment[] {
  const calendarEvidence = [...calendarRecords.entries()].flatMap(
    ([month, records]) => records.map((record) => ({ month, record })),
  );
  const h1Values = calendarEvidence.filter(
    ({ record }) => typeof record.dat === "number",
  );
  const h1Contradiction = h1Values.some(({ month, record }) => {
    const encodedMonth = Math.floor((record.dat as number) / 100);
    const encodedSlot = (record.dat as number) % 100;
    return encodedMonth !== month || encodedSlot < 1 || encodedSlot > 5;
  });
  const h1: HypothesisAssessment = h1Contradiction
    ? {
        id: "H1",
        result: "CONTRADICTED",
        rationale:
          "At least one numeric dat value from a month response does not match an MMWW-shaped value for that requested month.",
      }
    : h1Values.length > 0
      ? {
          id: "H1",
          result: "SUPPORTED",
          rationale:
            "Observed numeric dat values are compatible with MMWW shape in their month responses; calendar-weekend semantics remain unconfirmed.",
        }
      : {
          id: "H1",
          result: "UNRESOLVED",
          rationale:
            "No numeric dat values were available to evaluate MMWW shape.",
        };

  const dayValues = calendarEvidence.flatMap(({ record }) => [
    record.startday,
    record.finishday,
  ]);
  const numericDays = dayValues.filter(
    (value): value is number => typeof value === "number",
  );
  const h2: HypothesisAssessment = numericDays.some(
    (value) => !Number.isInteger(value) || value < 1 || value > 7,
  )
    ? {
        id: "H2",
        result: "CONTRADICTED",
        rationale:
          "At least one observed startday or finishday is outside the weekday-number range 1 through 7.",
      }
    : {
        id: "H2",
        result: "UNRESOLVED",
        rationale:
          "Values in the range 1 through 7 are compatible with both weekday numbers and early day-of-month values without a confirmed contest year.",
      };

  const sourceDates = scoreSnapshots.flatMap((snapshot) =>
    snapshot.rows.map((row) => row.date),
  );
  const allExplicitUtc =
    sourceDates.length > 0 &&
    sourceDates.every(
      (value) => typeof value === "string" && /Z$/i.test(value),
    );
  const h3: HypothesisAssessment = allExplicitUtc
    ? {
        id: "H3",
        result: "SUPPORTED",
        rationale:
          "All observed displayscore.date values include an explicit Z UTC designator.",
      }
    : {
        id: "H3",
        result: "UNRESOLVED",
        rationale:
          "HTTP Date and local UTC receipts are captured, but a source date without an explicit offset does not establish UTC semantics.",
      };

  const staleRows = buildStaleDistribution(scoreSnapshots).reduce(
    (total, distribution) =>
      total + distribution.conservativelyOlderThanFiveMinutes,
    0,
  );
  const h4: HypothesisAssessment =
    staleRows > 0 || changes.length === 0
      ? {
          id: "H4",
          result: "SUPPORTED",
          rationale:
            "Returned score rows include conservatively stale timestamps or no observed advancement, so row presence alone is insufficient evidence of current activity.",
        }
      : {
          id: "H4",
          result: "UNRESOLVED",
          rationale:
            "Observed rows advanced, which is activity evidence, but the sample did not independently demonstrate that row presence can be stale.",
        };

  return [h1, h2, h3, h4];
}

async function readBoundedBody(response: Response): Promise<BodyReadResult> {
  if (!response.body) {
    return { bytes: new Uint8Array(), tooLarge: false };
  }
  const reader = response.body.getReader();
  const chunks: Uint8Array[] = [];
  let total = 0;
  while (true) {
    const { done, value } = await reader.read();
    if (done) {
      break;
    }
    total += value.byteLength;
    if (total > MAX_RESPONSE_BYTES) {
      await reader.cancel("Response exceeded POC size limit.");
      return { bytes: null, tooLarge: true };
    }
    chunks.push(value);
  }
  const bytes = new Uint8Array(total);
  let offset = 0;
  for (const chunk of chunks) {
    bytes.set(chunk, offset);
    offset += chunk.byteLength;
  }
  return { bytes, tooLarge: false };
}

function createObservation(input: {
  label: string;
  endpoint: string;
  requestStartedAtUtc: string;
  responseReceivedAtUtc: string;
  durationMs: number;
  response: Response | null;
  bytes: Uint8Array | null;
  tooLarge: boolean;
  error: string | null;
}): ResponseObservation {
  const headers = input.response ? sanitizeHeaders(input.response.headers) : {};
  const contentType = input.response?.headers.get("content-type") ?? null;
  const redirectLocation = input.response?.headers.get("location") ?? null;
  return {
    label: input.label,
    endpoint: input.endpoint,
    method: "GET",
    requestStartedAtUtc: input.requestStartedAtUtc,
    responseReceivedAtUtc: input.responseReceivedAtUtc,
    durationMs: input.durationMs,
    status: input.response?.status ?? null,
    statusText: input.response?.statusText ?? null,
    redirectLocation,
    httpDate: input.response?.headers.get("date") ?? null,
    headers,
    contentType,
    responseBytes: input.bytes?.byteLength ?? null,
    payloadSha256: input.bytes
      ? createHash("sha256").update(input.bytes).digest("hex")
      : null,
    artifact: null,
    parsingStatus: input.tooLarge
      ? "TOO_LARGE"
      : input.bytes
        ? "NOT_ATTEMPTED"
        : "NON_JSON",
    error:
      input.error ??
      (input.tooLarge ? "Response exceeded POC size limit." : null),
  };
}

function isJsonContentType(contentType: string | null): boolean {
  return contentType?.toLowerCase().includes("application/json") ?? false;
}

function sanitizeHeaders(headers: Headers): Record<string, string> {
  const sanitized: Record<string, string> = {};
  for (const [name, value] of headers.entries()) {
    sanitized[name] = isSensitiveKey(name) ? "[REDACTED]" : value;
  }
  return sanitized;
}

function sanitizeJson(value: JsonValue): JsonValue {
  if (Array.isArray(value)) {
    return value.map(sanitizeJson);
  }
  if (isJsonObject(value)) {
    const sanitized: JsonObject = {};
    for (const [key, nested] of Object.entries(value)) {
      sanitized[key] = isSensitiveKey(key)
        ? "[REDACTED]"
        : sanitizeJson(nested);
    }
    return sanitized;
  }
  return value;
}

function isSensitiveKey(key: string): boolean {
  return /authorization|cookie|password|passwd|token|secret|api[_-]?key|^auth$/i.test(
    key,
  );
}

function isJsonObject(value: JsonValue): value is JsonObject {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

function scalarOrNull(value: JsonValue | undefined): Scalar {
  return value === undefined || typeof value === "object" ? null : value;
}

function stringOrNull(value: JsonValue | undefined): string | null {
  return typeof value === "string" ? value : null;
}

function parseSourceDateAsUtc(value: string): number | null {
  const normalized = value.replace(" ", "T");
  if (
    !/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:Z|[+-]\d{2}:?\d{2})?$/.test(
      normalized,
    )
  ) {
    return null;
  }
  const parsed = Date.parse(
    hasExplicitOffset(normalized) ? normalized : `${normalized}Z`,
  );
  return Number.isFinite(parsed) ? parsed : null;
}

function hasExplicitOffset(value: string): boolean {
  return /(?:Z|[+-]\d{2}:?\d{2})$/i.test(value);
}

function safeArtifactName(label: string): string {
  return label.replaceAll(/[^a-zA-Z0-9-]/g, "-");
}

function sanitizeError(error: unknown): string {
  return error instanceof Error
    ? error.message.replaceAll(/https?:\/\/[^\s]+/g, "[URL]")
    : "Unknown error";
}

async function writeJson(path: string, value: unknown): Promise<void> {
  await writeFile(path, `${JSON.stringify(value, null, 2)}\n`, "utf8");
}

function delay(milliseconds: number): Promise<void> {
  return new Promise((resolveDelay) => setTimeout(resolveDelay, milliseconds));
}

function renderMarkdown(report: PocReport): string {
  const lines = [
    "# contest.run Phase 0.7 Read-only Observation Report",
    "",
    `- Started (UTC): ${report.startedAtUtc}`,
    `- Completed (UTC): ${report.completedAtUtc}`,
    `- Requests made: ${report.requestCount}/${report.configuration.maxRequests}`,
    "- Method: GET only; redirects were not followed; no retries were attempted.",
    "",
    "## Selected Candidates",
    "",
    "| testid | name | selection | nearest position |",
    "| --- | --- | --- | --- |",
    ...report.selectedCandidates.map(
      (candidate) =>
        `| ${candidate.testId} | ${escapeMarkdown(candidate.name ?? "")} | ${candidate.selection} | ${candidate.nearestPosition} |`,
    ),
    "",
    "## HTTP Requests",
    "",
    "| label | status | HTTP Date | request started UTC | response received UTC | bytes |",
    "| --- | --- | --- | --- | --- |",
    ...report.observations.map(
      (observation) =>
        `| ${observation.label} | ${observation.status ?? "network error"} | ${escapeMarkdown(observation.httpDate ?? "")} | ${observation.requestStartedAtUtc} | ${observation.responseReceivedAtUtc} | ${observation.responseBytes ?? ""} |`,
    ),
    "",
    "## Discovery Membership",
    "",
    "| testid | name | nearest T0 | month 8 | month 9 | month 10 | nearest T+15m |",
    "| --- | --- | --- | --- | --- | --- |",
    ...report.discoveryMembership.map(
      (row) =>
        `| ${row.testId} | ${escapeMarkdown(row.name ?? "")} | ${row.nearestT0} | ${row.month8} | ${row.month9} | ${row.month10} | ${row.nearestTPlus15m} |`,
    ),
    "",
    "## Discovery Field Evidence",
    "",
    "| source | testid | dat | startday | starttime | finishday | finishtime |",
    "| --- | --- | --- | --- | --- | --- |",
    ...report.discoveryFieldEvidence.map(
      (record) =>
        `| ${record.source} | ${record.testId} | ${formatScalar(record.dat)} | ${formatScalar(record.startday)} | ${formatScalar(record.starttime)} | ${formatScalar(record.finishday)} | ${formatScalar(record.finishtime)} |`,
    ),
    "",
    "## Hypotheses",
    "",
    "| hypothesis | result | rationale |",
    "| --- | --- | --- |",
    ...report.hypotheses.map(
      (assessment) =>
        `| ${assessment.id} | ${assessment.result} | ${escapeMarkdown(assessment.rationale)} |`,
    ),
    "",
    "## Score Changes",
    "",
    "| callsign | date changed | score changed | qso changed | mult changed | band fields changed |",
    "| --- | --- | --- | --- | --- |",
    ...report.scoreChanges.map(
      (change) =>
        `| ${escapeMarkdown(change.callsign ?? "<missing>")} | ${change.date !== null} | ${change.score !== null} | ${change.qso !== null} | ${change.mult !== null} | ${escapeMarkdown(Object.keys(change.bands).join(", "))} |`,
    ),
    "",
    "## Source Timestamp and Stale-Row Evidence",
    "",
    "| testid | phase | rows | newest source date | HTTP Date | receipt UTC | naive source-to-HTTP lag ms | conservatively older than 5m | timezone dependent |",
    "| --- | --- | --- | --- | --- | --- | --- | --- |",
    ...report.scoreSnapshots.map((snapshot) => {
      const distribution = report.staleDistribution.find(
        (entry) =>
          entry.testId === snapshot.testId && entry.phase === snapshot.phase,
      );
      return `| ${snapshot.testId} | ${snapshot.phase} | ${snapshot.rowCount} | ${formatScalar(snapshot.newestSourceDate)} | ${formatScalar(snapshot.httpDate)} | ${formatScalar(snapshot.responseReceivedAtUtc)} | ${snapshot.naiveNewestSourceLagToHttpDateMs ?? ""} | ${distribution?.conservativelyOlderThanFiveMinutes ?? 0} | ${distribution?.timezoneDependent ?? 0} |`;
    }),
    "",
    "## Notes",
    "",
    "- JSON artifacts are sanitized before they are written; no raw payload is persisted.",
    "- `date` values without explicit offsets are not assigned UTC semantics.",
    "- The stale distribution uses a conservative +/-14 hour timezone envelope only to identify dates that remain older than five minutes under that envelope.",
    "",
  ];
  return lines.join("\n");
}

function formatScalar(value: Scalar | null): string {
  return value === null ? "" : escapeMarkdown(String(value));
}

function escapeMarkdown(value: string): string {
  return value.replaceAll("|", "\\|").replaceAll("\n", " ");
}

function printUsage(): void {
  console.log(`Usage:
  pnpm poc:contest-run:phase-0-7 -- --months 8,9,10 --candidate-count 2 --max-requests 9 --request-delay-ms 1000 --observation-gap-ms 900000 --output-dir runtime/contest-run-poc/phase-0-7

The POC performs only bounded, sequential GET requests against documented contest.run endpoints.`);
}

main().catch((error: unknown) => {
  console.error(sanitizeError(error));
  process.exitCode = 1;
});
