<?php

declare(strict_types=1);

namespace Araucaria\Livescore\Support;

use RuntimeException;

final class Sha256
{
    public static function hex(string $value): string
    {
        return hash('sha256', $value, false);
    }

    /** Returns the exact 32-byte representation required by BINARY(32) columns. */
    public static function binary(string $value): string
    {
        $hash = hash('sha256', $value, true);
        if (strlen($hash) !== 32) {
            throw new RuntimeException('SHA-256 binary result had an unexpected length.');
        }
        return $hash;
    }
}
