<?php

declare(strict_types=1);

require dirname(__DIR__) . '/bootstrap/autoload.php';

use Araucaria\Livescore\Config\DatabaseUrl;
use Araucaria\Livescore\Config\RuntimeConfig;
use Araucaria\Livescore\Database\AdvisoryLock;
use Araucaria\Livescore\Database\DatabaseSafety;
use Araucaria\Livescore\Support\CanonicalJson;
use Araucaria\Livescore\Support\ContestRunValueConventions;
use Araucaria\Livescore\Support\Sha256;
use Araucaria\Livescore\Support\SnapshotFingerprint;
use Araucaria\Livescore\Support\StructuredLogger;
use Araucaria\Livescore\Support\UtcDateTime;
use DateTimeImmutable;
use DateTimeZone;
use JsonException;
use RuntimeException;
use Throwable;

$tests = [
    'database URL parsing remains strict and sanitized' => static function (): void {
        $url = 'mysql://user%40example:pass%3Aword@db.example.test:3307/dxarauca_livescore_test';
        $config = DatabaseUrl::parse($url);
        assertSameValue('user@example', $config->username);
        assertSameValue('pass:word', $config->password);
        assertSameValue([
            'host' => 'db.example.test',
            'port' => 3307,
            'database' => 'dxarauca_livescore_test',
        ], $config->sanitizedTarget());
        expectThrows(static fn (): DatabaseUrl => DatabaseUrl::parse('https://example.test/db'));
        expectThrows(static fn (): DatabaseUrl => DatabaseUrl::parse('mysql://host/one/two'));
        expectThrows(static fn (): DatabaseUrl => DatabaseUrl::parse('mysql://host/db%3Bcharset=utf8mb4'));
    },
    'collector environment matches TypeScript normalization' => static function (): void {
        assertSameValue('test_env', RuntimeConfig::normalizeCollectorEnvironment(' Test_ENV '));
        expectThrows(static fn (): string => RuntimeConfig::normalizeCollectorEnvironment('bad space'));
        $config = RuntimeConfig::fromEnvironment([
            'DATABASE_URL' => 'mysql://user:password@localhost/dxarauca_livescore_test',
            'COLLECTOR_ENVIRONMENT' => 'TEST',
        ]);
        assertSameValue('test', $config->collectorEnvironment);
    },
    'database safety rejects every non-test configured schema' => static function (): void {
        DatabaseSafety::requireUrlDatabase(
            DatabaseUrl::parse('mysql://user:password@localhost/dxarauca_livescore_test'),
            DatabaseSafety::PERCONA57_TEST_DATABASE,
        );
        expectThrows(static function (): void {
            DatabaseSafety::requireUrlDatabase(
                DatabaseUrl::parse('mysql://user:password@localhost/dxarauca_livescore'),
                DatabaseSafety::PERCONA57_TEST_DATABASE,
            );
        });
    },
    'UTC formatting preserves DATETIME(6) and arithmetic' => static function (): void {
        $value = new DateTimeImmutable('2026-09-13 12:00:00.123456', new DateTimeZone('UTC'));
        assertSameValue('2026-09-13 12:00:00.123456', UtcDateTime::formatDatabaseDateTime($value));
        assertSameValue('2026-09-13 12:00:01.123456', UtcDateTime::formatDatabaseDateTime(UtcDateTime::addSeconds($value, 1)));
        assertSameValue('2026-09-13 12:00:00.373456', UtcDateTime::formatDatabaseDateTime(UtcDateTime::addMilliseconds($value, 250)));
        assertMatches('/^\d{4}-\d{2}-\d{2} \d{2}:\d{2}:\d{2}\.\d{6}$/', UtcDateTime::utcNow());
    },
    'SHA-256 and canonical JSON match TypeScript-generated fixtures' => static function (): void {
        $fixture = parityFixture();
        assertSameValue($fixture['sha256']['expected_hex'], Sha256::hex($fixture['sha256']['utf8']));
        assertSameValue($fixture['sha256']['expected_hex'], bin2hex(Sha256::binary($fixture['sha256']['utf8'])));
        assertSameValue(32, strlen(Sha256::binary($fixture['sha256']['utf8'])));
        assertSameValue($fixture['canonical_json']['expected'], CanonicalJson::encode($fixture['canonical_json']['input']));
    },
    'normalized and diagnostic fingerprints match TypeScript-generated fixtures' => static function (): void {
        $fixture = parityFixture();
        foreach ($fixture['normalized_fingerprints'] as $vector) {
            assertSameValue($vector['expected_hex'], SnapshotFingerprint::normalizedHex($vector['observation']));
        }
        assertSameValue(
            $fixture['out_of_order_diagnostic']['expected_hex'],
            SnapshotFingerprint::outOfOrderDiagnosticHex($fixture['out_of_order_diagnostic']['snapshot_id']),
        );
    },
    'contest.run source-value parity keeps known distinctions' => static function (): void {
        $conventions = parityFixture()['contest_run_value_conventions'];
        assertSameValue(
            $conventions['callsign']['expected_normalized'],
            ContestRunValueConventions::normalizeCallsign($conventions['callsign']['input']),
        );
        foreach ($conventions['soft'] as $soft) {
            assertSameValue($soft['expected_fingerprint_evidence'], ContestRunValueConventions::fingerprintSoft($soft['input']));
        }
        assertSameValue($conventions['qtotal_evidence'], ContestRunValueConventions::qtotalEvidence(12, 34, 56));
        assertSameValue('342', $conventions['aggregate_band_disagreement']['aggregate_qso_total']);
        assertSameValue('30', $conventions['aggregate_band_disagreement']['band_qso_sum']);
        assertSameValue(true, $conventions['aggregate_band_disagreement']['aggregate_is_authoritative']);
    },
    'advisory locks use exact TypeScript-compatible names and scalars' => static function (): void {
        assertSameValue('als:test:csc:42', AdvisoryLock::mappingName('Test', '42'));
        assertSameValue('als:test:source:42:discovery', AdvisoryLock::discoveryName('Test', '42'));
        assertSameValue(true, AdvisoryLock::normalizeScalar(1, 'GET_LOCK'));
        assertSameValue(true, AdvisoryLock::normalizeScalar('1', 'GET_LOCK'));
        assertSameValue(false, AdvisoryLock::normalizeScalar(0, 'GET_LOCK'));
        assertSameValue(false, AdvisoryLock::normalizeScalar('0', 'GET_LOCK'));
        expectThrows(static fn (): bool => AdvisoryLock::normalizeScalar(null, 'GET_LOCK'));
        expectThrows(static fn (): string => AdvisoryLock::mappingName('test', 'not-an-id'));
    },
    'structured logs remove nested sensitive fields' => static function (): void {
        assertSameValue(
            ['safe' => 'value', 'nested' => ['count' => 1]],
            StructuredLogger::sanitize([
                'safe' => 'value',
                'password' => 'never-log',
                'nested' => ['auth' => 'never-log', 'count' => 1],
            ]),
        );
    },
];

