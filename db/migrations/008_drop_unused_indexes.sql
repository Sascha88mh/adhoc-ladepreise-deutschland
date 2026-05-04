-- Migration 008: drop indexes that pg_stat_user_indexes reported as never
-- scanned. Each of these costs write amplification on every INSERT/UPDATE.
-- Removing them is particularly impactful on availability_snapshots, which
-- absorbs hundreds of thousands of rows per ingest cycle.
--
-- Note: indexes that cover ON DELETE CASCADE foreign keys are restored in
-- migration 009 with FK-only definitions (smaller than the dropped composites).

DROP INDEX IF EXISTS idx_availability_snapshots_charge_point_recorded;
DROP INDEX IF EXISTS idx_charge_points_status;
DROP INDEX IF EXISTS idx_sync_runs_running_started;
DROP INDEX IF EXISTS idx_sync_runs_one_running_per_feed;
DROP INDEX IF EXISTS idx_sync_runs_active_heartbeat;
DROP INDEX IF EXISTS idx_price_snapshots_tariff_recorded;
