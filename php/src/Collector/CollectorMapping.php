<?php

declare(strict_types=1);

namespace Araucaria\Livescore\Collector;

/** A due, enabled contest.run collector mapping. */
final readonly class CollectorMapping
{
    public function __construct(
        public string $id,
        public string $sourceId,
        public string $contestId,
        public ?string $contestExternalId,
        public ?int $pollIntervalSeconds,
    ) {
    }
}
