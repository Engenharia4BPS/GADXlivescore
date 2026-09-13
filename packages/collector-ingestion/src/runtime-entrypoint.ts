import {
  createDatabase,
  databaseConfigFromEnvironment,
} from "@araucaria/database";
import { ContestRunHttpClient } from "@araucaria/source-adapters";
import { ContestRunPollingRunner } from "./contest-run-polling-runner.js";
import { MySqlAdvisoryLockSessionProvider } from "./mysql-advisory-lock.js";
import { CollectorPollingService } from "./polling.js";
import { KyselyPollingMappingRepository } from "./polling-repository.js";
import { CollectorRunRecoveryService } from "./recovery.js";
import { KyselyCollectorRunRecoveryRepository } from "./recovery-repository.js";
import { KyselyIngestionRepository } from "./repository.js";
import {
  type CollectorRuntimeEvent,
  CollectorRuntimeService,
} from "./runtime.js";
import { collectorRuntimeConfigFromEnvironment } from "./runtime-config.js";
import { CollectorIngestionService } from "./service.js";

async function main(): Promise<void> {
  const databaseConfig = databaseConfigFromEnvironment();
  const runtimeConfig = collectorRuntimeConfigFromEnvironment();
  const database = createDatabase(databaseConfig);
  const shutdown = new AbortController();
  const requestShutdown = () => shutdown.abort();
  process.once("SIGINT", requestShutdown);
  process.once("SIGTERM", requestShutdown);

  try {
    const pollingRepository = new KyselyPollingMappingRepository(database);
    const ingestion = new CollectorIngestionService(
      new KyselyIngestionRepository(database),
    );
    const locks = new MySqlAdvisoryLockSessionProvider(databaseConfig);
    const polling = new CollectorPollingService(
      pollingRepository,
      locks,
      new ContestRunPollingRunner(ingestion, new ContestRunHttpClient()),
    );
    const recovery = new CollectorRunRecoveryService(
      new KyselyCollectorRunRecoveryRepository(database),
      locks,
      { now: () => utcNow() },
    );
    const runtime = new CollectorRuntimeService(
      polling,
      recovery,
      { now: () => utcNow() },
      undefined,
      { emit: writeRuntimeEvent },
    );
    await runtime.run({ ...runtimeConfig, signal: shutdown.signal });
  } finally {
    process.off("SIGINT", requestShutdown);
    process.off("SIGTERM", requestShutdown);
    await database.destroy();
  }
}

function writeRuntimeEvent(event: CollectorRuntimeEvent): void {
  process.stdout.write(`${JSON.stringify(event)}\n`);
}

function utcNow(): string {
  const value = new Date();
  const part = (number: number, width = 2) =>
    String(number).padStart(width, "0");
  return `${part(value.getUTCFullYear(), 4)}-${part(value.getUTCMonth() + 1)}-${part(value.getUTCDate())} ${part(value.getUTCHours())}:${part(value.getUTCMinutes())}:${part(value.getUTCSeconds())}.${part(value.getUTCMilliseconds(), 3)}000`;
}

try {
  await main();
} catch {
  process.stderr.write(
    '{"type":"RUNTIME_FATAL","errorCode":"RUNTIME_START_FAILED"}\n',
  );
  process.exitCode = 1;
}
