# Database Design

## Scope

This document defines the Phase 1 MySQL persistence model. MySQL is Araucaria LiveScore's source of truth. The schema stores source receipts, normalized observations, canonical selections, and collector execution history. It does not implement collection, APIs, WebSockets, analytics jobs, or logger ingest.

The initial migration targets the validated production family: Percona Server 5.7.44-48 with InnoDB, `utf8mb4`, and `utf8mb4_unicode_ci`. It deliberately avoids MySQL 8-only features such as enforced check constraints, functional indexes, descending indexes, `SKIP LOCKED`, and MySQL 8 collations.

## Connection Policy

Every application connection is bootstrapped locally; the application must never change global server settings. Before using a connection, `@araucaria/database` executes:

```sql
SET SESSION time_zone = '+00:00';
SET SESSION sql_mode = 'ONLY_FULL_GROUP_BY,STRICT_TRANS_TABLES,NO_ZERO_IN_DATE,NO_ZERO_DATE,ERROR_FOR_DIVISION_BY_ZERO,NO_ENGINE_SUBSTITUTION';
SET SESSION innodb_strict_mode = ON;
```

All persisted operational timestamps are `DATETIME(6)` and are written as UTC by the application. Source-provided time values whose zone or semantics are unresolved remain in their source/raw form instead of being converted speculatively.

## Tables

| Table | Purpose | Primary write path | Primary read path |
| --- | --- | --- | --- |
| `sources` | Source registry, kind, precedence, and default configuration. | Source administration/seed data. | Collection and reconciliation. |
| `contests` | Canonical contest identity. | Discovery reconciliation/admin data. | Entries, scores, UI/API later. |
| `contest_external_ids` | A source's contest identifier and observed calendar metadata. | Discovery normalization. | Source adapters and collector configuration. |
| `contest_categories` | Canonical per-contest categories. | Category normalization. | Entries and historical snapshots. |
| `contest_category_external_ids` | Source-category mapping with contest integrity. | Category normalization. | Source adapters. |
| `entries` | Canonical participant identity. | Score normalization/upsert. | Scores and analytics. |
| `collector_source_contests` | Enabled source/contest collection configuration and health state. | Collector administration later. | Collector coordination. |
| `collector_runs` | A collector execution and its environment-scoped advisory lock context. | Collector execution later. | Collector health administration. |
| `raw_messages` | One received payload, before and through normalization. | Receipt transaction. | Recovery, audit, diagnostics. |
| `score_snapshots` | Immutable accepted, normalized, non-duplicate entry observations. | Normalization transaction. | Reconciliation and audit. |
| `band_snapshots` | Supplemental per-band/mode values belonging to a score snapshot. | Normalization transaction. | Score detail and analytics. |
| `score_snapshot_flags` | Immutable post-insert diagnostics about a snapshot. | Reconciliation/diagnostics. | Audit and source-quality analysis. |
| `canonical_score_events` | Append-only canonical timeline; one selected snapshot per event. | Reconciliation transaction. | Analytics and current-score projection. |
| `current_scores` | Fast current canonical pointer for each entry. | Reconciliation transaction. | Future API/frontend reads. |

`outbound_deliveries` is intentionally absent: no MVP feature has an outbound delivery requirement. `ingest_credentials` is intentionally absent until N1MM/DXLog authentication compatibility is settled.

## Physical Schema Reference

The migration is authoritative for exact MySQL types, nullability, keys, and index names. The following compact reference makes the relationship design explicit:

