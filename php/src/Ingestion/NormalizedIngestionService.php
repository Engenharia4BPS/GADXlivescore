<?php

declare(strict_types=1);

namespace Araucaria\Livescore\Ingestion;

/** Receipt-first orchestration for observations normalized before this boundary. */
final class NormalizedIngestionService
{
    public function __construct(private readonly PdoIngestionRepository $repository) {}

    /** @param list<NormalizedScoreObservation> $observations @param list<array{index:int,error:string}> $rejected */
    public function ingest(RedactedReceipt $receipt, array $observations, array $rejected = []): ReceiptResult
    {
        return $this->ingestWithProcessor($receipt, static fn (): array => [$observations, $rejected]);
    }

    /**
     * Runs a normalized adapter callback only after its receipt is durable and
     * claimed. This is also the explicit test seam for adapter failure evidence.
     * @param callable(string):array{0:list<NormalizedScoreObservation>,1:list<array{index:int,error:string}>} $processor
     */
    public function ingestWithProcessor(RedactedReceipt $receipt, callable $processor): ReceiptResult
    {
        $rawMessageId = $this->repository->createReceipt($receipt); // intentionally committed before claim/persistence
        $this->repository->claim($rawMessageId, $receipt->receivedAt);
        $accepted = 0; $duplicates = 0; $rejectedCount = 0; $observationCount = 0;
        try {
            [$observations, $rejected] = $processor($rawMessageId);
            $rejectedCount = count($rejected);
            $observationCount = count($observations) + $rejectedCount;
            $persisted = $this->repository->persistObservations($rawMessageId, $receipt->receivedAt, $observations);
            foreach ($persisted as $result) {
                if ($result->outcome === 'ACCEPTED') $accepted++;
                elseif ($result->outcome === 'DUPLICATE') $duplicates++;
                else $rejectedCount++;
            }
            $result = new ReceiptResult($rawMessageId, ReceiptResult::finalStatus($accepted, $duplicates, $rejectedCount), $observationCount, $accepted, $duplicates, $rejectedCount);
            $persistenceRejections = array_values(array_map(static fn (ObservationPersistenceResult $result): array => ['outcome' => $result->outcome, 'reason' => $result->reason], array_filter($persisted, static fn (ObservationPersistenceResult $result): bool => $result->outcome === 'REJECTED')));
            $this->repository->finish($rawMessageId, $result, $rejectedCount > 0 ? ['rejected_rows' => $rejected, 'persistence_rejections' => $persistenceRejections] : null);
            return $result;
        } catch (\Throwable $error) {
            $result = new ReceiptResult($rawMessageId, 'FAILED', $observationCount, $accepted, $duplicates, $rejectedCount);
            $this->repository->finish($rawMessageId, $result, ['error' => self::safeError($error)]);
            return $result;
        }
    }

    private static function safeError(\Throwable $error): string
    {
        $message = $error->getMessage();
        return preg_match('/password|token|secret|authorization|mysql:/i', $message) === 1 ? 'Normalized observation persistence failure.' : substr($message, 0, 512);
    }
}
