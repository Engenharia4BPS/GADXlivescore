<?php

declare(strict_types=1);

use Araucaria\Livescore\Api\ScoreboardRepository;
use Araucaria\Livescore\Config\PrivateRuntimeEnvironment;
use Araucaria\Livescore\Config\RuntimeConfig;
use Araucaria\Livescore\Database\PdoConnectionFactory;

require dirname(__DIR__) . '/bootstrap/autoload.php';

header('Content-Type: application/json; charset=utf-8');
header('Cache-Control: no-store');

if (($_SERVER['REQUEST_METHOD'] ?? 'GET') !== 'GET') {
    scoreboardRespond(405, ['error' => 'method_not_allowed']);
}

try {
    $contestId = scoreboardContestId($_GET['contest_id'] ?? null);
} catch (InvalidArgumentException) {
    scoreboardRespond(400, ['error' => 'invalid_contest_id']);
}

try {
    $environment = PrivateRuntimeEnvironment::fromPhpFile(dirname(__DIR__, 2) . '/config/runtime.php');
    $config = RuntimeConfig::fromEnvironment($environment);
    $entries = (new ScoreboardRepository(PdoConnectionFactory::create($config->database)))
        ->latestAcceptedEntries($contestId);
    scoreboardRespond(200, ['entries' => $entries]);
} catch (Throwable) {
    scoreboardRespond(500, ['error' => 'scoreboard_unavailable']);
}

function scoreboardContestId(mixed $value): ?string
{
    if ($value === null || $value === '') {
        return null;
    }
    if (!is_string($value) || preg_match('/^[1-9][0-9]*$/', $value) !== 1) {
        throw new InvalidArgumentException('contest_id must be a positive integer.');
    }
    return $value;
}

/** @param array<string, mixed> $payload */
function scoreboardRespond(int $status, array $payload): never
{
    http_response_code($status);
    echo json_encode($payload, JSON_THROW_ON_ERROR | JSON_UNESCAPED_SLASHES | JSON_UNESCAPED_UNICODE);
    exit;
}
