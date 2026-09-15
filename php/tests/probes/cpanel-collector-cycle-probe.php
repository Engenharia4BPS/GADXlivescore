<?php

declare(strict_types=1);

/* Guarded real endpoint probe. It invokes the exact command class used by collector-cycle.php. */
require dirname(__DIR__, 3) . '/cpanel-root/private/livescore/app/bootstrap/autoload.php';
require dirname(__DIR__, 3) . '/cpanel-root/private/livescore/app/bin/collector-cycle.php';

use Araucaria\Livescore\Config\DatabaseUrl;
use Araucaria\Livescore\Database\DatabaseSafety;
use Araucaria\Livescore\Database\PdoConnectionFactory;
use Araucaria\Livescore\Support\StructuredLogger;
use Araucaria\Livescore\Support\UtcDateTime;
use PDO;
use RuntimeException;
use Throwable;

if (getenv('PHP_COLLECTOR_TEST_ONLY') !== '1') {
    throw new RuntimeException('Refusing probe without PHP_COLLECTOR_TEST_ONLY=1.');
}
$url = getenv('DATABASE_URL');
if (!is_string($url) || $url === '') {
    throw new RuntimeException('DATABASE_URL is required.');
}
$config = DatabaseUrl::parse($url);
DatabaseSafety::requireUrlDatabase($config, DatabaseSafety::PERCONA57_TEST_DATABASE);
$pdo = PdoConnectionFactory::create($config);
DatabaseSafety::requireTestDatabase($pdo, $config);

$tag = 'php-cycle-' . bin2hex(random_bytes(8));
$ids = ['source' => null, 'contest' => null, 'external' => null, 'mapping' => null, 'run' => null];
$cleaned = false;
try {
    $now = UtcDateTime::utcNow();
    $pdo->prepare("INSERT INTO sources (code, kind, precedence_rank, display_name, enabled, created_at, updated_at) VALUES (?, 'CONTEST_RUN', 1, ?, 1, ?, ?)")
        ->execute([$tag, $tag, $now, $now]);
    $ids['source'] = (string) $pdo->lastInsertId();
    $pdo->prepare("INSERT INTO contests (name, normalized_name, slug, status, created_at, updated_at) VALUES (?, ?, ?, 'SCHEDULED', ?, ?)")
        ->execute([$tag, $tag, $tag, $now, $now]);
    $ids['contest'] = (string) $pdo->lastInsertId();
    $pdo->prepare('INSERT INTO contest_external_ids (contest_id, source_id, external_id, created_at, updated_at) VALUES (?, ?, ?, ?, ?)')
        ->execute([$ids['contest'], $ids['source'], '108', $now, $now]);
    $ids['external'] = (string) $pdo->lastInsertId();
    $pdo->prepare('INSERT INTO collector_source_contests (source_id, contest_id, contest_external_id_id, enabled, poll_interval_seconds, configuration, last_success_at, last_failure_at, next_poll_at, created_at, updated_at) VALUES (?, ?, ?, 1, 60, NULL, NULL, NULL, NULL, ?, ?)')
        ->execute([$ids['source'], $ids['contest'], $ids['external'], $now, $now]);
    $ids['mapping'] = (string) $pdo->lastInsertId();
    putenv('PHP_COLLECTOR_TEST_MAPPING_ID=' . $ids['mapping']);

    $exit = araucariaCollectorCycleMain();
    assertProbe($exit === 0, 'collector cycle exit');
    $run = one($pdo, 'SELECT id, outcome, request_count, received_message_count FROM collector_runs WHERE collector_source_contest_id = ?', [$ids['mapping']]);
    $ids['run'] = (string) $run['id'];
    assertProbe($run['outcome'] === 'SUCCESS' && (int) $run['request_count'] === 1 && (int) $run['received_message_count'] === 1, 'collector run completion');
    $receipt = one($pdo, 'SELECT processing_status, collector_source_contest_id, collector_run_id, request_method, request_path_redacted, response_status, payload_redacted FROM raw_messages WHERE source_id = ? AND contest_id = ?', [$ids['source'], $ids['contest']]);
    assertProbe(in_array($receipt['processing_status'], ['PROCESSED', 'PARTIAL'], true), 'normalized receipt status');
    assertProbe((string) $receipt['collector_source_contest_id'] === $ids['mapping'] && (string) $receipt['collector_run_id'] === $ids['run'], 'receipt collector linkage');
    assertProbe($receipt['request_method'] === 'GET' && $receipt['request_path_redacted'] === '/api/displayscore/108' && (int) $receipt['response_status'] === 200, 'displayscore request evidence');
    assertProbe(!str_contains((string) $receipt['payload_redacted'], '"auth"'), 'redacted payload');
    $mapping = one($pdo, 'SELECT last_success_at, next_poll_at FROM collector_source_contests WHERE id = ?', [$ids['mapping']]);
    assertProbe($mapping['last_success_at'] !== null && $mapping['next_poll_at'] !== null, 'mapping success schedule');
    cleanup($pdo, $ids); $cleaned = true;
    assertProbe(remaining($pdo, $ids) === 0, 'fixture cleanup');
    StructuredLogger::event('PHP_COLLECTOR_CYCLE_PROBE_PASS', ['fixture' => $tag, 'schema' => DatabaseSafety::PERCONA57_TEST_DATABASE, 'test_id' => 108, 'collector_cycle' => 'one_bounded_mapping', 'cleanup' => true]);
} catch (Throwable $error) {
    if (!$cleaned) {
        try { cleanup($pdo, $ids); } catch (Throwable) { throw new RuntimeException('collector-cycle probe failed and fixture cleanup failed.'); }
    }
    throw $error;
} finally {
    putenv('PHP_COLLECTOR_TEST_MAPPING_ID');
}

