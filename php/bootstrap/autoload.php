<?php

declare(strict_types=1);

if (PHP_VERSION_ID < 80300) {
    throw new RuntimeException('Araucaria LiveScore PHP runtime requires PHP 8.3 or newer.');
}

spl_autoload_register(static function (string $class): void {
    $prefix = 'Araucaria\\Livescore\\';
    if (!str_starts_with($class, $prefix)) {
        return;
    }

    $relative = substr($class, strlen($prefix));
    $path = dirname(__DIR__) . '/src/' . str_replace('\\', '/', $relative) . '.php';
    if (is_file($path)) {
        require $path;
    }
});
