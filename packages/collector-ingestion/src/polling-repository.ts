import {
  type Database,
  type DatabaseDateTime,
  type DatabaseId,
  serializeJson,
} from "@araucaria/database";
import { type Kysely, sql } from "kysely";
import type {
  CollectorRunCompletion,
  CollectorRunStart,
  CollectorSourceContestMapping,
  PollingMappingRepository,
} from "./polling.js";

/** MySQL/Percona-backed short operations for polling orchestration. */
export class KyselyPollingMappingRepository
  implements PollingMappingRepository
{
  constructor(private readonly database: Kysely<Database>) {}

  async selectDueMappings(
    now: DatabaseDateTime,
    maxMappings: number,
  ): Promise<CollectorSourceContestMapping[]> {
    return this.database
      .selectFrom("collector_source_contests as mapping")
      .leftJoin(
        "contest_external_ids as external",
        "external.id",
        "mapping.contest_external_id_id",
      )
      .select([
        "mapping.id as id",
        "mapping.source_id as sourceId",
        "mapping.contest_id as contestId",
        "external.external_id as contestExternalId",
        "mapping.enabled as enabled",
        "mapping.poll_interval_seconds as pollIntervalSeconds",
        "mapping.next_poll_at as nextPollAt",
      ])
      .where("mapping.enabled", "=", 1)
      .where((expressionBuilder) =>
        expressionBuilder.or([
          expressionBuilder("mapping.next_poll_at", "is", null),
          expressionBuilder("mapping.next_poll_at", "<=", now),
        ]),
      )
      .orderBy(sql`CASE WHEN mapping.next_poll_at IS NULL THEN 0 ELSE 1 END`)
      .orderBy("mapping.next_poll_at", "asc")
      .orderBy("mapping.id", "asc")
      .limit(maxMappings)
      .execute();
  }

  async startRun(start: CollectorRunStart): Promise<DatabaseId> {
    const result = await this.database
      .insertInto("collector_runs")
      .values({
        collector_source_contest_id: start.mapping.id,
        source_id: start.mapping.sourceId,
        environment: start.environment,
        advisory_lock_name: start.advisoryLockName,
        run_kind: "POLL",
        outcome: "RUNNING",
        started_at: start.startedAt,
        finished_at: null,
        request_count: 0,
        received_message_count: 0,
        error_code: null,
        error_details: null,
        metadata: null,
        created_at: start.startedAt,
      })
      .executeTakeFirstOrThrow();
    if (result.insertId === undefined)
      throw new Error("Collector run insert returned no id.");
    return String(result.insertId);
  }

  async finalizeRunAndSchedule(
    runId: DatabaseId,
    mapping: CollectorSourceContestMapping,
    completion: CollectorRunCompletion,
    nextPollAt: DatabaseDateTime,
  ): Promise<void> {
    await this.database.transaction().execute(async (trx) => {
      const runUpdate = await trx
        .updateTable("collector_runs")
        .set({
          outcome: completion.outcome,
          finished_at: completion.finishedAt,
          request_count: completion.requestCount,
          received_message_count: completion.receivedMessageCount,
          error_code: completion.errorCode,
          error_details: serializeJson(completion.errorDetails),
        })
        .where("id", "=", runId)
        .where("collector_source_contest_id", "=", mapping.id)
        .executeTakeFirst();
      if (!runUpdate.numUpdatedRows) {
        throw new Error("Collector run disappeared before finalization.");
      }
      const mappingUpdate = await trx
        .updateTable("collector_source_contests")
        .set(
          completion.outcome === "SUCCESS"
            ? {
                last_success_at: completion.finishedAt,
                next_poll_at: nextPollAt,
              }
            : {
                last_failure_at: completion.finishedAt,
                next_poll_at: nextPollAt,
              },
        )
        .where("id", "=", mapping.id)
        .where("enabled", "=", 1)
        .executeTakeFirst();
      if (!mappingUpdate.numUpdatedRows) {
        throw new Error("Collector source contest is no longer enabled.");
      }
    });
  }
}
