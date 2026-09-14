<?php

declare(strict_types=1);

require dirname(__DIR__) . '/bootstrap/autoload.php';

use Araucaria\Livescore\Config\DatabaseUrl;
use Araucaria\Livescore\Config\RuntimeConfig;
use Araucaria\Livescore\Database\AdvisoryLock;
use Araucaria\Livescore\Database\DatabaseSafety;
use Araucaria\Livescore\Support\CanonicalJson;
use Araucaria\Livescore\Support\JsonCodec;
use Araucaria\Livescore\Support\ContestRunValueConventions;
use Araucaria\Livescore\Support\Sha256;
use Araucaria\Livescore\Support\SnapshotFingerprint;
use Araucaria\Livescore\Support\StructuredLogger;
use Araucaria\Livescore\Support\UtcDateTime;
use Araucaria\Livescore\Ingestion\BandObservation;
use Araucaria\Livescore\Ingestion\NormalizedScoreObservation;
use Araucaria\Livescore\Ingestion\ObservationPersistenceResult;
use Araucaria\Livescore\Ingestion\PdoIngestionRepository;
use Araucaria\Livescore\Ingestion\ReceiptResult;
use Araucaria\Livescore\Ingestion\SingleSourcePolicy;
use Araucaria\Livescore\Ingestion\CanonicalReconciliationResult;
use PDOException;
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
    'ingestion DTOs preserve decimal strings, nulls, and binary fingerprints' => static function (): void {
        $observation = new NormalizedScoreObservation('9007199254740993', '2', 'DM7EE', 'DM7EE', null, ['raw' => 'category'], null, 'source text', 'UNZONED_SOURCE_TEXT', '0', '0', null, '0', ['signed' => '-1'], ['kind' => 'fixture'], [new BandObservation('40m', 'ALL', '-1', '0', null, null)]);
        assertSameValue('9007199254740993', $observation->sourceId);
        assertSameValue(null, $observation->categoryId);
        assertSameValue('-1', $observation->bands[0]->qso);
        assertSameValue(32, strlen(hex2bin(SnapshotFingerprint::normalizedHex($observation->fingerprintValues())) ?: ''));
    },
    'ingestion receipt status and pure sequence policy match fixture' => static function (): void {
        $fixture = ingestionFixture();
        foreach ($fixture['receipt_status_vectors'] as $vector) assertSameValue($vector['expected'], ReceiptResult::finalStatus($vector['accepted'], $vector['duplicates'], $vector['rejected']));
        foreach ($fixture['single_source_policy'] as $vector) assertSameValue($vector['expected'], SingleSourcePolicy::decide($vector['candidate'], $vector['current']));
        assertSameValue('Resolved category does not belong to the observation contest.', ObservationPersistenceResult::rejected('Resolved category does not belong to the observation contest.')->reason);
    },
    'snapshot duplicate classifier is narrowly constrained' => static function (): void {
        $expected = new PDOException('Duplicate entry'); $expected->errorInfo = ['23000', 1062, "Duplicate entry for key 'uq_score_snapshots_entry_source_fingerprint'"];
        $other = new PDOException('Duplicate entry'); $other->errorInfo = ['23000', 1062, "Duplicate entry for key 'uq_entries_contest_callsign'"];
        assertSameValue(true, PdoIngestionRepository::isExpectedSnapshotDuplicateError($expected));
        assertSameValue(false, PdoIngestionRepository::isExpectedSnapshotDuplicateError($other));
    },
    'ordinary JSON evidence preserves non-canonical insertion order' => static function (): void {
        assertSameValue('{"z":1,"a":2}', JsonCodec::encodeDatabaseValue(['z' => 1, 'a' => 2]));
    },
    'canonical reconciliation fixture preserves policy and event constants' => static function (): void {
        $fixture = canonicalFixture();
        assertSameValue('SINGLE_SOURCE_SEQUENCE', $fixture['selection']['basis']);
        assertSameValue('INITIAL_CANONICAL', $fixture['selection']['initial_reason']);
        assertSameValue('SAME_SOURCE_NONDECREASING_EFFECTIVE_AT', $fixture['selection']['advanced_reason']);
        foreach ($fixture['vectors'] as $vector) assertSameValue($vector['outcome'], SingleSourcePolicy::decide($vector['candidate'], $vector['current']));
        assertSameValue($fixture['out_of_order']['expected_hex'], SnapshotFingerprint::outOfOrderDiagnosticHex($fixture['out_of_order']['snapshot_id']));
        assertSameValue(32, strlen(hex2bin($fixture['out_of_order']['expected_hex']) ?: ''));
        assertSameValue('CANONICAL_INITIAL', CanonicalReconciliationResult::initial('9001')->outcome);
        assertSameValue('9001', CanonicalReconciliationResult::initial('9001')->canonicalEventId);
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

/** @return array<string, mixed> */
function ingestionFixture(): array
{
    $contents = file_get_contents(dirname(__DIR__, 2) . '/fixtures/parity/php-ingestion-persistence-v1.json');
    if ($contents === false) throw new RuntimeException('Ingestion fixture cannot be read.');
    $fixture = json_decode($contents, true, flags: JSON_THROW_ON_ERROR);
    if (!is_array($fixture)) throw new RuntimeException('Ingestion fixture must be an object.');
    return $fixture;
}

/** @return array<string, mixed> */
function canonicalFixture(): array
{
    $contents = file_get_contents(dirname(__DIR__, 2) . '/fixtures/parity/php-canonical-reconciliation-v1.json');
    if ($contents === false) throw new RuntimeException('Canonical fixture cannot be read.');
    $fixture = json_decode($contents, true, flags: JSON_THROW_ON_ERROR);
    if (!is_array($fixture)) throw new RuntimeException('Canonical fixture must be an object.');
    return $fixture;
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
