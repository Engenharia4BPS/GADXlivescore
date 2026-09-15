<?php

declare(strict_types=1);

namespace Araucaria\Livescore\Collector;

use Araucaria\Livescore\Support\JsonCodec;
use PDO;
use RuntimeException;
use Throwable;

/** Short MySQL operations for the bounded polling-cycle orchestration. */
final class PdoCollectorPollingRepository
{
    public function __construct(private readonly PDO $connection)
    {
    }

    /** @return list<CollectorMapping> */
    public function selectDueMappings(string $now, int $maximum, ?string $onlyMappingId = null): array
    {
        if ($onlyMappingId !== null && preg_match('/^\d+$/', $onlyMappingId) !== 1) {
            throw new RuntimeException('Collector test mapping ID must be an unsigned integer.');
        }
        // Production polling is pinned to the configured source code. The
        // mapping-ID branch is reachable only through the test-only command,
        // allowing its disposable source row to avoid that stable-code key.
        $sourceConstraint = $onlyMappingId === null
            ? " AND source.code = 'CONTEST_RUN'"
            : " AND source.kind = 'CONTEST_RUN' AND mapping.id = ?";
        $statement = $this->connection->prepare(
            "SELECT mapping.id, mapping.source_id, mapping.contest_id, external.external_id, mapping.poll_interval_seconds
             FROM collector_source_contests mapping
             INNER JOIN sources source ON source.id = mapping.source_id
             LEFT JOIN contest_external_ids external ON external.id = mapping.contest_external_id_id
             WHERE mapping.enabled = 1
               AND source.enabled = 1
               AND (mapping.next_poll_at IS NULL OR mapping.next_poll_at <= ?){$sourceConstraint}
             ORDER BY CASE WHEN mapping.next_poll_at IS NULL THEN 0 ELSE 1 END ASC,
                      mapping.next_poll_at ASC,
                      mapping.id ASC
             LIMIT ?",
        );
        $statement->bindValue(1, $now, PDO::PARAM_STR);
        if ($onlyMappingId !== null) {
            $statement->bindValue(2, $onlyMappingId, PDO::PARAM_STR);
            $statement->bindValue(3, $maximum, PDO::PARAM_INT);
        } else {
            $statement->bindValue(2, $maximum, PDO::PARAM_INT);
        }
        $statement->execute();

        $mappings = [];
        foreach ($statement->fetchAll(PDO::FETCH_ASSOC) as $row) {
            $interval = $row['poll_interval_seconds'];
            $mappings[] = new CollectorMapping(
                (string) $row['id'],
                (string) $row['source_id'],
                (string) $row['contest_id'],
                $row['external_id'] === null ? null : (string) $row['external_id'],
                $interval === null ? null : (int) $interval,
            );
        }
        return $mappings;
    }

    public function startRun(CollectorMapping $mapping, string $environment, string $lockName, string $startedAt): string
    {
        $statement = $this->connection->prepare(
            "INSERT INTO collector_runs (collector_source_contest_id, source_id, environment, advisory_lock_name, run_kind, outcome, started_at, finished_at, request_count, received_message_count, error_code, error_details, metadata, created_at)
             VALUES (?, ?, ?, ?, 'POLL', 'RUNNING', ?, NULL, 0, 0, NULL, NULL, NULL, ?)",
        );
        $statement->execute([$mapping->id, $mapping->sourceId, $environment, $lockName, $startedAt, $startedAt]);
        $id = $this->connection->lastInsertId();
        if ($id === '0' || $id === '') {
            throw new RuntimeException('Collector run insert returned no id.');
        }
        return $id;
    }

    public function finalizeRunAndSchedule(
        string $runId,
        CollectorMapping $mapping,
        string $outcome,
        string $finishedAt,
        int $requestCount,
        int $receivedMessageCount,
        ?string $errorCode,
        string $nextPollAt,
    ): void {
        if (!in_array($outcome, ['SUCCESS', 'FAILED'], true)) {
            throw new RuntimeException('Collector run completion outcome is invalid.');
        }
        $this->connection->beginTransaction();
        try {
            $run = $this->connection->prepare(
                'UPDATE collector_runs SET outcome = ?, finished_at = ?, request_count = ?, received_message_count = ?, error_code = ?, error_details = ? WHERE id = ? AND collector_source_contest_id = ?',
            );
            $details = $errorCode === null ? null : JsonCodec::encodeDatabaseValue(['error_code' => $errorCode]);
            $run->execute([$outcome, $finishedAt, $requestCount, $receivedMessageCount, $errorCode, $details, $runId, $mapping->id]);
            if ($run->rowCount() !== 1) {
                throw new RuntimeException('Collector run disappeared before finalization.');
            }

            $column = $outcome === 'SUCCESS' ? 'last_success_at' : 'last_failure_at';
            $schedule = $this->connection->prepare("UPDATE collector_source_contests SET {$column} = ?, next_poll_at = ? WHERE id = ? AND enabled = 1");
            $schedule->execute([$finishedAt, $nextPollAt, $mapping->id]);
            if ($schedule->rowCount() !== 1) {
                throw new RuntimeException('Collector source contest is no longer enabled.');
            }
            $this->connection->commit();
        } catch (Throwable $error) {
            if ($this->connection->inTransaction()) {
                $this->connection->rollBack();
            }
            throw $error;
        }
    }
}
