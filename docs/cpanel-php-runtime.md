# cPanel PHP Collector Runtime

## Scope

The existing TypeScript implementation remains the reference/core
implementation for collector semantics, database behavior, fingerprints, and
tests. The `php/` tree is an isolated PHP 8.3 cPanel runtime adapter; it is not
a replacement for TypeScript and is not served from a public web directory.

```text
php/
  bootstrap/  minimal autoloader and version gate
  src/        standard-library runtime primitives
  bin/        bounded CLI entrypoints and a guarded probe
  tests/      dependency-free PHP test runner
fixtures/
  parity/     TypeScript-generated language-neutral parity vectors
```

Production cPanel CLI has confirmed PHP 8.3.33 with `pdo_mysql`, `mysqli`,
`curl`, `json`, `openssl`, and `mbstring`. Node.js is unavailable to cPanel
Cron, so the future production collector process is a bounded PHP CLI process
invoked by Cron. It is deliberately not a PHP daemon: the future cycle shape is
startup, optional stale-run recovery, one bounded polling cycle, clean exit.
Cron invokes it again later.

Phase 2F.1 contains no contest.run discovery, score ingestion, snapshot
persistence, canonical reconciliation, schema change, deployment, or Cron
creation. The placeholder `collector-cycle.php` and `collector-discover.php`
explicitly return `NOT_IMPLEMENTED` rather than implying that collection is
available.

## Phase 2F.2 normalized-ingestion persistence

Phase 2F.2 accepts an already-redacted receipt and already-normalized score
observations; it has no HTTP, parser, discovery, polling, or Cron entrypoint.
It first inserts and commits a `RECEIVED` raw-message receipt, claims it with a
conditional `RECEIVED → PROCESSING` update, then persists the whole observation
batch in one short PDO transaction. No network operation occurs in that
transaction.

Each observation validates that a non-null category belongs to its contest,
upserts the `(contest_id, normalized_callsign)` entry (including the TypeScript
null-category clearing behavior), calculates the canonical binary SHA-256
fingerprint, checks the `(entry_id, source_id, normalized_fingerprint)` dedup
identity, and only then inserts an accepted snapshot and its source-preserved
band rows. Expected error 1062 races are duplicates only when the named
snapshot unique key is identified. Category mismatches reject before entry or
snapshot mutation. Evidence JSON remains ordinary JSON, not canonical JSON.

Receipt finalization is `PROCESSED` for accepted/duplicate-only batches,
`PARTIAL` when a rejection is mixed with an accepted or duplicate result, and
`FAILED` for rejection-only or sanitized persistence/adapter failures. The
repository never overwrites `validation_error`. PHP IDs stay decimal strings;
hashes are bound as 32-byte binary values.

`SingleSourcePolicy` also ports the pure canonical eligibility/sequence
decision, preserving microsecond timestamps. It performs no canonical writes.
`canonical_score_events`, `current_scores`, and `score_snapshot_flags` remain
explicitly deferred to Phase 2F.3.

The shared `fixtures/parity/php-ingestion-persistence-v1.json` is validated by
the authoritative TypeScript test and by PHP’s dependency-free tests. The
guarded ingestion command is:

```text
PHP_COLLECTOR_TEST_ONLY=1 /usr/local/bin/php php/bin/cpanel-ingestion-probe.php
```

It refuses any schema except `dxarauca_livescore_test` both from `DATABASE_URL`
and `SELECT DATABASE()`, uses synthetic redacted fixtures only, and makes no
HTTP calls. Its PASS path requires all assertions, strict cleanup, and a
post-cleanup zero-fixture check.

## Configuration and cPanel wrapper

`DATABASE_URL` and `COLLECTOR_ENVIRONMENT` are required environment variables.
The URL parser accepts the same `mysql:` URL shape as the TypeScript database
configuration, including percent-encoded username/password fields, but exposes
only host, port, and database for sanitized diagnostics. It never logs the URL
or credentials. No `.env` file is committed.

