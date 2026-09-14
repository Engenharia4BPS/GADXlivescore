<?php

declare(strict_types=1);

namespace Araucaria\Livescore\Collector;

use Araucaria\Livescore\ContestRun\DisplayScoreIngestion;
use Araucaria\Livescore\Database\AdvisoryLock;
use Araucaria\Livescore\Support\UtcDateTime;
use DateTimeImmutable;
use DateTimeZone;
use InvalidArgumentException;
use PDO;
use RuntimeException;
use Throwable;

/** Executes one finite, cron-safe contest.run polling cycle. */
final class CollectorCycle
{
    public const DEFAULT_MAXIMUM_MAPPINGS = 10;
    public const MAXIMUM_MAPPINGS = 100;

    /** @param callable():PDO $lockConnectionFactory @param null|callable():string $clock */
    public function __construct(
        private readonly PdoCollectorPollingRepository $mappings,
        private readonly DisplayScoreIngestion $runner,
        private readonly mixed $lockConnectionFactory,
        private readonly mixed $clock = null,
    ) {
    }

    /** @return array{mappings_considered:int,mappings_succeeded:int,mappings_failed:int,mappings_invalid:int,mappings_locked_by_other:int,results:list<array<string,int|string|null>>} */
    public function run(string $environment, ?int $maximumMappings = null, ?string $onlyMappingId = null): array
    {
        $maximum = self::validateMaximumMappings($maximumMappings);
        $results = [];
        foreach ($this->mappings->selectDueMappings($this->now(), $maximum, $onlyMappingId) as $mapping) {
            $results[] = $this->runMapping($mapping, $environment);
        }
        return [
            'mappings_considered' => count($results),
            'mappings_succeeded' => count(array_filter($results, static fn (array $result): bool => $result['outcome'] === 'SUCCESS')),
            'mappings_failed' => count(array_filter($results, static fn (array $result): bool => $result['outcome'] === 'FAILED')),
            'mappings_invalid' => count(array_filter($results, static fn (array $result): bool => $result['outcome'] === 'INVALID_CONFIGURATION')),
            'mappings_locked_by_other' => count(array_filter($results, static fn (array $result): bool => $result['outcome'] === 'LOCKED_BY_OTHER')),
            'results' => $results,
        ];
    }

    public static function validateMaximumMappings(?int $value): int
    {
        if ($value === null) {
            return self::DEFAULT_MAXIMUM_MAPPINGS;
        }
        if ($value < 1 || $value > self::MAXIMUM_MAPPINGS) {
            throw new InvalidArgumentException('COLLECTOR_MAX_MAPPINGS_PER_CYCLE must be an integer from 1 to 100.');
        }
        return $value;
    }

    public static function validContestRunTestId(?string $externalId): ?int
    {
        if ($externalId === null || preg_match('/^[1-9][0-9]{0,9}$/', $externalId) !== 1) {
            return null;
        }
        if (strlen($externalId) === 10 && strcmp($externalId, '2147483647') > 0) {
            return null;
        }
        return (int) $externalId;
    }

    public static function validPollInterval(?int $value): ?int
    {
        return $value !== null && $value > 0 ? $value : null;
    }

    public static function addUtcSeconds(string $value, int $seconds): string
    {
        $parsed = DateTimeImmutable::createFromFormat('!Y-m-d H:i:s.u', $value, new DateTimeZone('UTC'));
        if ($parsed === false || $parsed->format('Y-m-d H:i:s.u') !== $value) {
            throw new InvalidArgumentException('Polling clock must return a UTC MySQL datetime string.');
        }
        return UtcDateTime::formatDatabaseDateTime(UtcDateTime::addSeconds($parsed, $seconds));
    }

