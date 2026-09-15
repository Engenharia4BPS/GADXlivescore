<?php

declare(strict_types=1);

namespace Araucaria\Livescore\Database;

use Araucaria\Livescore\Config\DatabaseUrl;
use PDO;
use RuntimeException;

final class DatabaseSafety
{
    public const PERCONA57_TEST_DATABASE = 'dxarauca_livescore_test';

    public static function requireTestDatabase(PDO $connection, DatabaseUrl $config): void
    {
        self::requireExactDatabase($connection, $config, self::PERCONA57_TEST_DATABASE);
    }

    public static function requireExactDatabase(PDO $connection, DatabaseUrl $config, string $expectedDatabase): void
    {
        self::requireUrlDatabase($config, $expectedDatabase);
        $activeDatabase = $connection->query('SELECT DATABASE()')->fetchColumn();
        if (!is_string($activeDatabase) || $activeDatabase !== $expectedDatabase) {
            throw new RuntimeException('Database guard rejected the active schema.');
        }
    }

    public static function requireUrlDatabase(DatabaseUrl $config, string $expectedDatabase): void
    {
        if ($config->database !== $expectedDatabase) {
            throw new RuntimeException('Database guard rejected the configured schema.');
        }
    }
}
