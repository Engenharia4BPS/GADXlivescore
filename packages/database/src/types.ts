import type { Generated } from "kysely";

export type DatabaseId = string;
export type DatabaseDateTime = string;
export type JsonPrimitive = boolean | null | number | string;
export type JsonValue = JsonPrimitive | JsonObject | JsonValue[];
export interface JsonObject {
  [key: string]: JsonValue;
}

export interface SourcesTable {
  id: Generated<DatabaseId>;
  code: string;
  kind: string;
  precedence_rank: number;
  display_name: string;
  base_url: string | null;
  default_config: JsonValue | null;
  enabled: number;
  created_at: DatabaseDateTime;
  updated_at: DatabaseDateTime;
}

export interface ContestsTable {
  id: Generated<DatabaseId>;
  name: string;
  normalized_name: string;
  slug: string | null;
  status: string;
  start_at: DatabaseDateTime | null;
  end_at: DatabaseDateTime | null;
  time_zone: string | null;
  metadata: JsonValue | null;
  created_at: DatabaseDateTime;
  updated_at: DatabaseDateTime;
}

export interface ContestExternalIdsTable {
  id: Generated<DatabaseId>;
  contest_id: DatabaseId;
  source_id: DatabaseId;
  external_id: string;
  external_name: string | null;
  external_calendar_code: string | null;
  start_day: number | null;
  start_time: string | null;
  finish_day: number | null;
  finish_time: string | null;
  metadata: JsonValue | null;
  last_observed_at: DatabaseDateTime | null;
  created_at: DatabaseDateTime;
  updated_at: DatabaseDateTime;
}

export interface ContestCategoriesTable {
  id: Generated<DatabaseId>;
  contest_id: DatabaseId;
  category_key: string;
  display_name: string;
  metadata: JsonValue | null;
  active: number;
  created_at: DatabaseDateTime;
  updated_at: DatabaseDateTime;
}

export interface ContestCategoryExternalIdsTable {
  id: Generated<DatabaseId>;
  contest_id: DatabaseId;
  contest_category_id: DatabaseId;
  contest_external_id_id: DatabaseId;
  external_category_id: string;
  external_name: string | null;
  raw_metadata: JsonValue | null;
  last_observed_at: DatabaseDateTime | null;
  created_at: DatabaseDateTime;
  updated_at: DatabaseDateTime;
}

export interface EntriesTable {
  id: Generated<DatabaseId>;
  contest_id: DatabaseId;
  normalized_callsign: string;
  display_callsign: string | null;
  current_category_id: DatabaseId | null;
  current_category_observed_at: DatabaseDateTime | null;
  metadata: JsonValue | null;
  created_at: DatabaseDateTime;
  updated_at: DatabaseDateTime;
}

export interface RawMessagesTable {
  id: Generated<DatabaseId>;
  source_id: DatabaseId;
  contest_id: DatabaseId | null;
  collector_source_contest_id: DatabaseId | null;
  collector_run_id: DatabaseId | null;
  received_at: DatabaseDateTime;
  processing_status: string;
  processing_attempts: number;
  processing_started_at: DatabaseDateTime | null;
  processed_at: DatabaseDateTime | null;
  observation_count: number;
  accepted_count: number;
  duplicate_count: number;
  rejected_count: number;
  message_kind: string;
  request_method: string | null;
  request_path_redacted: string | null;
  response_status: number | null;
  response_content_type: string | null;
  response_headers_redacted: JsonValue | null;
  payload_redacted: Uint8Array;
  payload_sha256: Uint8Array;
  redaction_metadata: JsonValue | null;
  parse_error: JsonValue | null;
  validation_error: JsonValue | null;
  metadata: JsonValue | null;
  created_at: DatabaseDateTime;
}

export interface ScoreSnapshotsTable {
  id: Generated<DatabaseId>;
  entry_id: DatabaseId;
  contest_id: DatabaseId;
  source_id: DatabaseId;
  raw_message_id: DatabaseId;
  category_id: DatabaseId | null;
  category_raw: JsonValue | null;
  source_timestamp: DatabaseDateTime | null;
  source_timestamp_raw: string | null;
  source_timestamp_quality: string | null;
  received_at: DatabaseDateTime;
  score: string | null;
  qso_total: string | null;
  points_total: string | null;
  mult_total: string | null;
  raw_metrics: JsonValue | null;
  normalized_fingerprint: Uint8Array;
  acceptance_status: string;
  anomaly_flags: JsonValue | null;
  created_at: DatabaseDateTime;
}

export interface BandSnapshotsTable {
  score_snapshot_id: DatabaseId;
  band: string;
  mode: string;
  qso: string | null;
  points: string | null;
  mult1: string | null;
  mult2: string | null;
}

export interface ScoreSnapshotFlagsTable {
  id: Generated<DatabaseId>;
  snapshot_id: DatabaseId;
  flag: string;
  detected_at: DatabaseDateTime;
  details: JsonValue | null;
  diagnostic_fingerprint: Uint8Array;
}

export interface CanonicalScoreEventsTable {
  id: Generated<DatabaseId>;
  entry_id: DatabaseId;
  snapshot_id: DatabaseId;
  selected_at: DatabaseDateTime;
  effective_at: DatabaseDateTime;
  selection_basis: string;
  selection_reason: string | null;
  context: JsonValue | null;
}

export interface CurrentScoresTable {
  entry_id: DatabaseId;
  canonical_event_id: DatabaseId;
  canonical_snapshot_id: DatabaseId;
  updated_at: DatabaseDateTime;
}

export interface CollectorSourceContestsTable {
  id: Generated<DatabaseId>;
  source_id: DatabaseId;
  contest_id: DatabaseId;
  contest_external_id_id: DatabaseId | null;
  enabled: number;
  poll_interval_seconds: number | null;
  last_success_at: DatabaseDateTime | null;
  last_failure_at: DatabaseDateTime | null;
  next_poll_at: DatabaseDateTime | null;
  configuration: JsonValue | null;
  created_at: DatabaseDateTime;
  updated_at: DatabaseDateTime;
}

export interface CollectorRunsTable {
  id: Generated<DatabaseId>;
  collector_source_contest_id: DatabaseId | null;
  source_id: DatabaseId | null;
  environment: string;
  advisory_lock_name: string;
  run_kind: string;
  started_at: DatabaseDateTime;
  finished_at: DatabaseDateTime | null;
  outcome: string;
  request_count: number;
  received_message_count: number;
  error_code: string | null;
  error_details: JsonValue | null;
  metadata: JsonValue | null;
  created_at: DatabaseDateTime;
}

export interface Database {
  sources: SourcesTable;
  contests: ContestsTable;
  contest_external_ids: ContestExternalIdsTable;
  contest_categories: ContestCategoriesTable;
  contest_category_external_ids: ContestCategoryExternalIdsTable;
  entries: EntriesTable;
  raw_messages: RawMessagesTable;
  score_snapshots: ScoreSnapshotsTable;
  band_snapshots: BandSnapshotsTable;
  score_snapshot_flags: ScoreSnapshotFlagsTable;
  canonical_score_events: CanonicalScoreEventsTable;
  current_scores: CurrentScoresTable;
  collector_source_contests: CollectorSourceContestsTable;
  collector_runs: CollectorRunsTable;
}
