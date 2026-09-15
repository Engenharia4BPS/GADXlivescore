<?php

declare(strict_types=1);

namespace Araucaria\Livescore\ContestRun;

use RuntimeException;

final class DisplayScoreHttpClient
{
    public function __construct(private readonly string $baseUrl = 'https://contest.run', private readonly int $timeoutSeconds = 20, private readonly int $maximumBytes = 2097152) {}
    /** @return array{body:string,status:int,content_type:?string,path:string} */
    public function fetch(int $testId): array
    {
        if ($testId < 1 || $testId > 2147483647) throw new RuntimeException('contest.run testid must be a positive 32-bit integer.');
        if (!function_exists('curl_init')) throw new RuntimeException('cURL is required for contest.run displayscore.');
        $path = '/api/displayscore/' . $testId; $url = rtrim($this->baseUrl, '/') . $path; $curl = curl_init($url);
        if ($curl === false) throw new RuntimeException('contest.run displayscore request failed.');
        curl_setopt_array($curl, [CURLOPT_HTTPGET => true, CURLOPT_HTTPHEADER => ['Accept: application/json'], CURLOPT_RETURNTRANSFER => true, CURLOPT_FOLLOWLOCATION => false, CURLOPT_TIMEOUT => $this->timeoutSeconds, CURLOPT_CONNECTTIMEOUT => $this->timeoutSeconds, CURLOPT_PROTOCOLS => CURLPROTO_HTTPS]);
        $body = curl_exec($curl); $status = (int) curl_getinfo($curl, CURLINFO_RESPONSE_CODE); $type = curl_getinfo($curl, CURLINFO_CONTENT_TYPE); $error = curl_error($curl); curl_close($curl);
        if (!is_string($body)) throw new RuntimeException($error === '' ? 'contest.run displayscore request failed.' : 'contest.run displayscore request failed.');
        if (strlen($body) > $this->maximumBytes) throw new RuntimeException('contest.run displayscore response exceeds the configured size limit.');
        if ($status < 200 || $status >= 300) throw new RuntimeException("contest.run displayscore returned HTTP {$status}.");
        if (!is_string($type) || !str_contains(strtolower($type), 'application/json')) throw new RuntimeException('contest.run displayscore response is not application/json.');
        return ['body' => $body, 'status' => $status, 'content_type' => $type, 'path' => $path];
    }
}
