<?php

declare(strict_types=1);

namespace Araucaria\Livescore\Support;

use DateTimeImmutable;
use DateTimeInterface;
use DateTimeZone;
use InvalidArgumentException;

final class UtcDateTime
{
    private static ?DateTimeZone $timezone = null;

    public static function utcNow(): string
    {
        return self::formatDatabaseDateTime(new DateTimeImmutable('now', self::timezone()));
    }

    public static function formatDatabaseDateTime(DateTimeInterface $value): string
    {
        return DateTimeImmutable::createFromInterface($value)
            ->setTimezone(self::timezone())
            ->format('Y-m-d H:i:s.u');
    }

    public static function addSeconds(DateTimeInterface $value, int $seconds): DateTimeImmutable
    {
        return self::modify($value, $seconds, 'seconds');
    }

    public static function addMilliseconds(DateTimeInterface $value, int $milliseconds): DateTimeImmutable
    {
        return self::modify($value, $milliseconds, 'milliseconds');
    }

    private static function modify(DateTimeInterface $value, int $amount, string $unit): DateTimeImmutable
    {
        $sign = $amount >= 0 ? '+' : '';
        $result = DateTimeImmutable::createFromInterface($value)
            ->setTimezone(self::timezone())
            ->modify(sprintf('%s%d %s', $sign, $amount, $unit));
        if ($result === false) {
            throw new InvalidArgumentException('Unable to modify UTC timestamp.');
        }
        return $result;
    }

    private static function timezone(): DateTimeZone
    {
        return self::$timezone ??= new DateTimeZone('UTC');
    }
}
