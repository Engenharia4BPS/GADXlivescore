import assert from "node:assert/strict";
import test from "node:test";
import {
  type ContestRunCategoriesResponse,
  type ContestRunDiscoveryClient,
  type ContestRunDiscoveryRecord,
  ContestRunDiscoveryService,
  ContestRunHttpClient,
  ContestRunHttpError,
  type ContestRunHttpResponse,
} from "../src/index.js";

const jsonHeaders = { "content-type": "application/json; charset=utf-8" };

test("HTTP client fetches nearest with JSON Accept and returns parsed DTO metadata", async () => {
  const requests: { url: string; init: RequestInit }[] = [];
  const client = new ContestRunHttpClient({
    baseUrl: "https://source.example/ignored/path",
    fetch: async (url, init) => {
      requests.push({ url, init });
      return jsonResponse([{ testid: 108, name: "WAE DX SSB", dat: 902 }]);
    },
  });

  const result = await client.nearest();
  assert.equal(new URL(requests[0]?.url).pathname, "/api/contest/nearest");
  assert.equal(requests[0]?.init.method, "GET");
  assert.equal(
    new Headers(requests[0]?.init.headers).get("accept"),
    "application/json",
  );
  assert.equal(result.data.records[0]?.testid, 108);
  assert.deepEqual(result.metadata.endpoint, "nearest");
  assert.equal(result.metadata.status, 200);
  assert(result.metadata.responseBytes > 0);
  assert.equal("rawPayload" in result, false);
});

test("HTTP client fetches a validated month response", async () => {
  let requestCount = 0;
  const client = new ContestRunHttpClient({
    fetch: async (url) => {
      requestCount += 1;
      assert.equal(new URL(url).pathname, "/api/contest/month/9");
      return jsonResponse([{ testid: 91, dat: 903 }]);
    },
  });

  const result = await client.month(9);
  assert.equal(result.data.records[0]?.dat, 903);
  const requestsBeforeInvalidInput = requestCount;
  await assert.rejects(
    client.month(13),
    /month must be an integer from 1 to 12/,
  );
  assert.equal(requestCount, requestsBeforeInvalidInput);
});

test("HTTP client fetches categories with a validated contest.run testid", async () => {
  let requestCount = 0;
  const client = new ContestRunHttpClient({
    fetch: async (url) => {
      requestCount += 1;
      assert.equal(new URL(url).pathname, "/api/category/contest/108");
      return jsonResponse([{ testid: 108, catid: 7, "ct-band": "20m" }]);
    },
  });

  const result = await client.categories(108);
  assert.equal(result.data.records[0]?.catid, 7);
  const requestsBeforeInvalidInput = requestCount;
  await assert.rejects(
    client.categories(0),
    /testid must be a positive 32-bit integer/,
  );
  assert.equal(requestCount, requestsBeforeInvalidInput);
});

test("HTTP client fetches displayscore through the redacting source parser", async () => {
  let requestCount = 0;
  const client = new ContestRunHttpClient({
    fetch: async (url, init) => {
      requestCount += 1;
      assert.equal(new URL(url).pathname, "/api/displayscore/108");
      assert.equal(new Headers(init.headers).get("accept"), "application/json");
      return jsonResponse([
        {
          sign: "DM7EE",
          score: 36594,
          auth: "must-not-leave-source-adapter",
          nested: { AUTH: "must-not-leave-source-adapter" },
        },
      ]);
    },
  });

  const result = await client.displayScore(108);
  assert.equal(result.metadata.endpoint, "displayscore");
  assert.equal(result.data.records[0]?.sign, "DM7EE");
  assert.doesNotMatch(JSON.stringify(result.data), /auth|must-not-leave/i);
  assert.match(
    new TextDecoder().decode(result.rawPayload),
    /must-not-leave-source-adapter/,
  );
  const requestsBeforeInvalidInput = requestCount;
  await assert.rejects(
    client.displayScore(0),
    /testid must be a positive 32-bit integer/,
  );
  assert.equal(requestCount, requestsBeforeInvalidInput);
});

