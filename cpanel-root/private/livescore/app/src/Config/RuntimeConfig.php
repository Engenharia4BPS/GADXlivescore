<?php

declare(strict_types=1);

namespace Araucaria\Livescore\Config;

use InvalidArgumentException;

final readonly class RuntimeConfig
{
    public function __construct(
        public DatabaseUrl $database,
        public string $collectorEnvironment,
    ) {
    }

    /** @param array<string, string|false> $environment */
    public static function fromEnvironment(array $environment = []): self
    {
        $databaseUrl = $environment['DATABASE_URL'] ?? getenv('DATABASE_URL');
        $collectorEnvironment = $environment['COLLECTOR_ENVIRONMENT'] ?? getenv('COLLECTOR_ENVIRONMENT');
        if (!is_string($databaseUrl) || $databaseUrl === '') {
            throw new InvalidArgumentException('DATABASE_URL must be configured.');
        }
        if (!is_string($collectorEnvironment) || $collectorEnvironment === '') {
            throw new InvalidArgumentException('COLLECTOR_ENVIRONMENT must be configured.');
        }

        return new self(
            DatabaseUrl::parse($databaseUrl),
            self::normalizeCollectorEnvironment($collectorEnvironment),
        );
    }

    public static function normalizeCollectorEnvironment(string $environment): string
    {
        $normalized = strtolower(trim($environment));
        if (preg_match('/^[a-z0-9][a-z0-9_-]{0,31}$/', $normalized) !== 1) {
            throw new InvalidArgumentException(
                'Collector environment must contain 1-32 lowercase letters, digits, hyphens, or underscores.',
            );
        }
        return $normalized;
    }
}
