<?php

declare(strict_types=1);

namespace Araucaria\Livescore\Ingestion;

final readonly class ReceiptResult
{
    public function __construct(public string $rawMessageId, public string $status, public int $observationCount, public int $acceptedCount, public int $duplicateCount, public int $rejectedCount) {}

    public static function finalStatus(int $accepted, int $duplicates, int $rejected): string
    {
        return $rejected > 0 ? (($accepted > 0 || $duplicates > 0) ? 'PARTIAL' : 'FAILED') : 'PROCESSED';
    }
}
