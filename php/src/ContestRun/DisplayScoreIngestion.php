<?php

declare(strict_types=1);

namespace Araucaria\Livescore\ContestRun;

use Araucaria\Livescore\Ingestion\NormalizedIngestionService;
use Araucaria\Livescore\Ingestion\ReceiptResult;
use Araucaria\Livescore\Ingestion\RedactedReceipt;
use Araucaria\Livescore\Support\JsonCodec;
use Araucaria\Livescore\Support\Sha256;
use JsonException;
use RuntimeException;

/** One explicit displayscore fetch/normalize/ingest invocation; not a scheduler. */
final class DisplayScoreIngestion
{
    public function __construct(private readonly DisplayScoreHttpClient $http, private readonly DisplayScoreAdapter $adapter, private readonly NormalizedIngestionService $ingestion) {}
    public function ingest(string $sourceId, string $contestId, int $testId, string $receivedAt, ?string $collectorSourceContestId = null, ?string $collectorRunId = null): ReceiptResult
    {
        $response = $this->http->fetch($testId);
        $redactedPayload = self::redactPayload($response['body']);
        $receipt = new RedactedReceipt($sourceId, $contestId, $collectorSourceContestId, $collectorRunId, $receivedAt, 'CONTEST_RUN_DISPLAYSCORE', 'GET', $response['path'], $response['status'], $response['content_type'], null, $redactedPayload, Sha256::binary($response['body']), ['redacted_keys' => true], ['endpoint' => 'displayscore', 'test_id' => $testId]);
        return $this->ingestion->ingestWithProcessor($receipt, function () use ($response, $receipt): array {
            $batch = $this->adapter->normalizePayload($response['body'], $receipt);
            return [$batch['observations'], $batch['rejected']];
        });
    }
    public static function redactPayload(string $body): string
    {
        try { $value = json_decode($body, true, flags: JSON_THROW_ON_ERROR); }
        catch (JsonException $error) { throw new RuntimeException('contest.run displayscore response is not valid JSON.', previous: $error); }
        if (!is_array($value) || !array_is_list($value)) throw new RuntimeException('contest.run displayscore response must be a JSON array.');
        return JsonCodec::encodeDatabaseValue(array_map(static fn (mixed $row): mixed => is_array($row) ? DisplayScoreAdapter::redactAuth($row) : $row, $value));
    }
}
