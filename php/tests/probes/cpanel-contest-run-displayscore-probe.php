<?php

declare(strict_types=1);

/* Explicit Phase MVP integration command; never invoked by collector-cycle.php. */
require dirname(__DIR__, 3) . '/cpanel-root/private/livescore/app/bootstrap/autoload.php';

use Araucaria\Livescore\Config\DatabaseUrl;
use Araucaria\Livescore\ContestRun\DisplayScoreAdapter;
use Araucaria\Livescore\ContestRun\DisplayScoreHttpClient;
use Araucaria\Livescore\ContestRun\DisplayScoreIngestion;
use Araucaria\Livescore\Database\DatabaseSafety;
use Araucaria\Livescore\Database\PdoConnectionFactory;
use Araucaria\Livescore\Ingestion\NormalizedIngestionService;
use Araucaria\Livescore\Ingestion\PdoIngestionRepository;
use Araucaria\Livescore\Support\StructuredLogger;

if (getenv('PHP_COLLECTOR_TEST_ONLY') !== '1') throw new \RuntimeException('Refusing probe without PHP_COLLECTOR_TEST_ONLY=1.');
$url = getenv('DATABASE_URL'); if (!is_string($url) || $url === '') throw new \RuntimeException('DATABASE_URL is required.');
$config = DatabaseUrl::parse($url); DatabaseSafety::requireUrlDatabase($config, DatabaseSafety::PERCONA57_TEST_DATABASE);
$pdo = PdoConnectionFactory::create($config); DatabaseSafety::requireTestDatabase($pdo, $config);
$tag = 'php-cr-mvp-' . bin2hex(random_bytes(8)); $ids = ['source'=>null,'contest'=>null]; $cleaned = false;
try {
    $now = \Araucaria\Livescore\Support\UtcDateTime::utcNow();
    $pdo->prepare("INSERT INTO sources (code,kind,precedence_rank,display_name,enabled,created_at,updated_at) VALUES (?,'CONTEST_RUN',1,?,1,?,?)")->execute([$tag,$tag,$now,$now]); $ids['source']=(string)$pdo->lastInsertId();
    $pdo->prepare("INSERT INTO contests (name,normalized_name,slug,status,created_at,updated_at) VALUES (?,?,?,'SCHEDULED',?,?)")->execute([$tag,$tag,$tag,$now,$now]); $ids['contest']=(string)$pdo->lastInsertId();
    $service = new NormalizedIngestionService(new PdoIngestionRepository($pdo));
    // 108 is the documented, known displayscore fixture ID; no user URL or credential is accepted.
    $result = (new DisplayScoreIngestion(new DisplayScoreHttpClient(), new DisplayScoreAdapter(), $service))->ingest($ids['source'],$ids['contest'],108,$now);
    StructuredLogger::event('CONTEST_RUN_DISPLAYSCORE_PROBE_RESULT',['fixture'=>$tag,'schema'=>DatabaseSafety::PERCONA57_TEST_DATABASE,'test_id'=>108,'status'=>$result->status,'observations'=>$result->observationCount,'accepted'=>$result->acceptedCount,'duplicates'=>$result->duplicateCount,'rejected'=>$result->rejectedCount]);
    cleanup($pdo,$ids);$cleaned=true;
} catch (Throwable $error) { if(!$cleaned){try{cleanup($pdo,$ids);}catch(Throwable){throw new \RuntimeException('contest.run probe failed and fixture cleanup failed.');}} throw $error; }
function cleanup(\PDO $pdo,array $ids):void{if($ids['contest']===null)return;$pdo->prepare('DELETE FROM current_scores WHERE entry_id IN (SELECT id FROM entries WHERE contest_id=?)')->execute([$ids['contest']]);foreach(['score_snapshot_flags'=>'snapshot_id','canonical_score_events'=>'score_snapshot_id','band_snapshots'=>'snapshot_id']as$table=>$column)$pdo->prepare("DELETE FROM {$table} WHERE {$column} IN (SELECT id FROM score_snapshots WHERE contest_id=?)")->execute([$ids['contest']]);$pdo->prepare('DELETE FROM score_snapshots WHERE contest_id=?')->execute([$ids['contest']]);if($ids['source']!==null)$pdo->prepare('DELETE FROM raw_messages WHERE source_id=?')->execute([$ids['source']]);$pdo->prepare('DELETE FROM entries WHERE contest_id=?')->execute([$ids['contest']]);$pdo->prepare('DELETE FROM contests WHERE id=?')->execute([$ids['contest']]);if($ids['source']!==null)$pdo->prepare('DELETE FROM sources WHERE id=?')->execute([$ids['source']]);}
