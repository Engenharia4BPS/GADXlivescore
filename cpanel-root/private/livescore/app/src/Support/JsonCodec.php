<?php

declare(strict_types=1);

namespace Araucaria\Livescore\Support;

use JsonException;
use RuntimeException;

/** JSON for metadata/raw metrics. Use CanonicalJson only for fingerprints. */
final class JsonCodec
{
    public static function encodeDatabaseValue(mixed $value): string
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
            throw new RuntimeException('JSON value cannot be safely encoded.', previous: $error);
        }
    }
}
