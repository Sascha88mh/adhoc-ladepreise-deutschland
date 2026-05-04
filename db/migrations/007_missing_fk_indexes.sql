-- Migration 007: cover unindexed foreign keys flagged by the Supabase advisor.
--
-- Without these, FK lookups and ON DELETE CASCADE runs scan the full child
-- table. The stations DELETE during ingest reconciliation hit a 10+ second
-- timeout because connectors.charge_point_id had no covering index.

CREATE INDEX IF NOT EXISTS idx_connectors_charge_point
  ON connectors (charge_point_id);

CREATE INDEX IF NOT EXISTS idx_feed_configs_cpo
  ON feed_configs (cpo_id);

CREATE INDEX IF NOT EXISTS idx_raw_feed_payloads_feed
  ON raw_feed_payloads (feed_id);

CREATE INDEX IF NOT EXISTS idx_raw_feed_payloads_run
  ON raw_feed_payloads (run_id);

CREATE INDEX IF NOT EXISTS idx_webhook_deliveries_feed
  ON webhook_deliveries (feed_id);
