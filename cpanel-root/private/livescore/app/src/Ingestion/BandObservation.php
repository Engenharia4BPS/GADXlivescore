<?php

declare(strict_types=1);

namespace Araucaria\Livescore\Ingestion;

final readonly class BandObservation
{
    public function __construct(
        public string $band,
        public string $mode,
        public ?string $qso,
        public ?string $points,
        public ?string $mult1,
        public ?string $mult2,
    ) {}

    /** @return array<string, string|null> */
    public function databaseValues(): array
    {
        return ['band' => $this->band, 'mode' => $this->mode, 'qso' => $this->qso, 'points' => $this->points, 'mult1' => $this->mult1, 'mult2' => $this->mult2];
    }
}
