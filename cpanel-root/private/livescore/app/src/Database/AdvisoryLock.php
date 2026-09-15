<?php

declare(strict_types=1);

namespace Araucaria\Livescore\Database;

use Araucaria\Livescore\Config\RuntimeConfig;
use InvalidArgumentException;
use PDO;
use RuntimeException;

/** Holds a caller-supplied PDO instance so advisory-lock ownership stays pinned. */
final class AdvisoryLock
{
    private const MAX_LOCK_NAME_LENGTH = 64;

    public function __construct(private readonly PDO $connection)
    {
    }

    public function tryAcquire(string $lockName): bool
    {
        $statement = $this->connection->prepare('SELECT GET_LOCK(?, 0)');
        $statement->execute([$this->validateLockName($lockName)]);
        return self::normalizeScalar($statement->fetchColumn(), 'GET_LOCK');
    }

    public function release(string $lockName): bool
    {
        $statement = $this->connection->prepare('SELECT RELEASE_LOCK(?)');
        $statement->execute([$this->validateLockName($lockName)]);
        return self::normalizeScalar($statement->fetchColumn(), 'RELEASE_LOCK');
    }

    public static function mappingName(string $environment, string $mappingId): string
    {
        self::requireUnsignedId($mappingId, 'Collector source contest ID');
        return self::validateStaticLockName(
            'als:' . RuntimeConfig::normalizeCollectorEnvironment($environment) . ':csc:' . $mappingId,
        );
    }

    public static function discoveryName(string $environment, string $sourceId): string
    {
        self::requireUnsignedId($sourceId, 'Source ID');
        return self::validateStaticLockName(
            'als:' . RuntimeConfig::normalizeCollectorEnvironment($environment) . ':source:' . $sourceId . ':discovery',
        );
    }

    public static function normalizeScalar(mixed $value, string $operation): bool
    {
        if ($value === 1 || $value === '1') {
            return true;
        }
        if ($value === 0 || $value === '0') {
            return false;
        }
        throw new RuntimeException($operation . ' returned an invalid advisory-lock scalar.');
    }

    private function validateLockName(string $lockName): string
    {
        return self::validateStaticLockName($lockName);
    }

    private static function validateStaticLockName(string $lockName): string
    {
        if ($lockName === '' || strlen($lockName) > self::MAX_LOCK_NAME_LENGTH) {
            throw new InvalidArgumentException('Advisory lock name is invalid.');
        }
        return $lockName;
    }

    private static function requireUnsignedId(string $value, string $label): void
    {
        if (preg_match('/^\d+$/', $value) !== 1) {
            throw new InvalidArgumentException($label . ' must be an unsigned integer.');
        }
    }
}
