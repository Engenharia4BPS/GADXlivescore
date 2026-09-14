<?php

declare(strict_types=1);

namespace Araucaria\Livescore\Ingestion;

use DateTimeImmutable;
use DateTimeZone;
use InvalidArgumentException;

/** Pure Phase 2F.2 decision. It deliberately has no database dependencies. */
final class SingleSourcePolicy
{
    /** @param array{acceptance_status:string,source_id:string,source_timestamp:?string,source_timestamp_quality:?string} $candidate @param array{source_id:string,effective_at:string}|null $current */
    public static function decide(array $candidate, ?array $current): string
    {
        if ($candidate['acceptance_status'] !== 'ACCEPTED' || $candidate['source_timestamp'] === null || $candidate['source_timestamp_quality'] !== 'CONFIRMED_UTC') return 'INELIGIBLE_TIMESTAMP';
        if ($current === null) return 'CANONICAL_INITIAL';
        if ($candidate['source_id'] !== $current['source_id']) return 'DEFERRED_CROSS_SOURCE_POLICY';
        return self::microseconds($candidate['source_timestamp']) < self::microseconds($current['effective_at']) ? 'OUT_OF_ORDER' : 'CANONICAL_ADVANCED';
    }

    private static function microseconds(string $value): string
    {
        if (preg_match('/^([1-9]\d{3}-\d\d-\d\d \d\d:\d\d:\d\d)(?:\.(\d{1,6}))?$/', $value, $match) !== 1) throw new InvalidArgumentException("Invalid confirmed UTC timestamp: {$value}");
        try {
            $parsed = new DateTimeImmutable($match[1], new DateTimeZone('UTC'));
            if ($parsed->format('Y-m-d H:i:s') !== $match[1]) throw new InvalidArgumentException();
        } catch (\Throwable) { throw new InvalidArgumentException("Invalid confirmed UTC timestamp: {$value}"); }
        return $match[1] . '.' . str_pad($match[2] ?? '', 6, '0');
    }
}
