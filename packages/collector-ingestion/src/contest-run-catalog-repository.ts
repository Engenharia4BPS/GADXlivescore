import {
  type Database,
  type DatabaseId,
  type JsonObject,
  type JsonValue,
  serializeJson,
} from "@araucaria/database";
import { redactContestRunAuth } from "@araucaria/source-adapters";
import type { Kysely, Transaction } from "kysely";
import type {
  CatalogPersistenceInput,
  CatalogPersistenceResult,
  ContestRunCatalogRepository,
  ContestRunCatalogSource,
  DiscoveryRunFinish,
  DiscoveryRunStart,
} from "./contest-run-catalog.js";

/**
 * Percona 5.7-compatible catalog persistence. Each discovered contest is an
 * independent short transaction; network requests never occur in it.
 */
export class KyselyContestRunCatalogRepository
  implements ContestRunCatalogRepository
{
  constructor(private readonly database: Kysely<Database>) {}

  async findSourceByCode(
    code: string,
  ): Promise<ContestRunCatalogSource | undefined> {
    return this.database
      .selectFrom("sources")
      .select(["id", "code"])
      .where("code", "=", code)
      .executeTakeFirst();
  }

  async startDiscoveryRun(input: DiscoveryRunStart): Promise<DatabaseId> {
    const result = await this.database
      .insertInto("collector_runs")
      .values({
        collector_source_contest_id: null,
        source_id: input.sourceId,
        environment: input.environment,
        advisory_lock_name: input.advisoryLockName,
        run_kind: "DISCOVERY",
        outcome: "RUNNING",
        started_at: input.observedAt,
        finished_at: null,
        request_count: 0,
        received_message_count: 0,
        error_code: null,
        error_details: null,
        metadata: null,
        created_at: input.observedAt,
      })
      .executeTakeFirstOrThrow();
    if (result.insertId === undefined) {
      throw new Error("Discovery collector run insert returned no id.");
    }
    return String(result.insertId);
  }

  async finishDiscoveryRun(input: DiscoveryRunFinish): Promise<void> {
    const updated = await this.database
      .updateTable("collector_runs")
      .set({
        outcome: input.errorCode ? "FAILED" : "SUCCESS",
        finished_at: input.finishedAt,
        request_count: input.requestCount,
        received_message_count: 0,
        error_code: input.errorCode,
        error_details: serializeJson(
          input.errorCode ? { error_code: input.errorCode } : null,
        ),
      })
      .where("id", "=", input.runId)
      .where("source_id", "=", input.sourceId)
      .where("collector_source_contest_id", "is", null)
      .where("run_kind", "=", "DISCOVERY")
      .where("outcome", "=", "RUNNING")
      .executeTakeFirst();
    if (!updated.numUpdatedRows) {
      throw new Error("Discovery collector run could not be finalized.");
    }
  }

  async syncDiscoveredContest(
    input: CatalogPersistenceInput,
  ): Promise<CatalogPersistenceResult> {
    return this.database
      .transaction()
      .execute((trx) => syncContest(trx, input));
  }
}

async function syncContest(
  trx: Transaction<Database>,
  input: CatalogPersistenceInput,
): Promise<CatalogPersistenceResult> {
  const externalId = String(input.contest.testId);
  const evidence = discoveryMetadata(input);
  const representative = input.contest.discoveryEvidence[0]?.record;
  if (!representative) {
    throw new Error("Discovered contest has no source evidence.");
  }
  let external = await trx
    .selectFrom("contest_external_ids")
    .select(["id", "contest_id as contestId"])
    .where("source_id", "=", input.source.id)
    .where("external_id", "=", externalId)
    .executeTakeFirst();
  let contestCreated = false;

  if (!external) {
    const contestResult = await trx
      .insertInto("contests")
      .values({
        name: catalogContestName(representative, input.contest.testId),
        normalized_name: normalizedCatalogName(
          catalogContestName(representative, input.contest.testId),
        ),
        slug: null,
        status: "DISCOVERED",
        start_at: null,
        end_at: null,
        time_zone: null,
        metadata: serializeJson(evidence),
        created_at: input.observedAt,
        updated_at: input.observedAt,
      })
      .executeTakeFirstOrThrow();
    if (contestResult.insertId === undefined) {
      throw new Error("Catalog contest insert returned no id.");
    }
    const contestId = String(contestResult.insertId);
    const externalResult = await trx
      .insertInto("contest_external_ids")
      .values(externalIdentityValues(input, contestId, evidence))
      .executeTakeFirstOrThrow();
    if (externalResult.insertId === undefined) {
      throw new Error("Catalog external identity insert returned no id.");
    }
    external = { id: String(externalResult.insertId), contestId };
    contestCreated = true;
  } else {
    await trx
      .updateTable("contest_external_ids")
      .set({
        ...externalEvidenceValues(input, evidence),
        updated_at: input.observedAt,
      })
      .where("id", "=", external.id)
      .where("source_id", "=", input.source.id)
      .where("external_id", "=", externalId)
      .executeTakeFirstOrThrow();
  }

  const mapping = await trx
    .selectFrom("collector_source_contests")
    .select(["id", "contest_external_id_id as contestExternalIdId"])
    .where("source_id", "=", input.source.id)
    .where("contest_id", "=", external.contestId)
    .executeTakeFirst();
  let mappingCreated = false;
  if (!mapping) {
    await trx
      .insertInto("collector_source_contests")
      .values({
        source_id: input.source.id,
        contest_id: external.contestId,
        contest_external_id_id: external.id,
        enabled: 0,
        poll_interval_seconds: null,
        configuration: null,
        last_success_at: null,
        last_failure_at: null,
        next_poll_at: null,
        created_at: input.observedAt,
        updated_at: input.observedAt,
      })
      .executeTakeFirstOrThrow();
    mappingCreated = true;
  } else if (mapping.contestExternalIdId === null) {
    // The source/testid lookup proves this is the mapping's exact identity.
    await trx
      .updateTable("collector_source_contests")
      .set({
        contest_external_id_id: external.id,
        updated_at: input.observedAt,
      })
      .where("id", "=", mapping.id)
      .where("source_id", "=", input.source.id)
      .where("contest_id", "=", external.contestId)
      .where("contest_external_id_id", "is", null)
      .executeTakeFirstOrThrow();
  }

  return {
    contestId: external.contestId,
    contestCreated,
    contestExternalIdCreated: contestCreated,
    mappingCreated,
  };
}

