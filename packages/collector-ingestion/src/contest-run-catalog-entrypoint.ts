import {
  createDatabase,
  databaseConfigFromEnvironment,
} from "@araucaria/database";
import {
  ContestRunDiscoveryService,
  ContestRunHttpClient,
} from "@araucaria/source-adapters";
import { ContestRunCatalogSyncService } from "./contest-run-catalog.js";
import { contestRunCatalogConfigFromEnvironment } from "./contest-run-catalog-config.js";
import { KyselyContestRunCatalogRepository } from "./contest-run-catalog-repository.js";
import { MySqlAdvisoryLockSessionProvider } from "./mysql-advisory-lock.js";

async function main(): Promise<void> {
  const databaseConfig = databaseConfigFromEnvironment();
  const config = contestRunCatalogConfigFromEnvironment();
  const database = createDatabase(databaseConfig);
  try {
    const service = new ContestRunCatalogSyncService(
      new KyselyContestRunCatalogRepository(database),
      new MySqlAdvisoryLockSessionProvider(databaseConfig),
      new ContestRunDiscoveryService(new ContestRunHttpClient()),
    );
    const result = await service.sync(config);
    await writeStdout(JSON.stringify(result));
    if (
      result.outcome === "FAILED" ||
      result.outcome === "INVALID_SOURCE_CONFIGURATION"
    ) {
      process.exitCode = 1;
    }
  } finally {
    await database.destroy();
  }
}

async function writeStdout(text: string): Promise<void> {
  await new Promise<void>((resolve, reject) => {
    process.stdout.write(`${text}\n`, (error) => {
      if (error) reject(error);
      else resolve();
    });
  });
}

try {
  await main();
} catch {
  process.stderr.write(
    '{"type":"DISCOVERY_FATAL","errorCode":"DISCOVERY_START_FAILED"}\n',
  );
  process.exitCode = 1;
}