test("displayscore preserves the common typed HTTP error model", async () => {
  const non2xxClient = new ContestRunHttpClient({
    fetch: async () => new Response("unavailable", { status: 503 }),
  });
  await assert.rejects(non2xxClient.displayScore(108), (error: unknown) => {
    assert(error instanceof ContestRunHttpError);
    assert.equal(error.code, "NON_2XX");
    assert.equal(error.endpoint, "displayscore");
    return true;
  });

  const timeoutClient = new ContestRunHttpClient({
    timeoutMs: 1,
    fetch: async () => {
      throw new DOMException("request aborted", "AbortError");
    },
  });
  await assert.rejects(timeoutClient.displayScore(108), (error: unknown) => {
    assert(error instanceof ContestRunHttpError);
    assert.equal(error.code, "TIMEOUT");
    return true;
  });

  const invalidJsonClient = new ContestRunHttpClient({
    fetch: async () =>
      new Response("not JSON", { status: 200, headers: jsonHeaders }),
  });
  await assert.rejects(
    invalidJsonClient.displayScore(108),
    (error: unknown) => {
      assert(error instanceof ContestRunHttpError);
      assert.equal(error.code, "ADAPTER_PARSE");
      return true;
    },
  );

  const invalidContentClient = new ContestRunHttpClient({
    fetch: async () => new Response("[]", { status: 200 }),
  });
  await assert.rejects(
    invalidContentClient.displayScore(108),
    (error: unknown) => {
      assert(error instanceof ContestRunHttpError);
      assert.equal(error.code, "INVALID_CONTENT");
      return true;
    },
  );

  const oversizedClient = new ContestRunHttpClient({
    maxResponseBytes: 5,
    fetch: async () => jsonResponse([{ sign: "DM7EE" }]),
  });
  await assert.rejects(oversizedClient.displayScore(108), (error: unknown) => {
    assert(error instanceof ContestRunHttpError);
    assert.equal(error.code, "RESPONSE_TOO_LARGE");
    return true;
  });
});

test("HTTP client surfaces non-2xx response metadata without retaining a body", async () => {
  const client = new ContestRunHttpClient({
    fetch: async () => new Response("temporarily unavailable", { status: 503 }),
  });

  await assert.rejects(client.nearest(), (error: unknown) => {
    assert(error instanceof ContestRunHttpError);
    assert.equal(error.code, "NON_2XX");
    assert.equal(error.metadata?.status, 503);
    assert.equal(error.metadata?.responseBytes, 23);
    return true;
  });
});

test("HTTP client classifies aborts as timeouts", async () => {
  const client = new ContestRunHttpClient({
    timeoutMs: 1,
    fetch: async () => {
      throw new DOMException("request aborted", "AbortError");
    },
  });

  await assert.rejects(client.nearest(), (error: unknown) => {
    assert(error instanceof ContestRunHttpError);
    assert.equal(error.code, "TIMEOUT");
    return true;
  });
});

test("HTTP client reports invalid JSON as an adapter parse failure", async () => {
  const client = new ContestRunHttpClient({
    fetch: async () =>
      new Response("not JSON", {
        status: 200,
        headers: jsonHeaders,
      }),
  });

  await assert.rejects(client.nearest(), (error: unknown) => {
    assert(error instanceof ContestRunHttpError);
    assert.equal(error.code, "ADAPTER_PARSE");
    assert.equal(error.metadata?.endpoint, "nearest");
    return true;
  });
});

test("HTTP client rejects non-JSON and oversized response bodies without exposing them", async () => {
  const invalidContentClient = new ContestRunHttpClient({
    fetch: async () => new Response("not JSON", { status: 200 }),
  });
  await assert.rejects(invalidContentClient.nearest(), (error: unknown) => {
    assert(error instanceof ContestRunHttpError);
    assert.equal(error.code, "INVALID_CONTENT");
    return true;
  });

  const oversizedClient = new ContestRunHttpClient({
    maxResponseBytes: 5,
    fetch: async () => jsonResponse([{ testid: 108 }]),
  });
  await assert.rejects(oversizedClient.nearest(), (error: unknown) => {
    assert(error instanceof ContestRunHttpError);
    assert.equal(error.code, "RESPONSE_TOO_LARGE");
    return true;
  });
});

