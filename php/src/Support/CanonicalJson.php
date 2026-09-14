<?php

declare(strict_types=1);

namespace Araucaria\Livescore\Support;

use InvalidArgumentException;
use JsonException;

/**
 * Matches the TypeScript stableJson contract used only for fingerprint inputs:
 * object keys sort deterministically, while array order remains significant.
 */
final class CanonicalJson
{
    public static function encode(mixed $value): string
    {
        if ($value === null || is_bool($value) || is_int($value) || is_string($value)) {
            return self::encodeScalar($value);
        }
        if (is_float($value)) {
            if (!is_finite($value)) {
                throw new InvalidArgumentException('Canonical JSON does not support non-finite numbers.');
            }
            // JavaScript JSON.stringify(-0) is "0".
            return $value == 0.0 ? '0' : self::encodeScalar($value);
        }
        if (!is_array($value)) {
            throw new InvalidArgumentException('Canonical JSON accepts only JSON values.');
        }

        if (array_is_list($value)) {
            return '[' . implode(',', array_map(self::encode(...), $value)) . ']';
        }

        $keys = array_keys($value);
        foreach ($keys as $key) {
            if (!is_string($key)) {
                throw new InvalidArgumentException('Canonical JSON object keys must be strings.');
            }
        }
        usort($keys, self::compareJavaScriptKeys(...));
        $members = [];
        foreach ($keys as $key) {
            $members[] = self::encodeScalar($key) . ':' . self::encode($value[$key]);
        }
        return '{' . implode(',', $members) . '}';
    }

    private static function encodeScalar(bool|float|int|string|null $value): string
    {
        try {
            return json_encode(
                $value,
                JSON_THROW_ON_ERROR
                    | JSON_UNESCAPED_UNICODE
                    | JSON_UNESCAPED_SLASHES
                    | JSON_UNESCAPED_LINE_TERMINATORS,
            );
        } catch (JsonException $error) {
            throw new InvalidArgumentException('Canonical JSON value is invalid UTF-8.', previous: $error);
        }
    }

    private static function compareJavaScriptKeys(string $left, string $right): int
    {
        $leftUtf16 = mb_convert_encoding($left, 'UTF-16BE', 'UTF-8');
        $rightUtf16 = mb_convert_encoding($right, 'UTF-16BE', 'UTF-8');
        return strcmp($leftUtf16, $rightUtf16);
    }
}
