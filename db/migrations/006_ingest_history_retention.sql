-- Migration 006: retention indexes for ingest history cleanup
--
-- The ingest worker prunes raw Mobilithek payload summaries and historical
-- status/price snapshots in small batches. These indexes keep that cleanup
-- cheap even when Supabase storage/IO is under pressure.

CREATE INDEX IF NOT EXISTS idx_raw_feed_payloads_created_at
  ON raw_feed_payloads (created_at);

CREATE INDEX IF NOT EXISTS idx_availability_snapshots_recorded_at
  ON availability_snapshots (recorded_at);

CREATE INDEX IF NOT EXISTS idx_price_snapshots_recorded_at
  ON price_snapshots (recorded_at);