| Table | Key columns and physical types | Candidate keys and relationship indexes |
| --- | --- | --- |
| `sources` | `id BIGINT UNSIGNED`; binary ASCII `code`, `kind`; `precedence_rank TINYINT UNSIGNED`; JSON configuration. | PK `id`; unique `code`; enabled/precedence index. |
| `contests` | `id BIGINT UNSIGNED`; name/status; nullable `DATETIME(6)` canonical bounds; JSON metadata. | PK `id`; unique binary ASCII `slug`; status/start and normalized-name indexes. |
| `contest_external_ids` | IDs plus binary external ID; opaque calendar code/day/time fields; JSON metadata. | PK `id`; unique `(source_id, external_id)`, `(id, contest_id)`, `(id, contest_id, source_id)`; restrictive FKs to contest and source. |
| `contest_categories` | IDs plus binary ASCII category key; display name, active flag, JSON metadata. | PK `id`; unique `(contest_id, category_key)` and `(id, contest_id)`; restrictive FK to contest. |
| `contest_category_external_ids` | IDs for canonical contest/category/external-contest mapping; binary source category ID; JSON metadata. | PK `id`; unique `(contest_external_id_id, external_category_id)`; composite restrictive FKs keep category and external contest in the same canonical contest. |
| `entries` | `id BIGINT UNSIGNED`; contest ID; binary ASCII normalized callsign; nullable current category. | PK `id`; unique `(contest_id, normalized_callsign)` and `(id, contest_id)`; composite category/contest FK. |
| `collector_source_contests` | Source/contest IDs, nullable external contest ID, poll configuration and health timestamps. | PK `id`; unique `(source_id, contest_id)` and external ID; a three-column restrictive FK ensures its external ID belongs to that source and contest. |
| `collector_runs` | IDs, binary environment/lock/run/outcome fields, `DATETIME(6)` lifecycle timestamps, counts, JSON diagnostics. | PK `id`; source/mapping/outcome time indexes; restrictive FKs to source and collector mapping. |
| `raw_messages` | IDs, receipt and recovery timestamps, unsigned processing counts, redacted HTTP metadata and `LONGBLOB`, `BINARY(32)` original hash, JSON errors. | PK `id`; candidate key `(id, source_id)`; receipt/status/run indexes; restrictive FKs to source, contest, mapping, and run. |
| `score_snapshots` | IDs, category/source/raw references, nullable `DATETIME(6)` source time, signed `BIGINT` totals, JSON fields, `BINARY(32)` fingerprint. | PK `id`; unique `(entry_id, source_id, normalized_fingerprint)` and `(id, entry_id)`; entry/contest, source, raw/source, and category/contest restrictive FKs. |
| `band_snapshots` | Snapshot ID plus binary ASCII band/mode; nullable signed `BIGINT` counters. | Composite PK `(snapshot_id, band, mode)`; restrictive snapshot FK. |
| `score_snapshot_flags` | `id BIGINT UNSIGNED`; snapshot ID; binary ASCII flag; detection timestamp; JSON details; `BINARY(32)` diagnostic fingerprint. | PK `id`; unique `(snapshot_id, diagnostic_fingerprint)`; diagnostic indexes and restrictive snapshot FK. |
| `canonical_score_events` | `id BIGINT UNSIGNED`; entry/snapshot IDs; selected/effective `DATETIME(6)`; binary selection basis; JSON context. | PK `id`; unique selected snapshot and `(id, entry_id, score_snapshot_id)`; effective/selected timeline indexes; restrictive snapshot/entry FK. |
| `current_scores` | `entry_id BIGINT UNSIGNED`; canonical event/snapshot IDs; `updated_at DATETIME(6)`. | PK `entry_id`; unique event and snapshot pointers; composite restrictive FK validates both pointers against one canonical event. |

## Identity And Relationships

`entries` uses the MVP identity `UNIQUE (contest_id, normalized_callsign)`; category is not part of the identity. Callsigns, source codes, source/category external IDs, bands, and modes use explicit binary collations so their comparison behavior cannot inherit a server default.

Categories are enforced as contest-local:

- `contest_categories` has candidate key `(id, contest_id)`.
- `entries (current_category_id, contest_id)` references that candidate key.
- `contest_category_external_ids` includes `contest_id` and references both the canonical category and external contest identity through contest-scoped composite foreign keys.
- Historical `score_snapshots (category_id, contest_id)` carries the same protection while allowing both category fields to be null.

All identity and historical foreign keys specify `ON DELETE RESTRICT ON UPDATE RESTRICT`. Score history cannot be deleted by removing an entry, source, contest, or raw payload.

## External Contest Calendar Data

`contest_external_ids` retains `external_calendar_code`, `start_day`, `start_time`, `finish_day`, `finish_time`, and flexible `metadata`. This preserves contest.run observations such as `dat = "902"` without assigning an unsupported meaning or deriving absolute `start_at`/`end_at`. Canonical contest dates are nullable and may only be set from evidence with resolved semantics.

## Receipt And Normalization Lifecycle