function externalIdentityValues(
  input: CatalogPersistenceInput,
  contestId: DatabaseId,
  evidence: JsonObject,
) {
  return {
    contest_id: contestId,
    source_id: input.source.id,
    external_id: String(input.contest.testId),
    ...externalEvidenceValues(input, evidence),
    created_at: input.observedAt,
    updated_at: input.observedAt,
  };
}

function externalEvidenceValues(
  input: CatalogPersistenceInput,
  evidence: JsonObject,
) {
  const record = input.contest.discoveryEvidence[0]?.record;
  if (!record) throw new Error("Discovered contest has no source evidence.");
  return {
    external_name: textOrNull(record.name ?? record.contest, 255),
    external_calendar_code: asciiOrNull(record.contest, 64),
    start_day: tinyUnsignedOrNull(record.startday),
    start_time: asciiOrNull(record.starttime, 64),
    finish_day: tinyUnsignedOrNull(record.finishday),
    finish_time: asciiOrNull(record.finishtime, 64),
    metadata: serializeJson(evidence),
    last_observed_at: input.observedAt,
  };
}

function catalogContestName(
  record: Record<string, unknown>,
  testId: number,
): string {
  return (
    textOrNull(record.name ?? record.contest, 255) ??
    `contest.run testid ${testId}`
  );
}

function normalizedCatalogName(value: string): string {
  return value.trim().toLocaleLowerCase("en-US").replaceAll(/\s+/g, " ");
}

function discoveryMetadata(input: CatalogPersistenceInput): JsonObject {
  const evidence = input.contest.discoveryEvidence.map((item) => ({
    source: item.source,
    record: stableJsonValue(redactContestRunAuth(item.record)),
  }));
  const categories = input.contest.categories
    .map((record) => stableJsonValue(redactContestRunAuth(record)))
    .sort((left, right) =>
      stableJsonText(left).localeCompare(stableJsonText(right)),
    );
  const categoryEvidence: JsonObject = {
    fetch_status: input.contest.categoryFetchStatus,
    records: categories,
  };
  if (input.contest.categoryErrorCode) {
    categoryEvidence.error_code = input.contest.categoryErrorCode;
  }
  return {
    contest_run: {
      testid: input.contest.testId,
      discovery_evidence: evidence,
      categories: categoryEvidence,
    },
  };
}

function stableJsonValue(value: JsonValue): JsonValue {
  if (Array.isArray(value)) return value.map(stableJsonValue);
  if (value !== null && typeof value === "object") {
    return Object.fromEntries(
      Object.entries(value)
        .sort(([left], [right]) => left.localeCompare(right))
        .map(([key, nested]) => [key, stableJsonValue(nested)]),
    );
  }
  return value;
}

function stableJsonText(value: JsonValue): string {
  return JSON.stringify(value);
}

function textOrNull(value: unknown, maximumLength: number): string | null {
  if (typeof value !== "string") return null;
  const trimmed = value.trim();
  return trimmed ? trimmed.slice(0, maximumLength) : null;
}

function asciiOrNull(value: unknown, maximumLength: number): string | null {
  const text = textOrNull(value, maximumLength);
  return text && /^[\x20-\x7e]+$/.test(text) ? text : null;
}

function tinyUnsignedOrNull(value: unknown): number | null {
  return typeof value === "number" &&
    Number.isInteger(value) &&
    value >= 0 &&
    value <= 255
    ? value
    : null;
}