test("discovery service deduplicates by testid, preserves conflicting evidence, and fetches categories", async () => {
  const service = new ContestRunDiscoveryService(
    new FakeDiscoveryClient({
      nearest: [{ testid: 108, name: "Nearest name", dat: 902 }],
      month: [{ testid: 108, name: "Month name", dat: 999 }, { testid: 91 }],
      categories: new Map([
        [108, [{ testid: 108, catid: 1, "ct-band": "20m" }]],
        [91, [{ testid: 91, catid: 2, "ct-band": "40m" }]],
      ]),
    }),
  );

  const result = await service.discover({ month: 9 });
  assert.equal(result.contests.length, 2);
  const contest108 = result.contests[0];
  assert(contest108);
  assert.equal(contest108.testId, 108);
  assert.equal(contest108.discoveryEvidence.length, 2);
  assert.deepEqual(
    contest108.discoveryEvidence.map((evidence) => evidence.record.name),
    ["Nearest name", "Month name"],
  );
  assert.equal(contest108.categories[0]?.["ct-band"], "20m");
  assert.equal(contest108.categoryFetchStatus, "FETCHED");
  assert.deepEqual(
    result.requests.map((request) => request.endpoint),
    ["nearest", "month", "categories", "categories"],
  );
});

test("discovery leaves dat and contest time fields as raw evidence", async () => {
  const service = new ContestRunDiscoveryService(
    new FakeDiscoveryClient({
      nearest: [
        {
          testid: 108,
          dat: 902,
          startday: 6,
          starttime: "00:00:00",
          finishday: 7,
          finishtime: "23:59:59",
          unknown_source_field: "retain",
        },
      ],
      month: [],
      categories: new Map([[108, []]]),
    }),
  );

  const result = await service.discover();
  const record = result.contests[0]?.discoveryEvidence[0]?.record;
  assert.deepEqual(record, {
    testid: 108,
    dat: 902,
    startday: 6,
    starttime: "00:00:00",
    finishday: 7,
    finishtime: "23:59:59",
    unknown_source_field: "retain",
  });
  assert.equal("timezone" in (record ?? {}), false);
  assert.equal("year" in (record ?? {}), false);
});

test("discovery validates an optional month before any source request", async () => {
  const client = new CountingDiscoveryClient();
  await assert.rejects(
    new ContestRunDiscoveryService(client).discover({ month: 13 }),
    /month must be an integer from 1 to 12/,
  );
  assert.equal(client.calls, 0);
});

function jsonResponse(value: unknown): Response {
  return new Response(JSON.stringify(value), {
    status: 200,
    headers: jsonHeaders,
  });
}

interface FakeDiscoveryData {
  nearest: ContestRunDiscoveryRecord[];
  month: ContestRunDiscoveryRecord[];
  categories: Map<number, ContestRunCategoriesResponse["records"]>;
}

class FakeDiscoveryClient implements ContestRunDiscoveryClient {
  constructor(private readonly data: FakeDiscoveryData) {}

  async nearest(): Promise<
    ContestRunHttpResponse<{ records: readonly ContestRunDiscoveryRecord[] }>
  > {
    return response("nearest", { records: this.data.nearest });
  }

  async month(): Promise<
    ContestRunHttpResponse<{ records: readonly ContestRunDiscoveryRecord[] }>
  > {
    return response("month", { records: this.data.month });
  }

  async categories(
    testId: number,
  ): Promise<ContestRunHttpResponse<ContestRunCategoriesResponse>> {
    return response("categories", {
      records: this.data.categories.get(testId) ?? [],
    });
  }
}

class CountingDiscoveryClient extends FakeDiscoveryClient {
  calls = 0;

  override async nearest(): Promise<
    ContestRunHttpResponse<{ records: readonly ContestRunDiscoveryRecord[] }>
  > {
    this.calls += 1;
    return super.nearest();
  }

  override async month(
    month: number,
  ): Promise<
    ContestRunHttpResponse<{ records: readonly ContestRunDiscoveryRecord[] }>
  > {
    this.calls += 1;
    return super.month(month);
  }

  override async categories(
    testId: number,
  ): Promise<ContestRunHttpResponse<ContestRunCategoriesResponse>> {
    this.calls += 1;
    return super.categories(testId);
  }

  constructor() {
    super({ nearest: [], month: [], categories: new Map() });
  }
}

function response<T>(
  endpoint: "nearest" | "month" | "categories",
  data: T,
): ContestRunHttpResponse<T> {
  return {
    data,
    metadata: { endpoint, status: 200, durationMs: 1, responseBytes: 1 },
  };
}