`raw_messages` represents a received payload, not a station observation. It is committed first, including successful, duplicate, heartbeat, parse-failure, and validation-failure receipts. Its allowed workflow states are `RECEIVED`, `PROCESSING`, `PROCESSED`, `PARTIAL`, and `FAILED`.

`processing_attempts`, `processing_started_at`, and `processed_at` enable interrupted-processing recovery. The counts `observation_count`, `accepted_count`, `duplicate_count`, and `rejected_count` describe the batch outcome. A payload with mixed results is `PARTIAL`; a duplicate station row never makes a whole payload `DUPLICATE`.

Before a raw payload is persisted, sensitive external fields such as contest.run `auth` are redacted. `payload_redacted` stores only the sanitized payload, while `payload_sha256` retains an SHA-256 hash of the original unredacted response for audit integrity. Neither the original field nor its raw value may be logged, exposed, or committed in fixtures.

Normalization is idempotent at observation level. It computes a SHA-256 `normalized_fingerprint` from a versioned, canonical serialization of the source ID, entry identity, observed category representation, source timestamp representation, authoritative aggregate totals, supplemental band rows, and other normalized observed fields. Stable key ordering, explicit nulls, and normalized external types are required. The unique key `(entry_id, source_id, normalized_fingerprint)` prevents duplicate snapshots while allowing equal competitive totals with a changed source timestamp to be accepted as a reporting update.

`score_snapshots` is immutable. It accepts signed `BIGINT` totals and per-band counters specifically so resets, corrections, and negative values can be preserved. Aggregate `score`, `qso_total`, `points_total`, and `mult_total` are source-authoritative and are never recomputed from `band_snapshots`; band rows are supplemental observations.

Facts known at insertion can be written to `score_snapshots.anomaly_flags`. Facts discovered later, such as `OUT_OF_ORDER` or `SOURCE_DIVERGENCE`, are appended to `score_snapshot_flags`; reconciliation never updates an existing snapshot to attach such diagnostics.

## Transaction Boundaries

Receipt, normalization, and reconciliation are deliberately separated:

1. **Receipt transaction:** insert one `raw_messages` row as `RECEIVED`, containing the sanitized payload, original-payload hash, and transport metadata, then commit. This guarantees an audit/recovery record even if process interruption follows.
2. **Claim:** update the independently durable receipt from `RECEIVED` to `PROCESSING` and increment `processing_attempts`.
3. **Normalization transaction:** normalize each constituent observation and atomically insert only non-duplicate `score_snapshots` and their `band_snapshots`. The unique normalized fingerprint makes a repeated attempt idempotent; a rollback returns no accepted snapshot result. Parse and validation errors remain represented in the raw payload and contribute to `PARTIAL` or `FAILED` as appropriate.
4. **Reconciliation transaction:** for each accepted snapshot, lock its entry with `SELECT ... FOR UPDATE`, evaluate canonical policy, and append any `score_snapshot_flags` and canonical event. If a canonical event is appended, insert or update its `current_scores` row in that same transaction. The composite current-score foreign key prevents an event pointer and snapshot pointer from being mixed across events.
5. **Final receipt update:** record the committed accepted/duplicate/rejected counts and final payload status only after the corresponding persistence outcome is known.

The raw receipt row is the only mutable record in the first two boundaries. Snapshots, band rows, snapshot flags, and canonical events are append-only.

## Phase 2D Ingestion Write Path

`@araucaria/collector-ingestion` persists a source-neutral receipt first, calculating its original SHA-256 before recursively removing sensitive payload and HTTP metadata keys. It then claims the receipt and parses a batch independently: malformed rows are recorded as rejected while valid rows continue. An entirely invalid batch is `FAILED`; a mixed batch is `PARTIAL`.

Each valid observation resolves the established `(contest_id, normalized_callsign)` entry identity, validates any category against the same contest, and creates an append-only snapshot. The fingerprint is SHA-256 over deterministic UTF-8 JSON with sorted object keys and sorted `(band, mode)` rows. It includes source/contest/entry identity, category and timestamp evidence, authoritative aggregate metrics, explicitly admitted source evidence, and bands; it excludes raw/unmapped metadata, receipt and HTTP transport data, processing/retry/collector-run data, and redaction bookkeeping. The repository checks the named unique fingerprint boundary before a normal insert and translates only `ER_DUP_ENTRY`/1062 for `uq_score_snapshots_entry_source_fingerprint` (including a concurrent insert race) to `DUPLICATE`; every other database error aborts the batch transaction. Band rows are inserted only after their snapshot insert succeeds. Aggregate totals are never recomputed from supplemental band rows.

