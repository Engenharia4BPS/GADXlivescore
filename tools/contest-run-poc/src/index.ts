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
const MAX_REQUESTS = 12;
const MAX_CONTESTS = 5;
const USER_AGENT =
  "Araucaria-LiveScore-POC/0.1 (read-only; contact: araucariadx.com)";

type JsonValue =
  | null
  | boolean
  | number
  | string
  | JsonValue[]
  | { [key: string]: JsonValue };

interface PocConfig {
  month: number;
  maxContests: number;
  maxRequests: number;
  requestDelayMs: number;
  outputDirectory: string;
}

interface ContestCandidate {
  testId: number;
  name: string | null;
  discoveredFrom: string;
}

interface ResponseObservation {
  label: string;
  endpoint: string;
  method: "GET";
  requestedAt: string;
  receivedAt: string;
  durationMs: number;
  status: number | null;
  statusText: string | null;
  redirectLocation: string | null;
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
  schema: SchemaObservation[];
  timestamps: TimestampObservation[];
}

interface SchemaObservation {
  path: string;
  types: string[];
  occurrences: number;
  nullCount: number;
}

interface TimestampObservation {
  path: string;
  value: string;
  format:
    | "DATE_ONLY"
    | "DATETIME_WITH_OFFSET"
    | "DATETIME_WITHOUT_OFFSET"
    | "OTHER";
  timezoneIndicator: "PRESENT" | "ABSENT" | "UNKNOWN";
  parseable: boolean;
}

interface PocReport {
  poc: "contest.run read-only observation";
  baseUrl: string;
  startedAt: string;
  completedAt: string;
  configuration: PocConfig;
  safeguards: {
    method: "GET only";
    redirects: "not followed";
    maxResponseBytes: number;
    userAgent: string;
    discoveredIdsOnly: true;
  };
  requestCount: number;
  discoveredContests: ContestCandidate[];
  observations: ResponseObservation[];
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

  hasBudget(): boolean {
    return this.requestCount < this.config.maxRequests;
  }