    /** @return array<string,int|string|null> */
    private function runMapping(CollectorMapping $mapping, string $environment): array
    {
        $interval = self::validPollInterval($mapping->pollIntervalSeconds);
        $testId = self::validContestRunTestId($mapping->contestExternalId);
        if ($interval === null || $testId === null) {
            return $this->result($mapping->id, 'INVALID_CONFIGURATION', null, null, 0, 0, 'INVALID_MAPPING_CONFIGURATION');
        }

        $lockName = AdvisoryLock::mappingName($environment, $mapping->id);
        $connection = null;
        $lock = null;
        $ownsLock = false;
        $runId = null;
        $success = null;
        $requestCount = 0;
        $receivedMessageCount = 0;
        try {
            if (!is_callable($this->lockConnectionFactory)) {
                throw new RuntimeException('Collector lock connection factory must be callable.');
            }
            $connection = ($this->lockConnectionFactory)();
            if (!$connection instanceof PDO) {
                throw new RuntimeException('Collector lock connection factory returned an invalid connection.');
            }
            $lock = new AdvisoryLock($connection);
            $ownsLock = $lock->tryAcquire($lockName);
            if (!$ownsLock) {
                return $this->result($mapping->id, 'LOCKED_BY_OTHER', null, $lockName, 0, 0, null);
            }

            $startedAt = $this->now();
            $runId = $this->mappings->startRun($mapping, $environment, $lockName, $startedAt);
            try {
                $receipt = $this->runner->ingest($mapping->sourceId, $mapping->contestId, $testId, $this->now(), $mapping->id, $runId);
            } catch (Throwable) {
                throw new CollectorCycleFailure('HTTP_ERROR', 1, 0);
            }
            if ($receipt->status === 'FAILED') {
                throw new CollectorCycleFailure('INGESTION_FAILED', 1, 1);
            }
            $requestCount = 1;
            $receivedMessageCount = 1;
            $finishedAt = $this->now();
            $this->mappings->finalizeRunAndSchedule($runId, $mapping, 'SUCCESS', $finishedAt, 1, 1, null, self::addUtcSeconds($finishedAt, $interval));
            $success = $this->result($mapping->id, 'SUCCESS', $runId, $lockName, 1, 1, null);
        } catch (Throwable $error) {
            $failure = $error instanceof CollectorCycleFailure
                ? $error
                : new CollectorCycleFailure('POLLING_ERROR', $requestCount, $receivedMessageCount);
            if ($runId !== null) {
                try {
                    $finishedAt = $this->now();
                    $this->mappings->finalizeRunAndSchedule($runId, $mapping, 'FAILED', $finishedAt, $failure->requestCount, $failure->receivedMessageCount, $failure->errorCode, self::addUtcSeconds($finishedAt, $interval));
                } catch (Throwable) {
                    return $this->result($mapping->id, 'FAILED', $runId, $lockName, $failure->requestCount, $failure->receivedMessageCount, 'FINALIZATION_FAILED');
                }
            }
            return $this->result($mapping->id, 'FAILED', $runId, $lockName, $failure->requestCount, $failure->receivedMessageCount, $failure->errorCode);
        } finally {
            $released = true;
            if ($lock !== null && $ownsLock) {
                try {
                    $released = $lock->release($lockName);
                } catch (Throwable) {
                    $released = false;
                }
            }
            $lock = null;
            $connection = null;
            if (!$released && $success !== null && $runId !== null) {
                try {
                    $finishedAt = $this->now();
                    $this->mappings->finalizeRunAndSchedule($runId, $mapping, 'FAILED', $finishedAt, 1, 1, 'LOCK_RELEASE_ANOMALY', self::addUtcSeconds($finishedAt, $interval));
                    $success = $this->result($mapping->id, 'FAILED', $runId, $lockName, 1, 1, 'LOCK_RELEASE_ANOMALY');
                } catch (Throwable) {
                    $success = $this->result($mapping->id, 'FAILED', $runId, $lockName, 1, 1, 'FINALIZATION_FAILED');
                }
            }
        }
        return $success ?? $this->result($mapping->id, 'FAILED', $runId, $lockName, 0, 0, 'POLLING_ERROR');
    }

    /** @return array<string,int|string|null> */
    private function result(string $mappingId, string $outcome, ?string $runId, ?string $lockName, int $requestCount, int $receivedMessageCount, ?string $errorCode): array
    {
        return ['mapping_id' => $mappingId, 'outcome' => $outcome, 'run_id' => $runId, 'advisory_lock_name' => $lockName, 'request_count' => $requestCount, 'received_message_count' => $receivedMessageCount, 'error_code' => $errorCode];
    }

    private function now(): string
    {
        if ($this->clock === null) {
            return UtcDateTime::utcNow();
        }
        if (!is_callable($this->clock)) {
            throw new RuntimeException('Collector clock must be callable.');
        }
        $value = ($this->clock)();
        if (!is_string($value)) {
            throw new RuntimeException('Collector clock must return a timestamp string.');
        }
        return $value;
    }
}

final class CollectorCycleFailure extends RuntimeException
{
    public function __construct(public readonly string $errorCode, public readonly int $requestCount, public readonly int $receivedMessageCount)
    {
        parent::__construct($errorCode);
    }
}