The eventual Cron command must call only a protected wrapper outside
`public_html`, for example:

```text
/home2/dxaraucariadx/private/livescore/run-collector.sh
```

The wrapper, which is deployment-specific and not committed with secrets,
loads a protected environment file, exports `DATABASE_URL` and
`COLLECTOR_ENVIRONMENT`, invokes `/usr/local/bin/php` with an absolute project
entrypoint, and redirects logs to a private runtime directory. The Cron command
must not contain a connection URL or credentials.

## Database contract

`PdoConnectionFactory` uses `PDO::ERRMODE_EXCEPTION`, native prepares, and
non-stringified fetches. Every connection executes the established Percona
5.7-compatible session bootstrap:

```sql
SET SESSION time_zone = '+00:00';
SET SESSION sql_mode = 'ONLY_FULL_GROUP_BY,STRICT_TRANS_TABLES,NO_ZERO_IN_DATE,NO_ZERO_DATE,ERROR_FOR_DIVISION_BY_ZERO,NO_ENGINE_SUBSTITUTION';
SET SESSION innodb_strict_mode = ON;
```

`DatabaseSafety` can require an exact schema. Integration tooling requires both
the configured URL schema and `SELECT DATABASE()` to equal
`dxarauca_livescore_test`; there is no production fallback. Application UTC
timestamps use `DateTimeImmutable` with `DateTimeZone('UTC')` and format as
`DATETIME(6)` (`YYYY-MM-DD HH:MM:SS.ffffff`).

Advisory locks retain ownership by receiving the caller's one PDO instance.
They use the committed names `als:<environment>:csc:<mapping-id>` and
`als:<environment>:source:<source-id>:discovery`, with `GET_LOCK(..., 0)` and
`RELEASE_LOCK(...)` on that same connection. This preserves the TypeScript
mapping and discovery lock contract.

## Hash and JSON parity

`Sha256::hex()` is lowercase hexadecimal; `Sha256::binary()` returns exactly 32
bytes for the `BINARY(32)` fields `raw_messages.payload_sha256`,
`score_snapshots.normalized_fingerprint`, and
`score_snapshot_flags.diagnostic_fingerprint`. Hex and binary are never
interchangeable. `OUT_OF_ORDER` uses the exact UTF-8 input
`OUT_OF_ORDER|<snapshot-id>`.

Metadata and raw metrics use ordinary UTF-8 JSON encoding. Values used in a
fingerprint use `CanonicalJson`, which mirrors TypeScript `stableJson`: object
keys are deterministic, array order remains significant, and string/number/null
remain distinct. `fixtures/parity/collector-php-parity-v1.json` is generated
from the committed TypeScript reference and is consumed by both TypeScript and
PHP tests. It covers normalized fingerprints, timestamp-only changes, resets,
band ordering, SHA-256, `OUT_OF_ORDER`, callsign normalization, `soft` string
and number behavior, `qtotal*` evidence, and aggregate/band disagreement.

PHP ingestion is not authorized until this parity suite remains green as the
TypeScript contract evolves.

## Tests and guarded cPanel probe

The dependency-free PHP tests run with an explicit PHP binary:

```text
/usr/local/bin/php php/tests/run.php
```

The prepared, unrun cPanel foundation probe is:

```text
PHP_COLLECTOR_TEST_ONLY=1 /usr/local/bin/php php/bin/cpanel-foundation-probe.php
```

It performs no HTTP, schema change, insert, update, or delete. It requires the
test-only flag and the test-database double guard, then verifies PHP/extensions,
URL parsing, PDO/session bootstrap, Percona version, SHA/JSON fixture parity,
and acquire/release on one pinned advisory-lock connection. Structured output
contains only stable event fields and sanitizes credential/auth-like keys.

## Real cPanel validation

