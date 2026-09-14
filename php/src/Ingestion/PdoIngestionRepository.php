<?php

declare(strict_types=1);

namespace Araucaria\Livescore\Ingestion;

use Araucaria\Livescore\Support\JsonCodec;
use Araucaria\Livescore\Support\SnapshotFingerprint;
use Araucaria\Livescore\Support\UtcDateTime;
use PDO;
use PDOException;
use RuntimeException;

/** PDO/Percona 5.7 port of the TypeScript normalized-observation repository. */
final class PdoIngestionRepository
{
    public function __construct(private readonly PDO $connection) {}

    public function createReceipt(RedactedReceipt $receipt): string
    {
        $sql = 'INSERT INTO raw_messages (source_id, contest_id, collector_source_contest_id, collector_run_id, received_at, processing_status, processing_attempts, processing_started_at, processed_at, observation_count, accepted_count, duplicate_count, rejected_count, message_kind, request_method, request_path_redacted, response_status, response_content_type, response_headers_redacted, payload_redacted, payload_sha256, redaction_metadata, parse_error, validation_error, metadata, created_at) VALUES (?, ?, ?, ?, ?, \'RECEIVED\', 0, NULL, NULL, 0, 0, 0, 0, ?, ?, ?, ?, ?, ?, ?, ?, ?, NULL, NULL, ?, ?)';
        $statement = $this->connection->prepare($sql);
        $statement->execute([$receipt->sourceId, $receipt->contestId, $receipt->collectorSourceContestId, $receipt->collectorRunId, $receipt->receivedAt, $receipt->messageKind, $receipt->requestMethod, $receipt->requestPathRedacted, $receipt->responseStatus, $receipt->responseContentType, $this->json($receipt->responseHeadersRedacted), $receipt->payloadRedacted, $receipt->payloadSha256, $this->json($receipt->redactionMetadata), $this->json($receipt->metadata), $receipt->receivedAt]);
        return $this->lastInsertId('Raw receipt insert returned no id.');
    }

    public function claim(string $rawMessageId, string $now): void
    {
        $statement = $this->connection->prepare("UPDATE raw_messages SET processing_status = 'PROCESSING', processing_started_at = ?, processing_attempts = processing_attempts + 1 WHERE id = ? AND processing_status = 'RECEIVED'");
        $statement->execute([$now, $rawMessageId]);
        if ($statement->rowCount() !== 1) throw new RuntimeException('Raw receipt is not available for processing.');
    }

    /** @param list<NormalizedScoreObservation> $observations @return list<ObservationPersistenceResult> */
    public function persistObservations(string $rawMessageId, string $receivedAt, array $observations): array
    {
        $this->connection->beginTransaction();
        try {
            $results = [];
            foreach ($observations as $observation) $results[] = $this->persistOne($rawMessageId, $receivedAt, $observation);
            $this->connection->commit();
            return $results;
        } catch (\Throwable $error) {
            if ($this->connection->inTransaction()) $this->connection->rollBack();
            throw $error;
        }
    }

    public function finish(string $rawMessageId, ReceiptResult $result, mixed $parseError = null): void
    {
        $statement = $this->connection->prepare('UPDATE raw_messages SET processing_status = ?, processed_at = ?, observation_count = ?, accepted_count = ?, duplicate_count = ?, rejected_count = ?, parse_error = ? WHERE id = ?');
        $processedAt = in_array($result->status, ['PROCESSING', 'RECEIVED'], true) ? null : UtcDateTime::utcNow();
        $statement->execute([$result->status, $processedAt, $result->observationCount, $result->acceptedCount, $result->duplicateCount, $result->rejectedCount, $this->json($parseError), $rawMessageId]);
    }

    public static function isExpectedSnapshotDuplicateError(PDOException $error): bool
    {
        $info = $error->errorInfo;
        $sqlState = is_array($info) && isset($info[0]) ? (string) $info[0] : '';
        $errno = is_array($info) && isset($info[1]) ? (int) $info[1] : 0;
        $message = (is_array($info) && isset($info[2]) ? (string) $info[2] : '') . ' ' . $error->getMessage();
        return $sqlState === '23000' && $errno === 1062 && str_contains($message, 'uq_score_snapshots_entry_source_fingerprint');
    }

