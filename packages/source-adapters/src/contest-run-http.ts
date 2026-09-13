import {
  CONTEST_RUN_BASE_URL,
  type ContestRunCategoriesResponse,
  type ContestRunDiscoveryResponse,
  contestRunEndpoint,
  parseContestRunCategoriesResponse,
  parseContestRunDiscoveryResponse,
} from "./contest-run.js";

const defaultMaxResponseBytes = 2 * 1024 * 1024;
const defaultTimeoutMs = 20_000;

export type ContestRunDiscoveryEndpoint = "nearest" | "month" | "categories";
export type ContestRunHttpErrorCode =
  | "TIMEOUT"
  | "NETWORK"
  | "NON_2XX"
  | "INVALID_CONTENT"
  | "INVALID_BODY"
  | "RESPONSE_TOO_LARGE"
  | "ADAPTER_PARSE";

export interface ContestRunHttpResponseMetadata {
  endpoint: ContestRunDiscoveryEndpoint;
  status: number;
  durationMs: number;
  responseBytes: number;
}

export interface ContestRunHttpResponse<T> {
  data: T;
  metadata: ContestRunHttpResponseMetadata;
}

export type ContestRunFetch = (
  input: string,
  init: RequestInit,
) => Promise<Response>;

export interface ContestRunHttpClientOptions {
  baseUrl?: string;
  fetch?: ContestRunFetch;
  timeoutMs?: number;
  maxResponseBytes?: number;
}

export class ContestRunHttpError extends Error {
  readonly code: ContestRunHttpErrorCode;
  readonly endpoint: ContestRunDiscoveryEndpoint;
  readonly metadata: ContestRunHttpResponseMetadata | null;

  constructor(input: {
    code: ContestRunHttpErrorCode;
    message: string;
    endpoint: ContestRunDiscoveryEndpoint;
    metadata?: ContestRunHttpResponseMetadata;
    cause?: unknown;
  }) {
    super(input.message, { cause: input.cause });
    this.name = "ContestRunHttpError";
    this.code = input.code;
    this.endpoint = input.endpoint;
    this.metadata = input.metadata ?? null;
  }
}

/**
 * Read-only HTTP boundary for documented contest.run discovery endpoints.
 * It deliberately exposes response metadata and parsed DTOs, never bodies.
 */
export class ContestRunHttpClient {
  private readonly baseUrl: string;
  private readonly fetchImpl: ContestRunFetch;
  private readonly timeoutMs: number;
  private readonly maxResponseBytes: number;

  constructor(options: ContestRunHttpClientOptions = {}) {
    this.baseUrl = options.baseUrl ?? CONTEST_RUN_BASE_URL;
    this.fetchImpl =
      options.fetch ?? ((input, init) => globalThis.fetch(input, init));
    this.timeoutMs = options.timeoutMs ?? defaultTimeoutMs;
    this.maxResponseBytes = options.maxResponseBytes ?? defaultMaxResponseBytes;
    validatePositiveInteger(this.timeoutMs, "timeoutMs");
    validatePositiveInteger(this.maxResponseBytes, "maxResponseBytes");
  }

  async nearest(): Promise<
    ContestRunHttpResponse<ContestRunDiscoveryResponse>
  > {
    return this.request("nearest", undefined, parseContestRunDiscoveryResponse);
  }

  async month(
    month: number,
  ): Promise<ContestRunHttpResponse<ContestRunDiscoveryResponse>> {
    return this.request("month", month, parseContestRunDiscoveryResponse);
  }

  async categories(
    testId: number,
  ): Promise<ContestRunHttpResponse<ContestRunCategoriesResponse>> {
    return this.request(
      "categories",
      testId,
      parseContestRunCategoriesResponse,
    );
  }

