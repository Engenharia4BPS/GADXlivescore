<?php

declare(strict_types=1);

header('Content-Type: application/json; charset=utf-8');

$privateHandler = dirname(__DIR__, 3) . '/private/livescore/app/http/scoreboard.php';
if (!is_file($privateHandler)) {
    http_response_code(500);
    echo '{"error":"scoreboard_unavailable"}';
    exit;
}

require $privateHandler;
