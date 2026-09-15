<?php

declare(strict_types=1);

namespace Araucaria\Livescore\Database;

use Araucaria\Livescore\Config\DatabaseUrl;
use PDO;

final class PdoConnectionFactory
{
    public const REQUIRED_SQL_MODE = 'ONLY_FULL_GROUP_BY,STRICT_TRANS_TABLES,NO_ZERO_IN_DATE,NO_ZERO_DATE,ERROR_FOR_DIVISION_BY_ZERO,NO_ENGINE_SUBSTITUTION';

    public static function create(DatabaseUrl $config): PDO
    {
        $dsn = sprintf(
            'mysql:host=%s;port=%d;dbname=%s;charset=utf8mb4',
            $config->host,
            $config->port,
            $config->database,
        );
        $connection = new PDO($dsn, $config->username, $config->password, [
            PDO::ATTR_ERRMODE => PDO::ERRMODE_EXCEPTION,
            PDO::ATTR_EMULATE_PREPARES => false,
            PDO::ATTR_STRINGIFY_FETCHES => false,
        ]);
        self::bootstrapSession($connection);
        return $connection;
    }

    public static function bootstrapSession(PDO $connection): void
    {
        $connection->exec("SET SESSION time_zone = '+00:00'");
        $connection->exec("SET SESSION sql_mode = '" . self::REQUIRED_SQL_MODE . "'");
        $connection->exec('SET SESSION innodb_strict_mode = ON');
    }
}
