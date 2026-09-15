<?php

declare(strict_types=1);

namespace Araucaria\Livescore\Support;

use InvalidArgumentException;

final class StructuredLogger
{
    private const SENSITIVE_KEY = '/authorization|cookie|password|passwd|token|secret|api[_-]?key|^auth$/i';

    /** @param array<string, mixed> $fields */
    public static function event(string $type, array $fields = [], bool $stderr = true): void
    {
        if (preg_match('/^[A-Z][A-Z0-9_]{0,127}$/', $type) !== 1) {
            throw new InvalidArgumentException('Structured event type must be a stable uppercase code.');
        }
        $event = self::sanitize($fields);
        $event['type'] = $type;
        $event['timestamp'] = UtcDateTime::utcNow();
        $line = JsonCodec::encodeDatabaseValue($event) . PHP_EOL;
        $stream = $stderr ? STDERR : STDOUT;
        if (fwrite($stream, $line) === false) {
            throw new InvalidArgumentException('Structured event output failed.');
        }
    }

    /** @return array<string, mixed> */
    public static function sanitize(array $fields): array
    {
        $sanitized = [];
        foreach ($fields as $key => $value) {
            if (preg_match(self::SENSITIVE_KEY, $key) === 1) {
                continue;
            }
            $sanitized[$key] = self::sanitizeValue($value);
        }
        return $sanitized;
    }

    private static function sanitizeValue(mixed $value): mixed
    {
        if ($value === null || is_bool($value) || is_int($value) || is_float($value) || is_string($value)) {
            return $value;
        }
        if (!is_array($value)) {
            return '[UNSUPPORTED]';
        }
        $result = [];
        foreach ($value as $key => $entry) {
            $key = (string) $key;
            if (preg_match(self::SENSITIVE_KEY, $key) === 1) {
                continue;
            }
            $result[$key] = self::sanitizeValue($entry);
        }
        return $result;
    }
}
