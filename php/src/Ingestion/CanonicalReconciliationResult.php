<?php

declare(strict_types=1);

namespace Araucaria\Livescore\Ingestion;

/** Result boundary for one accepted snapshot reconciliation. */
final readonly class CanonicalReconciliationResult
{
    private function __construct(public string $outcome, public ?string $canonicalEventId = null) {}

    public static function initial(string $eventId): self { return new self('CANONICAL_INITIAL', $eventId); }
    public static function advanced(string $eventId): self { return new self('CANONICAL_ADVANCED', $eventId); }
    public static function policy(string $outcome): self { return new self($outcome); }
}
