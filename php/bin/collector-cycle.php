<?php

declare(strict_types=1);

require dirname(__DIR__) . '/bootstrap/autoload.php';

use Araucaria\Livescore\Collector\CollectorCycleCommand;

function araucariaCollectorCycleMain(): int
{
    return CollectorCycleCommand::run();
}

if (realpath((string) ($_SERVER['SCRIPT_FILENAME'] ?? '')) === __FILE__) {
    exit(araucariaCollectorCycleMain());
}
