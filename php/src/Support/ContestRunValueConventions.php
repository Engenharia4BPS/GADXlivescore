<?php

declare(strict_types=1);

namespace Araucaria\Livescore\Support;

use InvalidArgumentException;

/** Small parity helpers; they do not fetch or persist contest.run data. */
final class ContestRunValueConventions
{
    public static function normalizeCallsign(string $callsign): string
    {
        $trimmed = trim($callsign);
        if ($trimmed === '') {
            throw new InvalidArgumentException('contest.run row has no callsign.');
        }
        return mb_strtoupper($trimmed, 'UTF-8');
    }

    public static function fingerprintSoft(string|int|float|null $value): ?string
    {
        if ($value === null) {
            return null;
        }
        return (string) $value;
    }

    /** @return array{qtotalc: int|null, qtotalp: int|null, qtotalr: int|null} */
    public static function qtotalEvidence(int|null $qtotalc, int|null $qtotalp, int|null $qtotalr): array
    {
        return [
            'qtotalc' => $qtotalc,
            'qtotalp' => $qtotalp,
            'qtotalr' => $qtotalr,
        ];
    }
}
