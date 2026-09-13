import {
  type Database,
  type DatabaseDateTime,
  serializeJson,
} from "@araucaria/database";
import type { Kysely } from "kysely";
import type {
  CollectorRunRecoveryRepository,
  RecoveryFinalizationResult,
  StaleCollectorRun,
} from "./recovery.js";
import { addUtcSeconds } from "./runtime-time.js";

/** Percona 5.7-compatible short transactions for abandoned-run recovery. */
export class KyselyCollectorRunRecoveryRepository
  implements CollectorRunRecoveryRepository
{
  constructor(private readonly database: Kysely<Database>) {}

  async selectStaleRunningRuns(input: {
    environment: string;
    maxRuns: number;
    startedBefore: DatabaseDateTime;
  }): Promise<StaleCollectorRun[]> {
    return this.database
      .selectFrom("collector_runs")
      .select([
        "id",
        "collector_source_contest_id as collectorSourceContestId",
        "started_at as startedAt",
      ])
      .where("environment", "=", input.environment)
      .where("outcome", "=", "RUNNING")
      .where("finished_at", "is", null)
      .where("started_at", "<=", input.startedBefore)
      .orderBy("started_at", "asc")
      .orderBy("id", "asc")
      .limit(input.maxRuns)
      .execute();
  }

  async finalizeStaleRunningRun(input: {
    recoveredAt: DatabaseDateTime;
    runId: string;
  }): Promise<RecoveryFinalizationResult> {
    return this.database.transaction().execute(async (trx) => {
      const staleRun = await trx
        .selectFrom("collector_runs")
        .select("collector_source_contest_id as collectorSourceContestId")
        .where("id", "=", input.runId)
        .where("outcome", "=", "RUNNING")
        .where("finished_at", "is", null)
        .executeTakeFirst();
      if (!staleRun) return { outcome: "ALREADY_FINALIZED" };

      const mapping =
        staleRun.collectorSourceContestId === null
          ? undefined
          : await trx
              .selectFrom("collector_source_contests")
              .select(["id", "enabled", "poll_interval_seconds as interval"])
              .where("id", "=", staleRun.collectorSourceContestId)
              .forUpdate()
              .executeTakeFirst();
      const outcome = recoveryOutcome(mapping);
      const runUpdate = await trx
        .updateTable("collector_runs")
        .set({
          outcome: "FAILED",
          finished_at: input.recoveredAt,
          error_code: "ABANDONED_RUN_RECOVERED",
          error_details: serializeJson({
            recovery_code: "ABANDONED_RUN_RECOVERED",
            mapping_schedule: outcome,
            ...(outcome === "RECOVERED_INVALID_MAPPING_INTERVAL"
              ? { interval_status: "INVALID_MAPPING_INTERVAL" }
              : {}),
          }),
        })
        .where("id", "=", input.runId)
        .where("outcome", "=", "RUNNING")
        .where("finished_at", "is", null)
        .executeTakeFirst();
      if (!runUpdate.numUpdatedRows) return { outcome: "ALREADY_FINALIZED" };

      if (outcome === "RECOVERED" && mapping && mapping.interval !== null) {
        const mappingUpdate = await trx
          .updateTable("collector_source_contests")
          .set({
            last_failure_at: input.recoveredAt,
            next_poll_at: addUtcSeconds(input.recoveredAt, mapping.interval),
          })
          .where("id", "=", mapping.id)
          .where("enabled", "=", 1)
          .executeTakeFirst();
        if (!mappingUpdate.numUpdatedRows) {
          throw new Error("Collector mapping changed during recovery.");
        }
      }
      return { outcome };
    });
  }
}

function recoveryOutcome(
  mapping: { enabled: number; id: string; interval: number | null } | undefined,
): RecoveryFinalizationResult["outcome"] {
  if (!mapping) return "RECOVERED_WITHOUT_MAPPING";
  if (mapping.enabled !== 1) return "RECOVERED_DISABLED_MAPPING";
  if (
    mapping.interval === null ||
    !Number.isSafeInteger(mapping.interval) ||
    mapping.interval <= 0
  ) {
    return "RECOVERED_INVALID_MAPPING_INTERVAL";
  }
  return "RECOVERED";
}
