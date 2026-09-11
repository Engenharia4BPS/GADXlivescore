# contest.run Read-only Observations

This directory is reserved for reviewed, deliberate observations of the public
`contest.run` read API. It is not a replacement for the missing design documents
referenced by the repository README.

The runnable POC writes its runtime output to the gitignored directory:

```text
runtime/contest-run-poc/<run-id>/
```

Each run produces:

```text
report.json
report.md
discovery-nearest.json
discovery-month-<month>.json
categories-<testid>.json
displayscore-<testid>.json
```

JSON artifacts are recursively sanitized for credential-like keys before being
written. The POC does not retain raw HTTP bodies; `report.json` records the raw
payload SHA-256 hash, response metadata, sanitized headers, schema observations,
and timestamp-format observations.

Only reviewed artifacts copied from a runtime directory should be committed here.
An observation is evidence, not a frozen API contract. In particular, a timestamp
without an explicit offset must remain timezone-unconfirmed until validated.

The POC accepts only documented routes, uses `GET`, follows no redirects, uses an
honest User-Agent, selects test IDs only from discovery responses, and applies a
strict request limit.
