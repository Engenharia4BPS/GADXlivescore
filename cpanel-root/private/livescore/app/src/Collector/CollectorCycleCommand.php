<?php

declare(strict_types=1);

namespace Araucaria\Livescore\Collector;

use Araucaria\Livescore\Config\RuntimeConfig;
use Araucaria\Livescore\ContestRun\DisplayScoreAdapter;
use Araucaria\Livescore\ContestRun\DisplayScoreHttpClient;
use Araucaria\Livescore\ContestRun\DisplayScoreIngestion;
use Araucaria\Livescore\Database\DatabaseSafety;
use Araucaria\Livescore\Database\PdoConnectionFactory;
use Araucaria\Livescore\Ingestion\NormalizedIngestionService;
use Araucaria\Livescore\Ingestion\PdoIngestionRepository;
use Araucaria\Livescore\Support\StructuredLogger;
use InvalidArgumentException;
use PDO;
use Throwable;

/** Shared entry point for the cron executable and its guarded cPanel probe. */
final class CollectorCycleCommand
{
    /** @param array<string, string|false> $environment */
    public static function run(array $environment = []): int
    {
        try {
            $config = RuntimeConfig::fromEnvironment($environment);
            if (self::testOnly($environment)) {
                DatabaseSafety::requireUrlDatabase($config->database, DatabaseSafety::PERCONA57_TEST_DATABASE);
            }
            $connection = PdoConnectionFactory::create($config->database);
            if (self::testOnly($environment)) {
                DatabaseSafety::requireTestDatabase($connection, $config->database);
            }
            $maximum = self::maximumMappings($environment);
            $ingestion = new NormalizedIngestionService(new PdoIngestionRepository($connection));
            $cycle = new CollectorCycle(
                new PdoCollectorPollingRepository($connection),
                new DisplayScoreIngestion(new DisplayScoreHttpClient(), new DisplayScoreAdapter(), $ingestion),
                static fn (): PDO => PdoConnectionFactory::create($config->database),
            );
            $summary = $cycle->run($config->collectorEnvironment, $maximum, self::testMappingId($environment));
            foreach ($summary['results'] as $result) {
                StructuredLogger::event('COLLECTOR_CYCLE_MAPPING_RESULT', $result);
            }
            StructuredLogger::event('COLLECTOR_CYCLE_COMPLETE', [
                'mappings_considered' => $summary['mappings_considered'],
                'mappings_succeeded' => $summary['mappings_succeeded'],
                'mappings_failed' => $summary['mappings_failed'],
                'mappings_invalid' => $summary['mappings_invalid'],
                'mappings_locked_by_other' => $summary['mappings_locked_by_other'],
            ]);
            return 0;
        } catch (Throwable) {
            StructuredLogger::event('COLLECTOR_CYCLE_FAILED', ['error_code' => 'COLLECTOR_CYCLE_FAILED']);
            return 1;
        }
    }

    /** @param array<string, string|false> $environment */
    private static function maximumMappings(array $environment): ?int
    {
        $value = $environment['COLLECTOR_MAX_MAPPINGS_PER_CYCLE'] ?? getenv('COLLECTOR_MAX_MAPPINGS_PER_CYCLE');
        if ($value === false || $value === null || $value === '') {
            return null;
        }
        if (!is_string($value) || preg_match('/^[1-9][0-9]{0,2}$/', $value) !== 1) {
            throw new InvalidArgumentException('COLLECTOR_MAX_MAPPINGS_PER_CYCLE must be an integer from 1 to 100.');
        }
        return CollectorCycle::validateMaximumMappings((int) $value);
    }

    /** @param array<string, string|false> $environment */
    private static function testOnly(array $environment): bool
    {
        return ($environment['PHP_COLLECTOR_TEST_ONLY'] ?? getenv('PHP_COLLECTOR_TEST_ONLY')) === '1';
    }

    /** @param array<string, string|false> $environment */
    private static function testMappingId(array $environment): ?string
    {
        if (!self::testOnly($environment)) {
            return null;
        }
        $value = $environment['PHP_COLLECTOR_TEST_MAPPING_ID'] ?? getenv('PHP_COLLECTOR_TEST_MAPPING_ID');
        if ($value === false || $value === null || $value === '') {
            return null;
        }
        if (!is_string($value) || preg_match('/^\d+$/', $value) !== 1) {
            throw new InvalidArgumentException('PHP_COLLECTOR_TEST_MAPPING_ID must be an unsigned integer.');
        }
        return $value;
    }
}