Phase 2F.1 was validated on the actual cPanel host with PHP 8.3.33. The
previously confirmed `pdo_mysql`, `curl`, `json`, `openssl`, and `mbstring`
extensions were available. Running `/usr/local/bin/php php/tests/run.php`
completed the PHP foundation parity suite with **9 passed, 0 failed**: strict
sanitized database-URL parsing, collector-environment parity, test-schema
safety, UTC `DATETIME(6)` formatting, SHA-256/canonical-JSON parity,
normalized and diagnostic fingerprint parity, contest.run source-value
conventions, advisory-lock naming/scalars, and recursive structured-log
redaction.

The guarded foundation probe then connected only to
`dxarauca_livescore_test` on the Percona-compatible `5.7.44-48` server. It
verified a `+00:00` session timezone and advisory-lock acquire/release. The
probe performed no contest.run HTTP request, application-data or schema
mutation, and no production-database access.

### Phase 2F.2 real validation

The Phase 2F.2 dependency-free PHP suite ran on the actual cPanel PHP 8.3.33
runtime: **13 passed, 0 failed**. The initial guarded normalized-ingestion probe
then reported `PHP_INGESTION_PROBE_PASS` against only
`dxarauca_livescore_test`, using fixture `php-2f2-24f55292fd0da0e0` at
`2026-09-14 12:14:02.075446`. It made no contest.run HTTP request, accessed no
production database, and made no schema change.

The probe source double-guards both the configured `DATABASE_URL` schema and
`SELECT DATABASE()`. Its executed assertions cover an accepted receipt,
exact-duplicate receipt, a changed timestamp/reset accepted receipt, category
mismatch within a mixed `PARTIAL` receipt, rejection-only `FAILED` receipt,
32-byte normalized fingerprint storage, and zero fixture references in
`canonical_score_events` and `score_snapshot_flags`.

Closure review found limits in that initial harness, so its PASS remains useful
initial evidence only. The strengthened probe was subsequently run on actual
cPanel PHP 8.3.33 and is the authoritative Phase 2F.2 closure evidence:

- PHP suite: **13 passed, 0 failed**.
- Schema: `dxarauca_livescore_test` only.
- Fixture: `php-2f2-1e68c262ca62b3e5`.
- Timestamp: `2026-09-14 13:34:02.057187`.
- Scenarios: accepted, exact duplicate, timestamp-only distinct observation,
  reset/decrease, aggregate/band disagreement, category rejection, mixed
  `PARTIAL`, rejection-only `FAILED`, and an actual thrown post-receipt failure.
- Binary fields: `payload_sha256` and `normalized_fingerprint` were each 32
  bytes.
- Phase boundary: zero fixture `canonical_score_events`, `current_scores`, and
  `score_snapshot_flags` rows.
- Cleanup: `cleanup_remaining_fixture_rows = 0`.

The strengthened PASS is emitted only after its assertions, cleanup, and
post-cleanup verification succeed; cleanup errors cannot produce PASS. It made
no contest.run HTTP request, accessed no production database, and made no
schema change. Collector entrypoints remain disabled. No Phase 2F.3 canonical
persistence was performed; canonical database writes remain deferred to 2F.3.

## contest.run displayscore MVP slice

The PHP MVP has an explicit cURL HTTPS GET boundary for
`/api/displayscore/<testid>` and a pure adapter matching the committed
TypeScript normalizer. Auth keys are recursively removed from stored evidence,
source dates remain `UNZONED_SOURCE_TEXT` with no inferred UTC timestamp,
aggregate source totals are retained independently of band sums, `soft` accepts
string or number, and `qtotalc`, `qtotalp`, and `qtotalr` remain fingerprint
evidence. Invalid row positions are rejected without discarding valid rows.

It invokes the established receipt/persistence/canonical service; no polling or
Cron entrypoint is enabled. The prepared, unrun guarded integration command is:

```text
PHP_COLLECTOR_TEST_ONLY=1 /usr/local/bin/php php/bin/cpanel-contest-run-displayscore-probe.php
```

