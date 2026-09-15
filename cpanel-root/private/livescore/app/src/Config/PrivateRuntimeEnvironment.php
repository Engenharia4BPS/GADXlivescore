<?php

declare(strict_types=1);

namespace Araucaria\Livescore\Config;

use RuntimeException;

/** Loads the deployment-only PHP config that is kept outside public_html. */
final class PrivateRuntimeEnvironment
{
    /** @return array{DATABASE_URL: string, COLLECTOR_ENVIRONMENT: string} */
    public static function fromPhpFile(string $path): array
    {
        if (!is_file($path)) {
            throw new RuntimeException('Private LiveScore runtime configuration is unavailable.');
        }

        $values = require $path;
        if (!is_array($values)) {
            throw new RuntimeException('Private LiveScore runtime configuration must return an array.');
        }

        return self::validate($values);
    }

    /** @param array<string, mixed> $values @return array{DATABASE_URL: string, COLLECTOR_ENVIRONMENT: string} */
    public static function validate(array $values): array
    {
        $databaseUrl = $values['DATABASE_URL'] ?? null;
        $collectorEnvironment = $values['COLLECTOR_ENVIRONMENT'] ?? null;
        if (!is_string($databaseUrl) || $databaseUrl === '') {
            throw new RuntimeException('Private runtime configuration must contain DATABASE_URL.');
        }
        if (!is_string($collectorEnvironment) || $collectorEnvironment === '') {
            throw new RuntimeException('Private runtime configuration must contain COLLECTOR_ENVIRONMENT.');
        }

        return [
            'DATABASE_URL' => $databaseUrl,
            'COLLECTOR_ENVIRONMENT' => $collectorEnvironment,
        ];
    }
}
