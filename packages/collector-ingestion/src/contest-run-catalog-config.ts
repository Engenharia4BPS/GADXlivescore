import { normalizePollingEnvironment } from "./polling.js";

export interface ContestRunCatalogEnvironmentConfig {
  environment: string;
  maxCategoryRequests: number;
  maxContests: number;
  month?: number;
}

/** Reads bounded, non-secret configuration for the one-shot catalog command. */
export function contestRunCatalogConfigFromEnvironment(
  environment: NodeJS.ProcessEnv = process.env,
): ContestRunCatalogEnvironmentConfig {
  const collectorEnvironment = environment.COLLECTOR_ENVIRONMENT;
  if (!collectorEnvironment) {
    throw new Error("COLLECTOR_ENVIRONMENT must be configured.");
  }
  const month = optionalInteger(
    environment.COLLECTOR_DISCOVERY_MONTH,
    "COLLECTOR_DISCOVERY_MONTH",
    1,
    12,
  );
  return {
    environment: normalizePollingEnvironment(collectorEnvironment),
    maxContests: requiredInteger(
      environment.COLLECTOR_DISCOVERY_MAX_CONTESTS,
      "COLLECTOR_DISCOVERY_MAX_CONTESTS",
      20,
      1,
      100,
    ),
    maxCategoryRequests: requiredInteger(
      environment.COLLECTOR_DISCOVERY_MAX_CATEGORY_REQUESTS,
      "COLLECTOR_DISCOVERY_MAX_CATEGORY_REQUESTS",
      2,
      0,
      20,
    ),
    ...(month === undefined ? {} : { month }),
  };
}

function optionalInteger(
  value: string | undefined,
  name: string,
  minimum: number,
  maximum: number,
): number | undefined {
  if (value === undefined) return undefined;
  return parseInteger(value, name, minimum, maximum);
}

function requiredInteger(
  value: string | undefined,
  name: string,
  fallback: number,
  minimum: number,
  maximum: number,
): number {
  return value === undefined
    ? fallback
    : parseInteger(value, name, minimum, maximum);
}

function parseInteger(
  value: string,
  name: string,
  minimum: number,
  maximum: number,
): number {
  if (!/^(0|[1-9]\d*)$/.test(value)) {
    throw new Error(
      `${name} must be an integer from ${minimum} to ${maximum}.`,
    );
  }
  const parsed = Number(value);
  if (!Number.isSafeInteger(parsed) || parsed < minimum || parsed > maximum) {
    throw new Error(
      `${name} must be an integer from ${minimum} to ${maximum}.`,
    );
  }
  return parsed;
}