    private function persistOne(string $rawMessageId, string $receivedAt, NormalizedScoreObservation $observation): ObservationPersistenceResult
    {
        if ($observation->categoryId !== null && !$this->categoryBelongsToContest($observation->categoryId, $observation->contestId)) return ObservationPersistenceResult::rejected('Resolved category does not belong to the observation contest.');
        $entryId = $this->resolveEntry($observation, $receivedAt);
        $fingerprint = hex2bin(SnapshotFingerprint::normalizedHex($observation->fingerprintValues()));
        if ($fingerprint === false || strlen($fingerprint) !== 32) throw new RuntimeException('Normalized fingerprint must be 32 binary bytes.');
        $existing = $this->connection->prepare('SELECT id FROM score_snapshots WHERE entry_id = ? AND source_id = ? AND normalized_fingerprint = ?');
        $existing->execute([$entryId, $observation->sourceId, $fingerprint]);
        if ($existing->fetchColumn() !== false) return ObservationPersistenceResult::duplicate($entryId);
        try {
            $statement = $this->connection->prepare("INSERT INTO score_snapshots (entry_id, contest_id, source_id, raw_message_id, category_id, category_raw, source_timestamp, source_timestamp_raw, source_timestamp_quality, received_at, score, qso_total, points_total, mult_total, raw_metrics, normalized_fingerprint, acceptance_status, anomaly_flags, created_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 'ACCEPTED', NULL, ?)");
            $statement->execute([$entryId, $observation->contestId, $observation->sourceId, $rawMessageId, $observation->categoryId, $this->json($observation->categoryRaw), $observation->sourceTimestamp, $observation->sourceTimestampRaw, $observation->sourceTimestampQuality, $receivedAt, $observation->score, $observation->qsoTotal, $observation->pointsTotal, $observation->multTotal, $this->json($observation->rawMetrics), $fingerprint, $receivedAt]);
        } catch (PDOException $error) {
            if (self::isExpectedSnapshotDuplicateError($error)) return ObservationPersistenceResult::duplicate($entryId);
            throw $error;
        }
        $snapshotId = $this->lastInsertId('Score snapshot insert returned no id.');
        if ($observation->bands !== []) {
            $bandStatement = $this->connection->prepare('INSERT INTO band_snapshots (snapshot_id, band, mode, qso, points, mult1, mult2) VALUES (?, ?, ?, ?, ?, ?, ?)');
            foreach ($observation->bands as $band) $bandStatement->execute([$snapshotId, $band->band, $band->mode, $band->qso, $band->points, $band->mult1, $band->mult2]);
        }
        return ObservationPersistenceResult::accepted($entryId, $snapshotId);
    }

    private function categoryBelongsToContest(string $categoryId, string $contestId): bool
    {
        $statement = $this->connection->prepare('SELECT id FROM contest_categories WHERE id = ? AND contest_id = ?');
        $statement->execute([$categoryId, $contestId]);
        return $statement->fetchColumn() !== false;
    }

    private function resolveEntry(NormalizedScoreObservation $observation, string $now): string
    {
        $statement = $this->connection->prepare('INSERT INTO entries (contest_id, normalized_callsign, display_callsign, current_category_id, current_category_observed_at, metadata, created_at, updated_at) VALUES (?, ?, ?, ?, ?, NULL, ?, ?) ON DUPLICATE KEY UPDATE display_callsign = VALUES(display_callsign), current_category_id = VALUES(current_category_id), current_category_observed_at = VALUES(current_category_observed_at), updated_at = VALUES(updated_at)');
        $statement->execute([$observation->contestId, $observation->normalizedCallsign, $observation->displayCallsign, $observation->categoryId, $observation->categoryId === null ? null : $now, $now, $now]);
        $select = $this->connection->prepare('SELECT id FROM entries WHERE contest_id = ? AND normalized_callsign = ?');
        $select->execute([$observation->contestId, $observation->normalizedCallsign]);
        $id = $select->fetchColumn();
        if ($id === false || preg_match('/^\d+$/', (string) $id) !== 1) throw new RuntimeException('Unable to resolve entry after upsert.');
        return (string) $id;
    }

    private function lastInsertId(string $failure): string
    {
        $id = $this->connection->lastInsertId();
        if (preg_match('/^\d+$/', $id) !== 1) throw new RuntimeException($failure);
        return $id;
    }

    private function json(mixed $value): ?string { return $value === null ? null : JsonCodec::encodeDatabaseValue($value); }
}
