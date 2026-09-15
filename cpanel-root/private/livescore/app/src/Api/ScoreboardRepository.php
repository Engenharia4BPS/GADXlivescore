<?php

declare(strict_types=1);

namespace Araucaria\Livescore\Api;

use PDO;

/** Read model for the public latest-accepted-score MVP endpoint. */
final class ScoreboardRepository
{
    public function __construct(private readonly PDO $connection)
    {
    }

    /** @return list<array<string, mixed>> */
    public function latestAcceptedEntries(?string $contestId = null): array
    {
        $statement = $this->connection->prepare(self::query($contestId !== null));
        if ($contestId !== null) {
            $statement->execute([$contestId]);
        } else {
            $statement->execute();
        }

        $entries = [];
        foreach ($statement->fetchAll(PDO::FETCH_ASSOC) as $row) {
            $entries[] = self::formatRow($row);
        }
        return $entries;
    }

    public static function query(bool $forContest): string
    {
        $filter = $forContest ? 'AND entry.contest_id = ?' : '';
        return str_replace(
            '{contest_filter}',
            $filter,
            <<<'SQL'
SELECT
  snapshot.id AS snapshot_id,
  entry.contest_id AS contest_id,
  contest.name AS contest_name,
  COALESCE(NULLIF(entry.display_callsign, ''), entry.normalized_callsign) AS callsign,
  snapshot.score AS score,
  snapshot.qso_total AS qso,
  snapshot.points_total AS points,
  snapshot.mult_total AS multipliers,
  source.code AS source_code,
  snapshot.source_timestamp AS source_timestamp,
  snapshot.source_timestamp_raw AS source_timestamp_raw,
  snapshot.source_timestamp_quality AS source_timestamp_quality,
  snapshot.received_at AS received_at,
  current_score.entry_id IS NOT NULL AS canonical
FROM entries AS entry
INNER JOIN contests AS contest ON contest.id = entry.contest_id
INNER JOIN score_snapshots AS snapshot
  ON snapshot.entry_id = entry.id
  AND snapshot.acceptance_status = 'ACCEPTED'
INNER JOIN sources AS source ON source.id = snapshot.source_id
LEFT JOIN score_snapshots AS newer_snapshot
  ON newer_snapshot.entry_id = snapshot.entry_id
  AND newer_snapshot.acceptance_status = 'ACCEPTED'
  AND (
    newer_snapshot.received_at > snapshot.received_at
    OR (newer_snapshot.received_at = snapshot.received_at AND newer_snapshot.id > snapshot.id)
  )
LEFT JOIN current_scores AS current_score
  ON current_score.entry_id = snapshot.entry_id
  AND current_score.canonical_snapshot_id = snapshot.id
WHERE newer_snapshot.id IS NULL
{contest_filter}
ORDER BY entry.contest_id ASC, snapshot.score DESC, callsign ASC, snapshot.received_at DESC, snapshot.id DESC
SQL
        );
    }

    /** @param array<string, mixed> $row @return array<string, mixed> */
    public static function formatRow(array $row): array
    {
        return [
            'snapshot_id' => (string) $row['snapshot_id'],
            'contest_id' => (string) $row['contest_id'],
            'contest' => (string) $row['contest_name'],
            'callsign' => (string) $row['callsign'],
            'score' => self::integerOrNull($row['score']),
            'qso' => self::integerOrNull($row['qso']),
            'points' => self::integerOrNull($row['points']),
            'multipliers' => self::integerOrNull($row['multipliers']),
            'canonical' => (int) $row['canonical'] === 1,
            'source' => (string) $row['source_code'],
            'source_timestamp' => self::timestampOrNull($row['source_timestamp']),
            'source_timestamp_raw' => self::stringOrNull($row['source_timestamp_raw']),
            'source_timestamp_quality' => self::stringOrNull($row['source_timestamp_quality']),
            'received_at' => self::timestampOrNull($row['received_at']),
        ];
    }

    private static function integerOrNull(mixed $value): ?int
    {
        return $value === null ? null : (int) $value;
    }

    private static function timestampOrNull(mixed $value): ?string
    {
        if ($value === null) {
            return null;
        }
        return str_replace(' ', 'T', (string) $value) . 'Z';
    }

    private static function stringOrNull(mixed $value): ?string
    {
        return $value === null ? null : (string) $value;
    }
}