  private async request<T>(
    endpoint: ContestRunDiscoveryEndpoint,
    value: number | undefined,
    parse: (body: Uint8Array) => T,
  ): Promise<ContestRunHttpResponse<T>> {
    const url = endpointUrl(endpoint, value, this.baseUrl);
    const startedAt = performance.now();
    const signal = AbortSignal.timeout(this.timeoutMs);
    let response: Response;

    try {
      response = await this.fetchImpl(url, {
        method: "GET",
        redirect: "error",
        headers: { Accept: "application/json" },
        signal,
      });
    } catch (error) {
      const code =
        signal.aborted || isAbortError(error) ? "TIMEOUT" : "NETWORK";
      throw new ContestRunHttpError({
        code,
        endpoint,
        message:
          code === "TIMEOUT"
            ? `contest.run ${endpoint} request timed out.`
            : `contest.run ${endpoint} request failed.`,
        cause: error,
      });
    }

    let bytes: Uint8Array;
    try {
      bytes = await readBoundedBody(response, this.maxResponseBytes);
    } catch (error) {
      if (error instanceof ResponseTooLargeError) {
        throw new ContestRunHttpError({
          code: "RESPONSE_TOO_LARGE",
          endpoint,
          message: `contest.run ${endpoint} response exceeds the configured size limit.`,
          cause: error,
        });
      }
      throw new ContestRunHttpError({
        code: "INVALID_BODY",
        endpoint,
        message: `contest.run ${endpoint} response body could not be read.`,
        cause: error,
      });
    }

    const metadata: ContestRunHttpResponseMetadata = {
      endpoint,
      status: response.status,
      durationMs: Math.round(performance.now() - startedAt),
      responseBytes: bytes.byteLength,
    };
    if (!response.ok) {
      throw new ContestRunHttpError({
        code: "NON_2XX",
        endpoint,
        metadata,
        message: `contest.run ${endpoint} returned HTTP ${response.status}.`,
      });
    }
    if (!isJsonContentType(response.headers.get("content-type"))) {
      throw new ContestRunHttpError({
        code: "INVALID_CONTENT",
        endpoint,
        metadata,
        message: `contest.run ${endpoint} response is not application/json.`,
      });
    }

    try {
      return { data: parse(bytes), metadata };
    } catch (error) {
      throw new ContestRunHttpError({
        code: "ADAPTER_PARSE",
        endpoint,
        metadata,
        message: `contest.run ${endpoint} response could not be parsed by its source adapter.`,
        cause: error,
      });
    }
  }
}

function endpointUrl(
  endpoint: ContestRunDiscoveryEndpoint,
  value: number | undefined,
  baseUrl: string,
): string {
  switch (endpoint) {
    case "nearest":
      return contestRunEndpoint("nearest", undefined, baseUrl);
    case "month":
      return contestRunEndpoint("month", value, baseUrl);
    case "categories":
      return contestRunEndpoint("categories", value, baseUrl);
  }
}

async function readBoundedBody(
  response: Response,
  maximumBytes: number,
): Promise<Uint8Array> {
  const declaredLength = Number(response.headers.get("content-length"));
  if (Number.isSafeInteger(declaredLength) && declaredLength > maximumBytes) {
    await response.body?.cancel();
    throw new ResponseTooLargeError();
  }
  if (!response.body) return new Uint8Array();

  const reader = response.body.getReader();
  const chunks: Uint8Array[] = [];
  let length = 0;
  while (true) {
    const { done, value } = await reader.read();
    if (done) break;
    length += value.byteLength;
    if (length > maximumBytes) {
      await reader.cancel();
      throw new ResponseTooLargeError();
    }
    chunks.push(value);
  }
  const bytes = new Uint8Array(length);
  let offset = 0;
  for (const chunk of chunks) {
    bytes.set(chunk, offset);
    offset += chunk.byteLength;
  }
  return bytes;
}

function isJsonContentType(value: string | null): boolean {
  return value?.toLowerCase().includes("application/json") ?? false;
}

function isAbortError(error: unknown): boolean {
  return error instanceof DOMException && error.name === "AbortError";
}

function validatePositiveInteger(value: number, name: string): void {
  if (!Number.isSafeInteger(value) || value <= 0) {
    throw new Error(`contest.run ${name} must be a positive safe integer.`);
  }
}

class ResponseTooLargeError extends Error {}