## Phase 2D Single-Source Canonical Timeline

Phase 2D implements a deliberately minimal, deterministic `SINGLE_SOURCE_SEQUENCE` policy. It is not the final multi-source reconciliation algorithm. An automatically eligible snapshot must be `ACCEPTED`, have a non-null `source_timestamp`, and have `source_timestamp_quality = CONFIRMED_UTC`. A null or unresolved source timestamp remains valid historical evidence but does not produce a canonical event; `received_at` is never substituted.

For an entry with no current row, an eligible snapshot creates an `INITIAL_CANONICAL` event. If the current canonical snapshot is from the same source, an eligible candidate advances when its timestamp is equal to or later than the current `effective_at`, using `SAME_SOURCE_NONDECREASING_EFFECTIVE_AT`. Equal source times support a distinct correction at the same effective instant; timestamp-only updates and counter resets are eligible to advance. The event uses the snapshot source timestamp for `effective_at` and the application UTC reconciliation clock for `selected_at`.

For the same source, a candidate timestamp older than the current effective time is retained but produces no event or projection update. Reconciliation instead appends one idempotent `OUT_OF_ORDER` flag with SHA-256 diagnostic fingerprint `OUT_OF_ORDER | snapshot_id`; it does not mutate the snapshot. When a current canonical snapshot is from another source, the candidate remains historical and the policy returns `DEFERRED_CROSS_SOURCE_POLICY` without changing the canonical event or `current_scores`.

Source precedence, freshness thresholds, poll-interval stale calculation, completeness, source health, timestamp-quality ranking, source-divergence switching, and all `DIRECT`/`FEDERATION`/`EXTERNAL`/`MANUAL` cross-source selection remain explicitly reserved for the future multi-source reconciliation phase.

For an accepted snapshot, reconciliation may append exactly one `canonical_score_events` row. The event references one snapshot and separates:

- `selected_at`: when Araucaria chose the snapshot.
- `effective_at`: the competitive/source time represented by that snapshot.

The Phase 2D policy must not append an event with `effective_at` earlier than the entry's latest same-source canonical event. A late snapshot is retained and receives the idempotent `OUT_OF_ORDER` diagnostic, but it cannot move the canonical sequence backward.

In the same database transaction that inserts a canonical event, the application inserts or updates `current_scores`. It has exactly one row per `entry_id`, and its `canonical_event_id` and `canonical_snapshot_id` are validated together by a composite foreign key to the same canonical event. This maintains the intentionally denormalized fast-read pointers atomically.

Analytics reads `canonical_score_events`, not arbitrary source snapshots. A DM7EE-style reset is an accepted immutable snapshot and can become a canonical event when selection rules permit. A timestamp-only update is also an accepted snapshot when its fingerprint changes, but analytics must not infer QSO or score activity unless the corresponding competitive metrics changed.

## Source Activity Vocabulary

The collector and analytics layers keep these concepts separate:

| Term | Meaning |
| --- | --- |
| `PRESENT` | A row exists in a source response. |
| `FRESH` | Its source timestamp is within the configured freshness threshold. |
| `REPORTING` | Its source timestamp advanced since the preceding accepted observation. |
| `SCORING` | One or more competitive metrics changed. |

Presence in contest.run `displayscore` does not prove activity. Freshness defaults and any cross-source reconciliation window are future application configuration, not Phase 2D policy or schema constraints. Each collector mapping acquires its own bounded, environment-scoped MySQL advisory lock, `als:<environment>:csc:<collector_source_contest_id>`, using a dedicated physical connection; the schema records that lock context in `collector_runs` but does not attempt to model lock ownership as durable state.

## Phase 2E.5 Polling Execution Contract

`CollectorPollingService.runCycle` selects only enabled
`collector_source_contests` whose `next_poll_at` is null or due at the
application UTC clock. Selection is bounded and ordered deterministically:
null `next_poll_at` first, then `next_poll_at`, then mapping ID. An enabled
mapping with a null, zero, or invalid `poll_interval_seconds` is reported as
`INVALID_CONFIGURATION`; it is not silently assigned a fallback interval.

