-- migrate:up

CREATE TABLE sources (
  id BIGINT UNSIGNED NOT NULL AUTO_INCREMENT,
  code VARCHAR(64) CHARACTER SET ascii COLLATE ascii_bin NOT NULL,
  kind VARCHAR(64) CHARACTER SET ascii COLLATE ascii_bin NOT NULL,
  precedence_rank TINYINT UNSIGNED NOT NULL,
  display_name VARCHAR(255) NOT NULL,
  base_url VARCHAR(2048) NULL,
  default_config JSON NULL,
  enabled TINYINT(1) NOT NULL,
  created_at DATETIME(6) NOT NULL,
  updated_at DATETIME(6) NOT NULL,
  PRIMARY KEY (id),
  UNIQUE KEY uq_sources_code (code),
  KEY ix_sources_enabled_precedence (enabled, precedence_rank)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

CREATE TABLE contests (
  id BIGINT UNSIGNED NOT NULL AUTO_INCREMENT,
  name VARCHAR(255) NOT NULL,
  normalized_name VARCHAR(255) NOT NULL,
  slug VARCHAR(191) CHARACTER SET ascii COLLATE ascii_bin NULL,
  status VARCHAR(32) CHARACTER SET ascii COLLATE ascii_bin NOT NULL,
  start_at DATETIME(6) NULL,
  end_at DATETIME(6) NULL,
  time_zone VARCHAR(64) CHARACTER SET ascii COLLATE ascii_bin NULL,
  metadata JSON NULL,
  created_at DATETIME(6) NOT NULL,
  updated_at DATETIME(6) NOT NULL,
  PRIMARY KEY (id),
  UNIQUE KEY uq_contests_slug (slug),
  KEY ix_contests_normalized_name (normalized_name(191)),
  KEY ix_contests_status_start_at (status, start_at)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

CREATE TABLE contest_external_ids (
  id BIGINT UNSIGNED NOT NULL AUTO_INCREMENT,
  contest_id BIGINT UNSIGNED NOT NULL,
  source_id BIGINT UNSIGNED NOT NULL,
  external_id VARCHAR(180) CHARACTER SET utf8mb4 COLLATE utf8mb4_bin NOT NULL,
  external_name VARCHAR(255) NULL,
  external_calendar_code VARCHAR(64) CHARACTER SET ascii COLLATE ascii_bin NULL,
  start_day TINYINT UNSIGNED NULL,
  start_time VARCHAR(64) CHARACTER SET ascii COLLATE ascii_bin NULL,
  finish_day TINYINT UNSIGNED NULL,
  finish_time VARCHAR(64) CHARACTER SET ascii COLLATE ascii_bin NULL,
  metadata JSON NULL,
  last_observed_at DATETIME(6) NULL,
  created_at DATETIME(6) NOT NULL,
  updated_at DATETIME(6) NOT NULL,
  PRIMARY KEY (id),
  UNIQUE KEY uq_contest_external_ids_source_external (source_id, external_id),
  UNIQUE KEY uq_contest_external_ids_id_contest (id, contest_id),
  UNIQUE KEY uq_contest_external_ids_id_contest_source (id, contest_id, source_id),
  KEY ix_contest_external_ids_contest_source (contest_id, source_id),
  KEY ix_contest_external_ids_source_calendar (source_id, external_calendar_code),
  CONSTRAINT fk_contest_external_ids_contest
    FOREIGN KEY (contest_id) REFERENCES contests (id)
    ON DELETE RESTRICT ON UPDATE RESTRICT,
  CONSTRAINT fk_contest_external_ids_source
    FOREIGN KEY (source_id) REFERENCES sources (id)
    ON DELETE RESTRICT ON UPDATE RESTRICT
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

CREATE TABLE contest_categories (
  id BIGINT UNSIGNED NOT NULL AUTO_INCREMENT,
  contest_id BIGINT UNSIGNED NOT NULL,
  category_key VARCHAR(191) CHARACTER SET ascii COLLATE ascii_bin NOT NULL,
  display_name VARCHAR(255) NOT NULL,
  metadata JSON NULL,
  active TINYINT(1) NOT NULL,
  created_at DATETIME(6) NOT NULL,
  updated_at DATETIME(6) NOT NULL,
  PRIMARY KEY (id),
  UNIQUE KEY uq_contest_categories_contest_key (contest_id, category_key),
  UNIQUE KEY uq_contest_categories_id_contest (id, contest_id),
  KEY ix_contest_categories_contest_active (contest_id, active),
  CONSTRAINT fk_contest_categories_contest
    FOREIGN KEY (contest_id) REFERENCES contests (id)
    ON DELETE RESTRICT ON UPDATE RESTRICT
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

CREATE TABLE contest_category_external_ids (
  id BIGINT UNSIGNED NOT NULL AUTO_INCREMENT,
  contest_id BIGINT UNSIGNED NOT NULL,
  contest_category_id BIGINT UNSIGNED NOT NULL,
  contest_external_id_id BIGINT UNSIGNED NOT NULL,
  external_category_id VARCHAR(180) CHARACTER SET utf8mb4 COLLATE utf8mb4_bin NOT NULL,
  external_name VARCHAR(255) NULL,
  raw_metadata JSON NULL,
  last_observed_at DATETIME(6) NULL,
  created_at DATETIME(6) NOT NULL,
  updated_at DATETIME(6) NOT NULL,
  PRIMARY KEY (id),
  UNIQUE KEY uq_category_external_ids_external (contest_external_id_id, external_category_id),
  KEY ix_category_external_ids_category (contest_category_id),
  CONSTRAINT fk_category_external_ids_contest
    FOREIGN KEY (contest_id) REFERENCES contests (id)
    ON DELETE RESTRICT ON UPDATE RESTRICT,
  CONSTRAINT fk_category_external_ids_category_contest
    FOREIGN KEY (contest_category_id, contest_id)
    REFERENCES contest_categories (id, contest_id)
    ON DELETE RESTRICT ON UPDATE RESTRICT,
  CONSTRAINT fk_category_external_ids_external_contest
    FOREIGN KEY (contest_external_id_id, contest_id)
    REFERENCES contest_external_ids (id, contest_id)
    ON DELETE RESTRICT ON UPDATE RESTRICT
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

CREATE TABLE entries (
  id BIGINT UNSIGNED NOT NULL AUTO_INCREMENT,
  contest_id BIGINT UNSIGNED NOT NULL,
  normalized_callsign VARCHAR(64) CHARACTER SET ascii COLLATE ascii_bin NOT NULL,
  display_callsign VARCHAR(64) NULL,
  current_category_id BIGINT UNSIGNED NULL,
  current_category_observed_at DATETIME(6) NULL,
  metadata JSON NULL,
  created_at DATETIME(6) NOT NULL,
  updated_at DATETIME(6) NOT NULL,
  PRIMARY KEY (id),
  UNIQUE KEY uq_entries_contest_callsign (contest_id, normalized_callsign),
  UNIQUE KEY uq_entries_id_contest (id, contest_id),
  KEY ix_entries_contest_category (contest_id, current_category_id),
  CONSTRAINT fk_entries_contest
    FOREIGN KEY (contest_id) REFERENCES contests (id)
    ON DELETE RESTRICT ON UPDATE RESTRICT,
  CONSTRAINT fk_entries_current_category_contest
    FOREIGN KEY (current_category_id, contest_id)
    REFERENCES contest_categories (id, contest_id)
    ON DELETE RESTRICT ON UPDATE RESTRICT
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

CREATE TABLE collector_source_contests (
  id BIGINT UNSIGNED NOT NULL AUTO_INCREMENT,
  source_id BIGINT UNSIGNED NOT NULL,
  contest_id BIGINT UNSIGNED NOT NULL,
  contest_external_id_id BIGINT UNSIGNED NULL,
  enabled TINYINT(1) NOT NULL,
  poll_interval_seconds INT UNSIGNED NULL,
  configuration JSON NULL,
  last_success_at DATETIME(6) NULL,
  last_failure_at DATETIME(6) NULL,
  next_poll_at DATETIME(6) NULL,
  created_at DATETIME(6) NOT NULL,
  updated_at DATETIME(6) NOT NULL,
  PRIMARY KEY (id),
  UNIQUE KEY uq_collector_source_contests_source_contest (source_id, contest_id),
  UNIQUE KEY uq_collector_source_contests_external_id (contest_external_id_id),
  KEY ix_collector_source_contests_enabled_next_poll (enabled, next_poll_at),
  CONSTRAINT fk_collector_source_contests_source
    FOREIGN KEY (source_id) REFERENCES sources (id)
    ON DELETE RESTRICT ON UPDATE RESTRICT,
  CONSTRAINT fk_collector_source_contests_contest
    FOREIGN KEY (contest_id) REFERENCES contests (id)
    ON DELETE RESTRICT ON UPDATE RESTRICT,
  CONSTRAINT fk_collector_source_contests_external_identity
    FOREIGN KEY (contest_external_id_id, contest_id, source_id)
    REFERENCES contest_external_ids (id, contest_id, source_id)
    ON DELETE RESTRICT ON UPDATE RESTRICT
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

CREATE TABLE collector_runs (
  id BIGINT UNSIGNED NOT NULL AUTO_INCREMENT,
  collector_source_contest_id BIGINT UNSIGNED NULL,
  source_id BIGINT UNSIGNED NULL,
  environment VARCHAR(64) CHARACTER SET ascii COLLATE ascii_bin NOT NULL,
  advisory_lock_name VARCHAR(255) CHARACTER SET utf8mb4 COLLATE utf8mb4_bin NOT NULL,
  run_kind VARCHAR(64) CHARACTER SET ascii COLLATE ascii_bin NOT NULL,
  outcome VARCHAR(32) CHARACTER SET ascii COLLATE ascii_bin NOT NULL,
  started_at DATETIME(6) NOT NULL,
  finished_at DATETIME(6) NULL,
  request_count INT UNSIGNED NOT NULL,
  received_message_count INT UNSIGNED NOT NULL,
  error_code VARCHAR(128) CHARACTER SET ascii COLLATE ascii_bin NULL,
  error_details JSON NULL,
  metadata JSON NULL,
  created_at DATETIME(6) NOT NULL,
  PRIMARY KEY (id),
  KEY ix_collector_runs_source_started_at (source_id, started_at),
  KEY ix_collector_runs_mapping_started_at (collector_source_contest_id, started_at),
  KEY ix_collector_runs_outcome_started_at (outcome, started_at),
  CONSTRAINT fk_collector_runs_mapping
    FOREIGN KEY (collector_source_contest_id) REFERENCES collector_source_contests (id)
    ON DELETE RESTRICT ON UPDATE RESTRICT,
  CONSTRAINT fk_collector_runs_source
    FOREIGN KEY (source_id) REFERENCES sources (id)
    ON DELETE RESTRICT ON UPDATE RESTRICT
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

CREATE TABLE raw_messages (
  id BIGINT UNSIGNED NOT NULL AUTO_INCREMENT,
  source_id BIGINT UNSIGNED NOT NULL,
  contest_id BIGINT UNSIGNED NULL,
  collector_source_contest_id BIGINT UNSIGNED NULL,
  collector_run_id BIGINT UNSIGNED NULL,
  received_at DATETIME(6) NOT NULL,
  processing_status VARCHAR(32) CHARACTER SET ascii COLLATE ascii_bin NOT NULL,
  processing_attempts INT UNSIGNED NOT NULL,
  processing_started_at DATETIME(6) NULL,
  processed_at DATETIME(6) NULL,
  observation_count INT UNSIGNED NOT NULL,
  accepted_count INT UNSIGNED NOT NULL,
  duplicate_count INT UNSIGNED NOT NULL,
  rejected_count INT UNSIGNED NOT NULL,
  message_kind VARCHAR(64) CHARACTER SET ascii COLLATE ascii_bin NOT NULL,
  request_method VARCHAR(16) CHARACTER SET ascii COLLATE ascii_bin NULL,
  request_path_redacted VARCHAR(2048) NULL,
  response_status SMALLINT UNSIGNED NULL,
  response_content_type VARCHAR(255) CHARACTER SET ascii COLLATE ascii_bin NULL,
  response_headers_redacted JSON NULL,
  payload_redacted LONGBLOB NOT NULL,
  payload_sha256 BINARY(32) NOT NULL,
  redaction_metadata JSON NULL,
  parse_error JSON NULL,
  validation_error JSON NULL,
  metadata JSON NULL,
  created_at DATETIME(6) NOT NULL,
  PRIMARY KEY (id),
  UNIQUE KEY uq_raw_messages_id_source (id, source_id),
  KEY ix_raw_messages_source_received_at (source_id, received_at),
  KEY ix_raw_messages_contest_received_at (contest_id, received_at),
  KEY ix_raw_messages_status_received_at (processing_status, received_at),
  KEY ix_raw_messages_collector_run (collector_run_id),
  CONSTRAINT fk_raw_messages_source
    FOREIGN KEY (source_id) REFERENCES sources (id)
    ON DELETE RESTRICT ON UPDATE RESTRICT,
  CONSTRAINT fk_raw_messages_contest
    FOREIGN KEY (contest_id) REFERENCES contests (id)
    ON DELETE RESTRICT ON UPDATE RESTRICT,
  CONSTRAINT fk_raw_messages_mapping
    FOREIGN KEY (collector_source_contest_id) REFERENCES collector_source_contests (id)
    ON DELETE RESTRICT ON UPDATE RESTRICT,
  CONSTRAINT fk_raw_messages_run
    FOREIGN KEY (collector_run_id) REFERENCES collector_runs (id)
    ON DELETE RESTRICT ON UPDATE RESTRICT
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

CREATE TABLE score_snapshots (
  id BIGINT UNSIGNED NOT NULL AUTO_INCREMENT,
  entry_id BIGINT UNSIGNED NOT NULL,
  contest_id BIGINT UNSIGNED NOT NULL,
  source_id BIGINT UNSIGNED NOT NULL,
  raw_message_id BIGINT UNSIGNED NOT NULL,
  category_id BIGINT UNSIGNED NULL,
  category_raw JSON NULL,
  source_timestamp DATETIME(6) NULL,
  source_timestamp_raw VARCHAR(255) NULL,
  source_timestamp_quality VARCHAR(32) CHARACTER SET ascii COLLATE ascii_bin NULL,
  received_at DATETIME(6) NOT NULL,
  score BIGINT NULL,
  qso_total BIGINT NULL,
  points_total BIGINT NULL,
  mult_total BIGINT NULL,
  raw_metrics JSON NULL,
  normalized_fingerprint BINARY(32) NOT NULL,
  acceptance_status VARCHAR(32) CHARACTER SET ascii COLLATE ascii_bin NOT NULL,
  anomaly_flags JSON NULL,
  created_at DATETIME(6) NOT NULL,
  PRIMARY KEY (id),
  UNIQUE KEY uq_score_snapshots_entry_source_fingerprint (entry_id, source_id, normalized_fingerprint),
  UNIQUE KEY uq_score_snapshots_id_entry (id, entry_id),
  UNIQUE KEY uq_score_snapshots_id_entry_contest (id, entry_id, contest_id),
  KEY ix_score_snapshots_entry_effective (entry_id, source_timestamp, received_at),
  KEY ix_score_snapshots_source_received_at (source_id, received_at),
  KEY ix_score_snapshots_raw_message (raw_message_id),
  KEY ix_score_snapshots_contest_received_at (contest_id, received_at),
  CONSTRAINT fk_score_snapshots_entry_contest
    FOREIGN KEY (entry_id, contest_id) REFERENCES entries (id, contest_id)
    ON DELETE RESTRICT ON UPDATE RESTRICT,
  CONSTRAINT fk_score_snapshots_source
    FOREIGN KEY (source_id) REFERENCES sources (id)
    ON DELETE RESTRICT ON UPDATE RESTRICT,
  CONSTRAINT fk_score_snapshots_raw_message_source
    FOREIGN KEY (raw_message_id, source_id) REFERENCES raw_messages (id, source_id)
    ON DELETE RESTRICT ON UPDATE RESTRICT,
  CONSTRAINT fk_score_snapshots_category_contest
    FOREIGN KEY (category_id, contest_id) REFERENCES contest_categories (id, contest_id)
    ON DELETE RESTRICT ON UPDATE RESTRICT
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

CREATE TABLE band_snapshots (
  snapshot_id BIGINT UNSIGNED NOT NULL,
  band VARCHAR(32) CHARACTER SET ascii COLLATE ascii_bin NOT NULL,
  mode VARCHAR(32) CHARACTER SET ascii COLLATE ascii_bin NOT NULL,
  qso BIGINT NULL,
  points BIGINT NULL,
  mult1 BIGINT NULL,
  mult2 BIGINT NULL,
  PRIMARY KEY (snapshot_id, band, mode),
  KEY ix_band_snapshots_band_mode (band, mode),
  CONSTRAINT fk_band_snapshots_snapshot
    FOREIGN KEY (snapshot_id) REFERENCES score_snapshots (id)
    ON DELETE RESTRICT ON UPDATE RESTRICT
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

CREATE TABLE score_snapshot_flags (
  id BIGINT UNSIGNED NOT NULL AUTO_INCREMENT,
  snapshot_id BIGINT UNSIGNED NOT NULL,
  flag VARCHAR(64) CHARACTER SET ascii COLLATE ascii_bin NOT NULL,
  detected_at DATETIME(6) NOT NULL,
  details JSON NULL,
  diagnostic_fingerprint BINARY(32) NOT NULL,
  PRIMARY KEY (id),
  UNIQUE KEY uq_score_snapshot_flags_snapshot_diagnostic (snapshot_id, diagnostic_fingerprint),
  KEY ix_score_snapshot_flags_snapshot_detected_at (snapshot_id, detected_at),
  KEY ix_score_snapshot_flags_flag_detected_at (flag, detected_at),
  CONSTRAINT fk_score_snapshot_flags_snapshot
    FOREIGN KEY (snapshot_id) REFERENCES score_snapshots (id)
    ON DELETE RESTRICT ON UPDATE RESTRICT
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

CREATE TABLE canonical_score_events (
  id BIGINT UNSIGNED NOT NULL AUTO_INCREMENT,
  entry_id BIGINT UNSIGNED NOT NULL,
  score_snapshot_id BIGINT UNSIGNED NOT NULL,
  selected_at DATETIME(6) NOT NULL,
  effective_at DATETIME(6) NOT NULL,
  selection_basis VARCHAR(64) CHARACTER SET ascii COLLATE ascii_bin NOT NULL,
  selection_reason VARCHAR(255) NULL,
  context JSON NULL,
  PRIMARY KEY (id),
  UNIQUE KEY uq_canonical_score_events_snapshot (score_snapshot_id),
  UNIQUE KEY uq_canonical_score_events_id_entry_snapshot (id, entry_id, score_snapshot_id),
  KEY ix_canonical_score_events_entry_effective_at (entry_id, effective_at, id),
  KEY ix_canonical_score_events_entry_selected_at (entry_id, selected_at, id),
  CONSTRAINT fk_canonical_score_events_snapshot_entry
    FOREIGN KEY (score_snapshot_id, entry_id) REFERENCES score_snapshots (id, entry_id)
    ON DELETE RESTRICT ON UPDATE RESTRICT
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

CREATE TABLE current_scores (
  entry_id BIGINT UNSIGNED NOT NULL,
  canonical_event_id BIGINT UNSIGNED NOT NULL,
  canonical_snapshot_id BIGINT UNSIGNED NOT NULL,
  updated_at DATETIME(6) NOT NULL,
  PRIMARY KEY (entry_id),
  UNIQUE KEY uq_current_scores_event (canonical_event_id),
  UNIQUE KEY uq_current_scores_snapshot (canonical_snapshot_id),
  CONSTRAINT fk_current_scores_canonical_event
    FOREIGN KEY (canonical_event_id, entry_id, canonical_snapshot_id)
    REFERENCES canonical_score_events (id, entry_id, score_snapshot_id)
    ON DELETE RESTRICT ON UPDATE RESTRICT
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

-- migrate:down

DROP TABLE current_scores;
DROP TABLE canonical_score_events;
DROP TABLE score_snapshot_flags;
DROP TABLE band_snapshots;
DROP TABLE score_snapshots;
DROP TABLE raw_messages;
DROP TABLE collector_runs;
DROP TABLE collector_source_contests;
DROP TABLE entries;
DROP TABLE contest_category_external_ids;
DROP TABLE contest_categories;
DROP TABLE contest_external_ids;
DROP TABLE contests;
DROP TABLE sources;
