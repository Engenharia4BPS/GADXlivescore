<?php

declare(strict_types=1);

namespace Araucaria\Livescore\Config;

use InvalidArgumentException;

/**
 * Parsed only in memory. Its public representation intentionally excludes
 * database credentials and the original URL.
 */
final readonly class DatabaseUrl
{
    private function __construct(
        public string $host,
        public int $port,
        public string $database,
        public string $username,
        public string $password,
    ) {
    }

    public static function parse(string $databaseUrl): self
    {
        if ($databaseUrl === '' || preg_match('/\s/', $databaseUrl) === 1) {
            throw new InvalidArgumentException('DATABASE_URL is malformed.');
        }

        $parts = parse_url($databaseUrl);
        if (!is_array($parts) || ($parts['scheme'] ?? null) !== 'mysql') {
            throw new InvalidArgumentException('DATABASE_URL must use the mysql: scheme.');
        }

        $host = $parts['host'] ?? null;
        $path = $parts['path'] ?? null;
        if (!is_string($host) || $host === '' || !is_string($path) || $path === '/') {
            throw new InvalidArgumentException('DATABASE_URL must include a host and database name.');
        }
        if (preg_match('/[;\x00]/', $host) === 1) {
            throw new InvalidArgumentException('DATABASE_URL host is malformed.');
        }

        $database = rawurldecode(ltrim($path, '/'));
        if ($database === '' || str_contains($database, '/') || preg_match('/[;\x00]/', $database) === 1) {
            throw new InvalidArgumentException('DATABASE_URL must contain exactly one database name.');
        }

        $port = $parts['port'] ?? 3306;
        if (!is_int($port) || $port < 1 || $port > 65535) {
            throw new InvalidArgumentException('DATABASE_URL port is invalid.');
        }

        $username = $parts['user'] ?? '';
        $password = $parts['pass'] ?? '';
        if (!is_string($username) || !is_string($password)) {
            throw new InvalidArgumentException('DATABASE_URL credentials are malformed.');
        }

        return new self(
            $host,
            $port,
            $database,
            rawurldecode($username),
            rawurldecode($password),
        );
    }

    /** @return array{host: string, port: int, database: string} */
    public function sanitizedTarget(): array
    {
        return [
            'host' => $this->host,
            'port' => $this->port,
            'database' => $this->database,
        ];
    }
}
