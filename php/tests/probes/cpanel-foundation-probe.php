<?php

declare(strict_types=1);

require dirname(__DIR__, 3) . '/cpanel-root/private/livescore/app/bootstrap/autoload.php';

use Araucaria\Livescore\Config\RuntimeConfig;
use Araucaria\Livescore\Database\AdvisoryLock;
use Araucaria\Livescore\Database\DatabaseSafety;
use Araucaria\Livescore\Database\PdoConnectionFactory;
use Araucaria\Livescore\Support\CanonicalJson;
use Araucaria\Livescore\Support\Sha256;
use Araucaria\Livescore\Support\StructuredLogger;
use PDO;
use RuntimeException;
use Throwable;

try {
    if (getenv('PHP_COLLECTOR_TEST_ONLY') !== '1') {
        throw new RuntimeException('Foundation probe requires PHP_COLLECTOR_TEST_ONLY=1.');
    }
    if (PHP_VERSION_ID < 80300) {
        throw new RuntimeException('PHP 8.3 or newer is required.');
    }
    foreach (['pdo_mysql', 'curl', 'json', 'openssl', 'mbstring'] as $extension) {
        if (!extension_loaded($extension)) {
            throw new RuntimeException('Required PHP extension is unavailable.');
        }
    }

    $config = RuntimeConfig::fromEnvironment();
    DatabaseSafety::requireUrlDatabase($config->database, DatabaseSafety::PERCONA57_TEST_DATABASE);
    $connection = PdoConnectionFactory::create($config->database);
    DatabaseSafety::requireTestDatabase($connection, $config->database);
    assertSessionBootstrap($connection);
    assertParityFixture();

    $lockName = AdvisoryLock::mappingName($config->collectorEnvironment, '999999999');
    $lock = new AdvisoryLock($connection);
    if (!$lock->tryAcquire($lockName)) {
        throw new RuntimeException('Foundation probe could not acquire its advisory lock.');
    }
    $lockHeld = true;
    try {
        if (!$lock->release($lockName)) {
            throw new RuntimeException('Foundation probe could not release its advisory lock.');
        }
        $lockHeld = false;
    } finally {
        if ($lockHeld) {
            try {
                $lock->release($lockName);
            } catch (Throwable) {
                // Process exit closes this PDO connection and releases any lock.
            }
        }
    }

    StructuredLogger::event('CPANEL_FOUNDATION_PROBE_PASS', [
        'environment' => $config->collectorEnvironment,
        'database' => $config->database->database,
        'php_version' => PHP_VERSION,
        'mysql_version' => scalarQuery($connection, 'SELECT VERSION()'),
        'session_time_zone' => scalarQuery($connection, 'SELECT @@session.time_zone'),
        'lock_release_verified' => true,
    ], false);
} catch (Throwable) {
    StructuredLogger::event('CPANEL_FOUNDATION_PROBE_FAILED', [
        'error_code' => 'CPANEL_FOUNDATION_PROBE_FAILED',
    ]);
    exit(1);
}

function assertSessionBootstrap(PDO $connection): void
{
    if (scalarQuery($connection, 'SELECT @@session.time_zone') !== '+00:00') {
        throw new RuntimeException('UTC session bootstrap validation failed.');
    }
    $mode = scalarQuery($connection, 'SELECT @@session.sql_mode');
    foreach (explode(',', PdoConnectionFactory::REQUIRED_SQL_MODE) as $required) {
        if (!str_contains($mode, $required)) {
            throw new RuntimeException('SQL mode bootstrap validation failed.');
        }
    }
    if (scalarQuery($connection, 'SELECT @@session.innodb_strict_mode') !== '1') {
        throw new RuntimeException('InnoDB strict-mode bootstrap validation failed.');
    }
}

function assertParityFixture(): void
{
    $contents = file_get_contents(dirname(__DIR__, 3) . '/fixtures/parity/collector-php-parity-v1.json');
    if ($contents === false) {
        throw new RuntimeException('Parity fixture cannot be read.');
    }
    $fixture = json_decode($contents, true, flags: JSON_THROW_ON_ERROR);
    if (!is_array($fixture)) {
        throw new RuntimeException('Parity fixture must be an object.');
    }
    if (
        !isset($fixture['sha256']['utf8'], $fixture['sha256']['expected_hex'])
        || Sha256::hex($fixture['sha256']['utf8']) !== $fixture['sha256']['expected_hex']
        || !isset($fixture['canonical_json']['input'], $fixture['canonical_json']['expected'])
        || CanonicalJson::encode($fixture['canonical_json']['input']) !== $fixture['canonical_json']['expected']
    ) {
        throw new RuntimeException('TypeScript parity fixture validation failed.');
    }
}

function scalarQuery(PDO $connection, string $query): string
{
    $value = $connection->query($query)->fetchColumn();
    if (!is_scalar($value)) {
        throw new RuntimeException('Database probe returned an invalid scalar.');
    }
    return (string) $value;
}