It requires both test-schema guards, fetches known test ID `108`, writes only
unique synthetic fixture rows in `dxarauca_livescore_test`, prints a sanitized
count summary, and cleans those rows. It has not been run; no MVP real PASS is
claimed.

## Phase 2F.3 canonical reconciliation

Phase 2F.3 reconciles each newly accepted snapshot in its own short PDO
transaction, after the observation-persistence transaction has committed and
before receipt finalization. The transaction loads the candidate, locks its
exact `entries.id` row with `FOR UPDATE`, reads canonical state only through
the `current_scores` pointer joined to its event and snapshot, applies the pure
`SingleSourcePolicy`, then commits any event/pointer/diagnostic mutation.
Neither HTTP nor receipt creation/persistence/finalization is inside this
transaction.

Eligible initial and same-source nondecreasing snapshots append a
`canonical_score_events` row with `SINGLE_SOURCE_SEQUENCE`, respectively
`INITIAL_CANONICAL` or `SAME_SOURCE_NONDECREASING_EFFECTIVE_AT`, and install or
update the exact `current_scores` pointer. The timeline is append-only. An
older same-source snapshot leaves the pointer unchanged and creates one
deduplicated `OUT_OF_ORDER` flag with binary SHA-256 over
`OUT_OF_ORDER|<snapshot-id>` and ordinary JSON current-pointer evidence.
Ineligible and cross-source candidates write none of the three canonical
tables; cross-source precedence remains out of scope.

`NormalizedIngestionService` obtains one UTC reconciliation timestamp per
accepted batch and uses it for every accepted snapshot; duplicates and
rejections are not reconciled. Reconciliation failure leaves previously
committed snapshots durable and finalizes the receipt as sanitized `FAILED`.
The shared `php-canonical-reconciliation-v1.json` fixture is derived from the
TypeScript policy. A guarded, synthetic-fixture-only Phase 2F.3 cPanel probe
is prepared at `php/bin/cpanel-canonical-probe.php`; it requires
`PHP_COLLECTOR_TEST_ONLY=1` and both test-schema guards.

### Phase 2F.3 authoritative real validation

The final guarded canonical probe ran on actual cPanel PHP **8.3.33** against
only `dxarauca_livescore_test`. The dependency-free PHP suite completed with
**14 passed, 0 failed**. The authoritative probe returned exit code **0** and
`PHP_CANONICAL_PROBE_PASS` for fixture `php-2f3-a37d3399b9a9c4c3` at
`2026-09-14 16:08:01.944908`.

It validated `INELIGIBLE_TIMESTAMP`, initial canonical selection, newer and
equal-timestamp same-source advances, reset/decrease advancement,
`OUT_OF_ORDER` plus repeated diagnostic deduplication,
`DEFERRED_CROSS_SOURCE_POLICY`, and `NormalizedIngestionService`
orchestration. It verified append-only canonical events, exact current-score
pointers, a 32-byte diagnostic fingerprint, exactly one repeated diagnostic
flag, and `cleanup_remaining_fixture_rows = 0`. No HTTP, production database
access, schema change, or deployment occurred.

An earlier probe run failed only in the harness: strict PHP associative-array
comparison accidentally required MySQL JSON object-key order. The corrected
probe checks each evidence field semantically; production reconciliation was
not changed or weakened. That failed run still entered strict cleanup and never
emitted PASS.

Forced reconciliation failure after persistence and forced rollback between
event and pointer writes remain audit-only. No artificial production test seam
was added. Structurally, reconciliation is one short PDO transaction ordered
candidate lookup → `entries ... FOR UPDATE` → current lookup → policy →
event/flag/current writes → commit; an exception rolls back that transaction.

### Linux shell line endings

All shell scripts deployed to cPanel/Linux must use LF line endings. An
initial temporary wrapper with Windows CRLF line endings failed before
execution (`set: -\r: invalid option`); converting the temporary `.sh` files
to LF resolved it. Repository attributes enforce LF for `*.sh` files so that
future deployment wrappers are protected from accidental CRLF conversion.