For each valid mapping, the service opens a pinned mysql2 physical session and
attempts non-blocking `GET_LOCK(lock_name, 0)`. A losing worker returns
`LOCKED_BY_OTHER` without an HTTP call, raw receipt, collector-run row, or
scheduling mutation. Different mapping IDs use different lock names and can
therefore execute concurrently.

Only a lock owner inserts a `collector_runs` row, initially `RUNNING`, before
the source HTTP request. The source runner delegates receipt redaction, raw
receipt durability, normalization, deduplication, and snapshot persistence to
`CollectorIngestionService`; its receipt carries the source, contest, mapping,
and collector-run IDs. One displayscore request increments `request_count` by
one; one durable raw receipt increments `received_message_count` by one, never
by the number of score rows.

No database transaction is held during HTTP or ingestion. After the source
operation, one short transaction finalizes `collector_runs` as `SUCCESS` or
`FAILED` and updates the mapping: success writes `last_success_at`, failure
writes `last_failure_at`, and both move `next_poll_at` to completion UTC plus
the configured interval. There is no backoff or retry policy in this phase. A
release anomaly is surfaced as a sanitized failure and causes a corrective
failed finalization; locks are always released and sessions closed in `finally`.

### Real Percona 5.7 Polling Validation

The guarded polling harness passed against Percona Server 5.7.44-48 on
`dxarauca_livescore_test`. It selected a due mapping, acquired its per-mapping
advisory lock, and finalized one `collector_runs` row from `RUNNING` to
`SUCCESS`. The run recorded `request_count = 1` and
`received_message_count = 1`: the latter is one durable HTTP receipt, not five
score rows. That raw message linked to both its collector run and mapping, and
five snapshots persisted.

The successful run advanced `last_success_at` and `next_poll_at`. An immediate
second cycle made zero HTTP requests because the mapping was not due. Explicit
contention returned `LOCKED_BY_OTHER`; the losing worker made zero HTTP
requests, created zero `collector_runs`, and did not mutate scheduling. Advisory
lock release was verified. The persisted contest.run observations remained
`UNZONED_SOURCE_TEXT` and ineligible for canonical selection, so
`canonicalEventCount = 0` and `currentScoreCount = 0`. Fixture cleanup verified
zero remaining rows.

Stale `RUNNING` recovery, abandoned-run recovery after a crash, retry/backoff,
jitter, and continuous daemon/runtime-loop scheduling remain deferred.

## Migration And Validation

`dbmate` uses `DATABASE_URL` and migration files under `database/migrations`. `db:migrate` deliberately disables dbmate schema dumping, because the migration file is the reviewed schema source. The repository provides a validation utility that confirms the required Percona 5.7 session policy, tables, columns, binary identity collations, named integrity foreign keys, required unique indexes, and restrictive foreign-key actions.

Use the designated test schema only: `dxarauca_livescore_test`. The validator and integration runner reject every other database name, including production `dxarauca_livescore`.

```powershell
$env:DATABASE_URL = $env:PERCONA57_DATABASE_URL
corepack.cmd pnpm run db:migrate
corepack.cmd pnpm run db:percona57:validate
```

The integration validation must be run against an actual disposable Percona 5.7 instance before a migration is approved for production. No migration command changes server-global variables.

### Real Percona 5.7 Validation

The following results were observed on the actual Percona Server 5.7.44-48, Release 48 target environment using only `dxarauca_livescore_test`; they are not inferred from static DDL inspection. The host-side server default charset/collation is `utf8`/`utf8_unicode_ci` and its `SYSTEM` timezone is `-03`. Application connections must still set the session timezone to `+00:00`, and every application table explicitly uses `utf8mb4`/`utf8mb4_unicode_ci`.

Structural validation passed: migration up succeeded; all 14 expected tables were created with InnoDB and `utf8mb4_unicode_ci`; 25 foreign keys were observed; and every observed foreign key uses `DELETE RESTRICT` / `UPDATE RESTRICT`.

Behavioral validation passed:

