<?php

declare(strict_types=1);

require dirname(__DIR__) . '/bootstrap/autoload.php';

use Araucaria\Livescore\Collector\CollectorCycleCommand;
use Araucaria\Livescore\Config\PrivateRuntimeEnvironment;

function araucariaCollectorCycleMain(): int
{
    $configurationFile = dirname(__DIR__, 2) . '/config/runtime.php';
    if (!is_file($configurationFile)) {
        return CollectorCycleCommand::run();
    }
    return CollectorCycleCommand::run(PrivateRuntimeEnvironment::fromPhpFile($configurationFile));
}

if (realpath((string) ($_SERVER['SCRIPT_FILENAME'] ?? '')) === __FILE__) {
    exit(araucariaCollectorCycleMain());
}
