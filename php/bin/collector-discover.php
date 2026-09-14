<?php

declare(strict_types=1);

require dirname(__DIR__) . '/bootstrap/autoload.php';

use Araucaria\Livescore\Support\StructuredLogger;

StructuredLogger::event('COLLECTOR_DISCOVER_NOT_IMPLEMENTED', [
    'error_code' => 'PHP_COLLECTOR_DISCOVERY_PENDING',
]);
exit(64);