- Normal accepted snapshots, timestamp-only updates, and a single raw batch producing multiple accepted snapshots.
- The DM7EE-style resets `36594 -> 0` score, `342 -> 0` QSO, and `107 -> 0` multiplier, preserved unchanged.
- Source-authoritative aggregate totals that differ from supplemental band sums.
- Matching `canonical_score_events` / `current_scores` pointers.
- An `OUT_OF_ORDER` `score_snapshot_flags` diagnostic appended without mutating the snapshot.

Negative integrity validation passed:

- `1062 ER_DUP_ENTRY` on `uq_score_snapshots_entry_source_fingerprint` for an exact normalized fingerprint duplicate.
- `1452 ER_NO_REFERENCED_ROW_2` on `fk_current_scores_canonical_event` for a mismatched current-score canonical tuple.
- `1452 ER_NO_REFERENCED_ROW_2` on `fk_entries_current_category_contest` and `fk_score_snapshots_category_contest` for cross-contest category references.
- `1451 ER_ROW_IS_REFERENCED_2` on `fk_contest_categories_contest` when deleting a parent contest with dependent history.

Fixture cleanup was confirmed: `PHASE2B_TEST` source, contest, and entry counts are all zero.

Real application connectivity and advisory-lock validation also passed on the target: `dxarauca_livescore_test` on Percona Server `5.7.44-48`, `Percona Server (GPL), Release 48, Revision 497f936a373`. The exact test-database guard and UTC session configuration (`+00:00`) were verified. Two distinct pinned physical `mysql2` sessions (connection IDs `5705924` and `5705925`) proved connection-owned `GET_LOCK` behavior: the first acquired the lock, the second observed contention, the first explicitly released it, and the second then acquired and released it. Validator cleanup closed both sessions without application-data DML.

### Phase 2D MySQL-Backed Collector Ingestion

Real validation on Percona Server 5.7.44-48 using only `dxarauca_livescore_test` passed for the MySQL-backed collector ingestion path. It proved that the raw receipt commits independently before normalization; accepted snapshots persist; an initial canonical event is created; a same-source timestamp-only update advances canonical state; and an exact duplicate is rejected. The test also preserved counter decreases/resets, including score, QSO, and multiplier; retained source-authoritative aggregate totals when supplemental band sums differed; kept `current_scores` pointed at the exact canonical event/snapshot pair; appended `OUT_OF_ORDER` without mutating the snapshot; and retained an out-of-order observation without rewinding the current canonical state.

The real fixture cleanup completed with zero remaining fixture rows. The final run recorded five accepted snapshots, four canonical events, one duplicate, and one `OUT_OF_ORDER` flag.

Real validation also exposed and corrected application or validation-harness defects, not schema defects: Kysely now receives mysql2's callback-compatible pool; MySQL JSON bind values are explicitly serialized; fixture setup is transactional; the application maps `band_snapshots.snapshot_id` to the existing DDL; BIGINT `COUNT(*)` values are normalized in the harness; and confirmed-UTC `DATETIME(6)` values are compared deterministically at microsecond precision. No migration or database schema change was required.

### Local Percona 5.7 Integration

`database/docker-compose.percona57.yml` defines an ephemeral local service using `percona:5.7.44-48`. It binds only to `127.0.0.1:33067` and creates only `dxarauca_livescore_test`. Do not substitute the production database URL or name.

The migration follows dbmate's paired-section format: `-- migrate:up` precedes the creation DDL and `-- migrate:down` drops tables in foreign-key-safe reverse order. The following PowerShell sequence proves both sections through dbmate before running the schema and behavioral integration checks:

```powershell
docker compose -f database/docker-compose.percona57.yml up -d --wait
$env:DATABASE_URL = $env:PERCONA57_DATABASE_URL
corepack.cmd pnpm run db:migrate
corepack.cmd pnpm run db:migrate:down
corepack.cmd pnpm run db:migrate
corepack.cmd pnpm run db:percona57:validate
corepack.cmd pnpm run db:percona57:integration
docker compose -f database/docker-compose.percona57.yml down -v
```

The integration runner refuses any database name other than `dxarauca_livescore_test`; it also verifies `SELECT DATABASE()` after connection before running any validation. It covers session bootstrap, schema engines/collations, JSON, microsecond timestamps, identity/category integrity, snapshot deduplication and resets, append-only diagnostics, canonical pointers, non-canonical historical snapshots, restrictive deletion, advisory locks, and raw-message batch semantics.
