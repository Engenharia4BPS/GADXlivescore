<?php

declare(strict_types=1);

namespace Araucaria\Livescore\Ingestion;

final readonly class ObservationPersistenceResult
{
    private function __construct(public string $outcome, public ?string $entryId = null, public ?string $snapshotId = null, public ?string $reason = null) {}
    public static function accepted(string $entryId, string $snapshotId): self { return new self('ACCEPTED', $entryId, $snapshotId); }
    public static function duplicate(string $entryId): self { return new self('DUPLICATE', $entryId); }
    public static function rejected(string $reason): self { return new self('REJECTED', reason: $reason); }
}