$failures = 0;
foreach ($tests as $name => $test) {
    try {
        $test();
        fwrite(STDOUT, "PASS {$name}\n");
    } catch (Throwable $error) {
        $failures++;
        fwrite(STDERR, "FAIL {$name}: " . $error->getMessage() . "\n");
    }
}

fwrite(STDOUT, sprintf("PHP foundation tests: %d passed, %d failed\n", count($tests) - $failures, $failures));
exit($failures === 0 ? 0 : 1);

/** @return array<string, mixed> */
function parityFixture(): array
{
    try {
        $contents = file_get_contents(dirname(__DIR__, 2) . '/fixtures/parity/collector-php-parity-v1.json');
        if ($contents === false) {
            throw new RuntimeException('Parity fixture cannot be read.');
        }
        $fixture = json_decode($contents, true, flags: JSON_THROW_ON_ERROR);
        if (!is_array($fixture)) {
            throw new RuntimeException('Parity fixture must be an object.');
        }
        return $fixture;
    } catch (JsonException $error) {
        throw new RuntimeException('Parity fixture is invalid JSON.', previous: $error);
    }
}

function assertSameValue(mixed $expected, mixed $actual): void
{
    if ($expected !== $actual) {
        throw new RuntimeException('Expected values to be identical.');
    }
}

function assertMatches(string $pattern, string $value): void
{
    if (preg_match($pattern, $value) !== 1) {
        throw new RuntimeException('Value did not match expected format.');
    }
}

function expectThrows(callable $operation): void
{
    try {
        $operation();
    } catch (Throwable) {
        return;
    }
    throw new RuntimeException('Expected operation to throw.');
}
