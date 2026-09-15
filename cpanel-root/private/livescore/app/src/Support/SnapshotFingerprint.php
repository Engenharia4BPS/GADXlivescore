<?php

declare(strict_types=1);

namespace Araucaria\Livescore\Support;

use InvalidArgumentException;

/**
 * Minimal PHP implementation of the committed TypeScript snapshot identity
 * shape. It is a parity boundary, not a collector persistence implementation.
 */
final class SnapshotFingerprint
{
    /** @param array<string, mixed> $observation */
    public static function normalizedHex(array $observation): string
    {
        $bands = $observation['bands'] ?? null;
        if (!is_array($bands)) {
            throw new InvalidArgumentException('Fingerprint observation requires a bands array.');
        }
        $normalizedBands = array_map(static function (mixed $band): array {
            if (!is_array($band)) {
                throw new InvalidArgumentException('Fingerprint band must be an object.');
            }
            return [
                'band' => $band['band'] ?? null,
                'mode' => $band['mode'] ?? null,
                'qso' => $band['qso'] ?? null,
                'points' => $band['points'] ?? null,
                'mult1' => $band['mult1'] ?? null,
                'mult2' => $band['mult2'] ?? null,
            ];
        }, $bands);
        usort($normalizedBands, static function (array $left, array $right): int {
            $band = self::asciiField($left['band'], 'band') <=> self::asciiField($right['band'], 'band');
            return $band !== 0
                ? $band
                : self::asciiField($left['mode'], 'mode') <=> self::asciiField($right['mode'], 'mode');
        });

        $value = [
            'version' => 1,
            'source_id' => self::required($observation, 'source_id'),
            'contest_id' => self::required($observation, 'contest_id'),
            'normalized_callsign' => self::required($observation, 'normalized_callsign'),
            'category_id' => $observation['category_id'] ?? null,
            'category_raw' => $observation['category_raw'] ?? null,
            'source_timestamp' => $observation['source_timestamp'] ?? null,
            'source_timestamp_raw' => $observation['source_timestamp_raw'] ?? null,
            'source_timestamp_quality' => $observation['source_timestamp_quality'] ?? null,
            'score' => $observation['score'] ?? null,
            'qso_total' => $observation['qso_total'] ?? null,
            'points_total' => $observation['points_total'] ?? null,
            'mult_total' => $observation['mult_total'] ?? null,
            'source_evidence' => $observation['source_evidence'] ?? null,
            'bands' => $normalizedBands,
        ];
        return Sha256::hex(CanonicalJson::encode($value));
    }

    public static function outOfOrderDiagnosticHex(string $snapshotId): string
    {
        if (preg_match('/^\d+$/', $snapshotId) !== 1) {
            throw new InvalidArgumentException('Snapshot ID must be an unsigned integer.');
        }
        return Sha256::hex('OUT_OF_ORDER|' . $snapshotId);
    }

    private static function required(array $value, string $field): mixed
    {
        if (!array_key_exists($field, $value)) {
            throw new InvalidArgumentException(sprintf('Fingerprint observation requires %s.', $field));
        }
        return $value[$field];
    }

    private static function asciiField(mixed $value, string $field): string
    {
        if (!is_string($value) || $value === '' || preg_match('/^[\x20-\x7E]+$/', $value) !== 1) {
            throw new InvalidArgumentException(sprintf('Fingerprint %s must be non-empty ASCII.', $field));
        }
        return $value;
    }
}
