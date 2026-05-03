-- Migration 005: live sync-run progress
--
-- Feed syncs can be long-running. These columns expose the current phase and
-- heartbeat in the Admin UI, so operators can distinguish download, parse,
-- database writes and stuck runs.

ALTER TABLE sync_runs
  ADD COLUMN IF NOT EXISTS progress_stage TEXT,
  ADD COLUMN IF NOT EXISTS progress_detail TEXT,
  ADD COLUMN IF NOT EXISTS heartbeat_at TIMESTAMPTZ,
  ADD COLUMN IF NOT EXISTS payload_size_bytes BIGINT,
  ADD COLUMN IF NOT EXISTS processed_count INTEGER,
  ADD COLUMN IF NOT EXISTS total_count INTEGER;

CREATE INDEX IF NOT EXISTS idx_sync_runs_active_heartbeat
  ON sync_runs (heartbeat_at)
  WHERE status IN ('queued', 'running');
