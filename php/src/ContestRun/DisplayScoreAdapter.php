<?php

declare(strict_types=1);

namespace Araucaria\Livescore\ContestRun;

use Araucaria\Livescore\Ingestion\BandObservation;
use Araucaria\Livescore\Ingestion\NormalizedScoreObservation;
use Araucaria\Livescore\Ingestion\RedactedReceipt;
use Araucaria\Livescore\Support\ContestRunValueConventions;
use InvalidArgumentException;
use JsonException;

/** Pure parity port of normalizeContestRunDisplayScoreResponse(). */
final class DisplayScoreAdapter
{
    /** @return array{observations:list<NormalizedScoreObservation>,rejected:list<array{index:int,error:string}>} */
    public function normalizePayload(string $body, RedactedReceipt $receipt): array
    {
        try { $records = json_decode($body, true, flags: JSON_THROW_ON_ERROR); }
        catch (JsonException $error) { throw new InvalidArgumentException('contest.run displayscore response is not valid JSON.', previous: $error); }
        if (!is_array($records) || !array_is_list($records)) throw new InvalidArgumentException('contest.run displayscore response must be a JSON array.');
        $observations = []; $rejected = [];
        foreach ($records as $index => $row) {
            try { $observations[] = $this->normalizeRow(is_array($row) && !array_is_list($row) ? $row : [], $receipt); }
            catch (\Throwable $error) { $rejected[] = ['index' => $index, 'error' => $error->getMessage()]; }
        }
        return ['observations' => $observations, 'rejected' => $rejected];
    }

    /** @param array<string,mixed> $row */
    public function normalizeRow(array $row, RedactedReceipt $receipt): NormalizedScoreObservation
    {
        $callsign = isset($row['sign']) && is_string($row['sign']) ? trim($row['sign']) : '';
        if ($callsign === '') throw new InvalidArgumentException('contest.run row has no callsign.');
        if ($receipt->contestId === null) throw new InvalidArgumentException('contest.run receipt requires a resolved contest id.');
        $date = isset($row['date']) && is_string($row['date']) && trim($row['date']) !== '' ? trim($row['date']) : null;
        $metric = fn (string $name): ?string => self::integerString($row[$name] ?? null);
        $bands = [];
        foreach (['160', '80', '40', '20', '15', '10'] as $band) {
            $value = new BandObservation($band . 'm', 'ALL', $metric('q' . $band), $metric('p' . $band), $metric('m' . $band), null);
            // Deliberate TypeScript parity: its band label keeps all six rows.
            $bands[] = $value;
        }
        return new NormalizedScoreObservation($receipt->sourceId, $receipt->contestId, ContestRunValueConventions::normalizeCallsign($callsign), $callsign, null, null, null, $date, $date === null ? null : 'UNZONED_SOURCE_TEXT', $metric('score'), $metric('qtotal'), $metric('ptotal'), $metric('mtotal'), self::redactAuth($row), ['soft' => ContestRunValueConventions::fingerprintSoft(self::soft($row['soft'] ?? null)), ...ContestRunValueConventions::qtotalEvidence(self::integerOrNull($row['qtotalc'] ?? null), self::integerOrNull($row['qtotalp'] ?? null), self::integerOrNull($row['qtotalr'] ?? null))], $bands);
    }

    /** @param array<string,mixed> $value @return array<string,mixed> */
    public static function redactAuth(array $value): array
    {
        $result = [];
        foreach ($value as $key => $entry) {
            if (strtolower((string) $key) === 'auth') continue;
            $result[(string) $key] = is_array($entry) ? (array_is_list($entry) ? array_map(static fn (mixed $nested): mixed => is_array($nested) ? self::redactAuth($nested) : $nested, $entry) : self::redactAuth($entry)) : $entry;
        }
        return $result;
    }

    private static function soft(mixed $value): string|int|float|null { return is_string($value) || is_int($value) || is_float($value) ? $value : null; }
    private static function integerOrNull(mixed $value): ?int { $string = self::integerString($value); return $string === null ? null : (int) $string; }
    private static function integerString(mixed $value): ?string
    {
        if ($value === null || $value === '') return null;
        if (is_int($value)) { if ($value < -9007199254740991 || $value > 9007199254740991) throw new InvalidArgumentException('contest.run metric must be a safe integer when present.'); return (string) $value; }
        if (is_float($value) && floor($value) === $value && abs($value) <= 9007199254740991) return sprintf('%.0f', $value);
        if (is_string($value) && preg_match('/^-?\d+$/', $value) === 1) {
            $digits = ltrim($value, '-');
            if (strlen($digits) < 16 || (strlen($digits) === 16 && strcmp($digits, '9007199254740991') <= 0)) return (string) (int) $value;
        }
        throw new InvalidArgumentException('contest.run metric must be a safe integer when present.');
    }
}
