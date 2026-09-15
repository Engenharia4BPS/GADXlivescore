<?php

declare(strict_types=1);

namespace Araucaria\Livescore\Ingestion;

use InvalidArgumentException;

final readonly class NormalizedScoreObservation
{
    /** @param list<BandObservation> $bands */
    public function __construct(
        public string $sourceId,
        public string $contestId,
        public string $normalizedCallsign,
        public string $displayCallsign,
        public ?string $categoryId,
        public mixed $categoryRaw,
        public ?string $sourceTimestamp,
        public ?string $sourceTimestampRaw,
        public ?string $sourceTimestampQuality,
        public ?string $score,
        public ?string $qsoTotal,
        public ?string $pointsTotal,
        public ?string $multTotal,
        public mixed $rawMetrics,
        public mixed $fingerprintEvidence,
        public array $bands,
    ) {
        foreach ([$sourceId, $contestId] as $id) if (preg_match('/^\d+$/', $id) !== 1) throw new InvalidArgumentException('Database IDs must be unsigned decimal strings.');
        if ($categoryId !== null && preg_match('/^\d+$/', $categoryId) !== 1) throw new InvalidArgumentException('Category ID must be an unsigned decimal string.');
        foreach ($bands as $band) if (!$band instanceof BandObservation) throw new InvalidArgumentException('Bands must be BandObservation values.');
    }

    /** @return array<string, mixed> */
    public function fingerprintValues(): array
    {
        return [
            'source_id' => $this->sourceId, 'contest_id' => $this->contestId, 'normalized_callsign' => $this->normalizedCallsign,
            'category_id' => $this->categoryId, 'category_raw' => $this->categoryRaw, 'source_timestamp' => $this->sourceTimestamp,
            'source_timestamp_raw' => $this->sourceTimestampRaw, 'source_timestamp_quality' => $this->sourceTimestampQuality,
            'score' => $this->score, 'qso_total' => $this->qsoTotal, 'points_total' => $this->pointsTotal,
            'mult_total' => $this->multTotal, 'source_evidence' => $this->fingerprintEvidence,
            'bands' => array_map(static fn (BandObservation $band): array => $band->databaseValues(), $this->bands),
        ];
    }
}