function cleanup(PDO $pdo, array $ids): void
{
    if ($ids['contest'] === null) return;
    $pdo->prepare('DELETE FROM current_scores WHERE entry_id IN (SELECT id FROM entries WHERE contest_id = ?)')->execute([$ids['contest']]);
    foreach (['score_snapshot_flags' => 'snapshot_id', 'canonical_score_events' => 'score_snapshot_id', 'band_snapshots' => 'snapshot_id'] as $table => $column) {
        $pdo->prepare("DELETE FROM {$table} WHERE {$column} IN (SELECT id FROM score_snapshots WHERE contest_id = ?)")->execute([$ids['contest']]);
    }
    $pdo->prepare('DELETE FROM score_snapshots WHERE contest_id = ?')->execute([$ids['contest']]);
    if ($ids['source'] !== null) $pdo->prepare('DELETE FROM raw_messages WHERE source_id = ?')->execute([$ids['source']]);
    $pdo->prepare('DELETE FROM entries WHERE contest_id = ?')->execute([$ids['contest']]);
    if ($ids['mapping'] !== null) $pdo->prepare('DELETE FROM collector_runs WHERE collector_source_contest_id = ?')->execute([$ids['mapping']]);
    if ($ids['mapping'] !== null) $pdo->prepare('DELETE FROM collector_source_contests WHERE id = ?')->execute([$ids['mapping']]);
    if ($ids['external'] !== null) $pdo->prepare('DELETE FROM contest_external_ids WHERE id = ?')->execute([$ids['external']]);
    $pdo->prepare('DELETE FROM contests WHERE id = ?')->execute([$ids['contest']]);
    if ($ids['source'] !== null) $pdo->prepare('DELETE FROM sources WHERE id = ?')->execute([$ids['source']]);
}

function remaining(PDO $pdo, array $ids): int
{
    $total = 0;
    foreach ([['sources', 'id', $ids['source']], ['contests', 'id', $ids['contest']], ['contest_external_ids', 'id', $ids['external']], ['collector_source_contests', 'id', $ids['mapping']], ['collector_runs', 'collector_source_contest_id', $ids['mapping']]] as [$table, $column, $id]) {
        if ($id !== null) $total += countOf($pdo, "SELECT COUNT(*) FROM {$table} WHERE {$column} = ?", [$id]);
    }
    if ($ids['source'] !== null) $total += countOf($pdo, 'SELECT COUNT(*) FROM raw_messages WHERE source_id = ?', [$ids['source']]);
    if ($ids['contest'] !== null) $total += countOf($pdo, 'SELECT COUNT(*) FROM entries WHERE contest_id = ?', [$ids['contest']]) + countOf($pdo, 'SELECT COUNT(*) FROM score_snapshots WHERE contest_id = ?', [$ids['contest']]);
    return $total;
}

function one(PDO $pdo, string $sql, array $parameters): array
{
    $statement = $pdo->prepare($sql); $statement->execute($parameters); $row = $statement->fetch(PDO::FETCH_ASSOC);
    if (!is_array($row)) throw new RuntimeException('Probe expected row.');
    return $row;
}

function countOf(PDO $pdo, string $sql, array $parameters): int
{
    $statement = $pdo->prepare($sql); $statement->execute($parameters); return (int) $statement->fetchColumn();
}

function assertProbe(bool $value, string $name): void
{
    if (!$value) throw new RuntimeException("Probe assertion failed: {$name}");
}
