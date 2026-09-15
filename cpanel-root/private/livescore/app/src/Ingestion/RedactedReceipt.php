<?php

declare(strict_types=1);

namespace Araucaria\Livescore\Ingestion;

use InvalidArgumentException;

/** A receipt at the redaction boundary; no source credentials belong here. */
final readonly class RedactedReceipt
{
    public function __construct(
        public string $sourceId,
        public ?string $contestId,
        public ?string $collectorSourceContestId,
        public ?string $collectorRunId,
        public string $receivedAt,
        public string $messageKind,
        public ?string $requestMethod,
        public ?string $requestPathRedacted,
        public ?int $responseStatus,
        public ?string $responseContentType,
        public mixed $responseHeadersRedacted,
        public string $payloadRedacted,
        public string $payloadSha256,
        public mixed $redactionMetadata,
        public mixed $metadata,
    ) {
        self::id($sourceId, 'source ID');
        foreach ([$contestId, $collectorSourceContestId, $collectorRunId] as $id) {
            if ($id !== null) self::id($id, 'database ID');
        }
        if (strlen($payloadSha256) !== 32) throw new InvalidArgumentException('Payload SHA-256 must be 32 binary bytes.');
    }

    private static function id(string $value, string $field): void
    {
        if (preg_match('/^\d+$/', $value) !== 1) throw new InvalidArgumentException("{$field} must be an unsigned decimal string.");
    }
}