  async observe(
    label: string,
    endpoint: string,
    outputDirectory: string,
  ): Promise<JsonValue | null> {
    if (!this.hasBudget()) {
      return null;
    }

    if (this.requestCount > 0) {
      await delay(this.config.requestDelayMs);
    }

    const requestedAt = new Date().toISOString();
    const start = Date.now();
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

    const receivedAt = new Date().toISOString();
    const observation = createObservation({
      label,
      endpoint,
      requestedAt,
      receivedAt,
      durationMs: Date.now() - start,
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
        observation.schema = observeSchema(parsed);
        observation.timestamps = observeTimestamps(parsed);
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
}

async function main(): Promise<void> {
  const config = parseArguments(process.argv.slice(2));
  const outputDirectory = resolve(config.outputDirectory);
  const startedAt = new Date().toISOString();
  const client = new ReadOnlyContestRunClient(config);

  await mkdir(outputDirectory, { recursive: true });

  const nearest = await client.observe(
    "discovery-nearest",
    contestRunEndpoint("nearest"),
    outputDirectory,
  );
  const month = await client.observe(
    `discovery-month-${String(config.month).padStart(2, "0")}`,
    contestRunEndpoint("month", config.month),
    outputDirectory,
  );

  const contests = selectContests(
    [
      { label: "nearest", payload: nearest },
      { label: `month-${config.month}`, payload: month },
    ],
    config.maxContests,
  );

  for (const contest of contests) {
    if (!client.hasBudget()) {
      break;
    }
    await client.observe(
      `categories-${contest.testId}`,
      contestRunEndpoint("categories", contest.testId),
      outputDirectory,
    );

    if (!client.hasBudget()) {
      break;
    }
    await client.observe(
      `displayscore-${contest.testId}`,
      contestRunEndpoint("displayscore", contest.testId),
      outputDirectory,
    );
  }

  const report: PocReport = {
    poc: "contest.run read-only observation",
    baseUrl: CONTEST_RUN_BASE_URL,
    startedAt,
    completedAt: new Date().toISOString(),
    configuration: config,
    safeguards: {
      method: "GET only",
      redirects: "not followed",
      maxResponseBytes: MAX_RESPONSE_BYTES,
      userAgent: USER_AGENT,
      discoveredIdsOnly: true,
    },
    requestCount: client.requestCount,
    discoveredContests: contests,
    observations: [...client.records],
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

  const now = new Date();
  const month = integerOption(values, "--month", now.getUTCMonth() + 1, 1, 12);
  const maxContests = integerOption(
    values,
    "--max-contests",
    2,
    1,
    MAX_CONTESTS,
  );
  const maxRequests = integerOption(
    values,
    "--max-requests",
    6,
    2,
    MAX_REQUESTS,
  );
  const requestDelayMs = integerOption(
    values,
    "--request-delay-ms",
    1_000,
    MIN_REQUEST_DELAY_MS,
    60_000,
  );
  const outputDirectory =
    values.get("--output-dir") ?? defaultOutputDirectory();

  const knownOptions = new Set([
    "--month",
    "--max-contests",
    "--max-requests",
    "--request-delay-ms",
    "--output-dir",
  ]);
  for (const option of values.keys()) {
    if (!knownOptions.has(option)) {
      throw new Error(`Unsupported option: ${option}`);
    }
  }

  if (maxRequests < 2) {
    throw new Error("--max-requests must allow both discovery requests.");
  }
  const requiredRequests = 2 + maxContests * 2;
  if (maxRequests < requiredRequests) {
    throw new Error(
      `--max-requests must be at least ${requiredRequests} for ${maxContests} selected contests.`,
    );
  }

  return {
    month,
    maxContests,
    maxRequests,
    requestDelayMs,
    outputDirectory,
  };
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
  return `runtime/contest-run-poc/${timestamp}`;
}

function selectContests(
  discoveries: readonly { label: string; payload: JsonValue | null }[],
  maximum: number,
): ContestCandidate[] {
  const candidates = new Map<number, ContestCandidate>();

  for (const discovery of discoveries) {
    if (discovery.payload === null) {
      continue;
    }

    for (const candidate of extractContestCandidates(
      discovery.payload,
      discovery.label,
    )) {
      if (!candidates.has(candidate.testId)) {
        candidates.set(candidate.testId, candidate);
      }
    }
  }

  return [...candidates.values()].slice(0, maximum);
}

function extractContestCandidates(
  value: JsonValue,
  discoveredFrom: string,
): ContestCandidate[] {
  const results: ContestCandidate[] = [];

  if (Array.isArray(value)) {
    for (const item of value) {
      results.push(...extractContestCandidates(item, discoveredFrom));
    }
    return results;
  }

  if (value && typeof value === "object") {
    const testId = value.testid;
    if (isContestRunTestId(testId)) {
      results.push({
        testId,
        name: typeof value.name === "string" ? value.name : null,
        discoveredFrom,
      });
    }
    for (const nested of Object.values(value)) {
      results.push(...extractContestCandidates(nested, discoveredFrom));
    }
  }

  return results;
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
  requestedAt: string;
  receivedAt: string;
  durationMs: number;
  response: Response | null;
  bytes: Uint8Array | null;
  tooLarge: boolean;
  error: string | null;
}): ResponseObservation {
  const headers = input.response ? sanitizeHeaders(input.response.headers) : {};
  const contentType = input.response?.headers.get("content-type") ?? null;
  const redirectLocation = input.response?.headers.get("location") ?? null;
  const responseBytes = input.bytes?.byteLength ?? null;
  const parsingStatus = input.tooLarge
    ? "TOO_LARGE"
    : input.bytes
      ? "NOT_ATTEMPTED"
      : "NON_JSON";

  return {
    label: input.label,
    endpoint: input.endpoint,
    method: "GET",
    requestedAt: input.requestedAt,
    receivedAt: input.receivedAt,
    durationMs: input.durationMs,
    status: input.response?.status ?? null,
    statusText: input.response?.statusText ?? null,
    redirectLocation,
    headers,
    contentType,
    responseBytes,
    payloadSha256: input.bytes
      ? createHash("sha256").update(input.bytes).digest("hex")
      : null,
    artifact: null,
    parsingStatus,
    error:
      input.error ??
      (input.tooLarge ? "Response exceeded POC size limit." : null),
    schema: [],
    timestamps: [],
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
  if (value && typeof value === "object") {
    const sanitized: Record<string, JsonValue> = {};
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

function observeSchema(value: JsonValue): SchemaObservation[] {
  const results = new Map<
    string,
    { types: Set<string>; occurrences: number; nullCount: number }
  >();
  collectSchema(value, "$", results);

  return [...results.entries()]
    .map(([path, result]) => ({
      path,
      types: [...result.types].sort(),
      occurrences: result.occurrences,
      nullCount: result.nullCount,
    }))
    .sort((left, right) => left.path.localeCompare(right.path));
}

function collectSchema(
  value: JsonValue,
  path: string,
  results: Map<
    string,
    { types: Set<string>; occurrences: number; nullCount: number }
  >,
): void {
  const current = results.get(path) ?? {
    types: new Set<string>(),
    occurrences: 0,
    nullCount: 0,
  };
  current.types.add(jsonType(value));
  current.occurrences += 1;
  if (value === null) {
    current.nullCount += 1;
  }
  results.set(path, current);

  if (Array.isArray(value)) {
    for (const item of value) {
      collectSchema(item, `${path}[]`, results);
    }
  } else if (value && typeof value === "object") {
    for (const [key, nested] of Object.entries(value)) {
      collectSchema(nested, `${path}.${key}`, results);
    }
  }
}

function jsonType(value: JsonValue): string {
  if (value === null) {
    return "null";
  }
  if (Array.isArray(value)) {
    return "array";
  }
  return typeof value;
}

function observeTimestamps(value: JsonValue): TimestampObservation[] {
  const timestamps: TimestampObservation[] = [];
  collectTimestamps(value, "$", timestamps);
  return timestamps.slice(0, 100);
}

function collectTimestamps(
  value: JsonValue,
  path: string,
  timestamps: TimestampObservation[],
): void {
  if (Array.isArray(value)) {
    for (const item of value) {
      collectTimestamps(item, `${path}[]`, timestamps);
    }
    return;
  }

  if (value && typeof value === "object") {
    for (const [key, nested] of Object.entries(value)) {
      const nestedPath = `${path}.${key}`;
      if (typeof nested === "string" && isTimestampLikeKey(key)) {
        timestamps.push(inspectTimestamp(nestedPath, nested));
      }
      collectTimestamps(nested, nestedPath, timestamps);
    }
  }
}

function isTimestampLikeKey(key: string): boolean {
  return /(date|time|timestamp)$/i.test(key) || /(?:^|_)at$/i.test(key);
}

function inspectTimestamp(path: string, value: string): TimestampObservation {
  const dateOnly = /^\d{4}-\d{2}-\d{2}$/.test(value);
  const hasOffset = /(?:Z|[+-]\d{2}:?\d{2})$/i.test(value);
  const dateTime = /^\d{4}-\d{2}-\d{2}[ T]\d{2}:\d{2}:\d{2}/.test(value);
  const format = dateOnly
    ? "DATE_ONLY"
    : dateTime && hasOffset
      ? "DATETIME_WITH_OFFSET"
      : dateTime
        ? "DATETIME_WITHOUT_OFFSET"
        : "OTHER";

  return {
    path,
    value,
    format,
    timezoneIndicator: hasOffset ? "PRESENT" : dateTime ? "ABSENT" : "UNKNOWN",
    parseable: Number.isFinite(Date.parse(value)),
  };
}

async function writeJson(path: string, value: unknown): Promise<void> {
  await writeFile(path, `${JSON.stringify(value, null, 2)}\n`, "utf8");
}

function safeArtifactName(label: string): string {
  return label.replaceAll(/[^a-zA-Z0-9-]/g, "-");
}

function sanitizeError(error: unknown): string {
  return error instanceof Error
    ? error.message.replaceAll(/https?:\/\/[^\s]+/g, "[URL]")
    : "Unknown error";
}

function delay(milliseconds: number): Promise<void> {
  return new Promise((resolveDelay) => setTimeout(resolveDelay, milliseconds));
}

function renderMarkdown(report: PocReport): string {
  const lines = [
    "# contest.run Read-only Observation Report",
    "",
    `- Started: ${report.startedAt}`,
    `- Completed: ${report.completedAt}`,
    `- Base URL: ${report.baseUrl}`,
    `- Requests made: ${report.requestCount}/${report.configuration.maxRequests}`,
    `- Discovery month: ${report.configuration.month}`,
    `- Maximum selected contests: ${report.configuration.maxContests}`,
    `- Request delay: ${report.configuration.requestDelayMs} ms`,
    "- Method: GET only; redirects were not followed.",
    "",
    "## Discovered Contests",
    "",
  ];

  if (report.discoveredContests.length === 0) {
    lines.push(
      "No valid `testid` values were observed in the discovery responses.",
    );
  } else {
    lines.push("| testid | name | discovered from |", "| --- | --- | --- |");
    for (const contest of report.discoveredContests) {
      lines.push(
        `| ${contest.testId} | ${escapeMarkdown(contest.name ?? "")} | ${contest.discoveredFrom} |`,
      );
    }
  }

  lines.push(
    "",
    "## Responses",
    "",
    "| label | status | duration | content type | artifact | parsing |",
    "| --- | --- | --- | --- | --- | --- |",
  );
  for (const observation of report.observations) {
    lines.push(
      `| ${observation.label} | ${observation.status ?? "network error"} | ${observation.durationMs} ms | ${escapeMarkdown(observation.contentType ?? "")} | ${observation.artifact ?? ""} | ${observation.parsingStatus} |`,
    );
  }

  lines.push(
    "",
    "## Timestamp Inspection",
    "",
    "Timestamp values are observed, not interpreted as UTC unless their format includes an explicit offset.",
    "",
  );
  for (const observation of report.observations) {
    if (observation.timestamps.length === 0) {
      continue;
    }
    lines.push(
      `### ${observation.label}`,
      "",
      "| path | value | format | timezone indicator | parseable |",
      "| --- | --- | --- | --- | --- |",
    );
    for (const timestamp of observation.timestamps) {
      lines.push(
        `| ${timestamp.path} | ${escapeMarkdown(timestamp.value)} | ${timestamp.format} | ${timestamp.timezoneIndicator} | ${timestamp.parseable} |`,
      );
    }
    lines.push("");
  }

  lines.push("## Schema Observations", "");
  for (const observation of report.observations) {
    if (observation.schema.length === 0) {
      continue;
    }
    lines.push(
      `### ${observation.label}`,
      "",
      "| path | types | occurrences | nulls |",
      "| --- | --- | --- | --- |",
    );
    for (const field of observation.schema) {
      lines.push(
        `| ${field.path} | ${field.types.join(", ")} | ${field.occurrences} | ${field.nullCount} |`,
      );
    }
    lines.push("");
  }

  lines.push(
    "## Notes",
    "",
    "- JSON artifacts are sanitized before being written.",
    "- Raw HTTP bodies are not persisted by this POC.",
    "- Status, headers, response size, and SHA-256 payload hashes are retained in `report.json`.",
    "- Any observed behavior remains evidence, not a production API contract.",
    "",
  );
  return lines.join("\n");
}

function escapeMarkdown(value: string): string {
  return value.replaceAll("|", "\\|").replaceAll("\n", " ");
}

function printUsage(): void {
  console.log(`Usage:
  pnpm poc:contest-run -- --month 9 --max-contests 2 --max-requests 6 --request-delay-ms 1000 --output-dir runtime/contest-run-poc/baseline

The POC performs only bounded, sequential GET requests against documented contest.run endpoints.`);
}

main().catch((error: unknown) => {
  console.error(sanitizeError(error));
  process.exitCode = 1;
});
