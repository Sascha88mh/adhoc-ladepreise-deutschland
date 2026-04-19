-- Migration 002: app_secrets table + feed ingestion hardening
--
-- Context: The code in packages/shared/src/mobilithek/client.ts already tries to
-- read credentials from app_secrets as a DB fallback when env vars are missing.
-- That table was never created, so every DB-fallback lookup silently failed and
-- only env-var credentials worked. This migration fixes that and adds a couple
-- of defensive constraints/indexes around feed ingestion.

CREATE TABLE IF NOT EXISTS app_secrets (
  key          TEXT PRIMARY KEY,
  value        TEXT NOT NULL,
  description  TEXT,
  updated_at   TIMESTAMPTZ NOT NULL DEFAULT now()
);

COMMENT ON TABLE app_secrets IS
  'Runtime secrets (certs, webhook shared-secrets). Keys use the convention '
  '<CREDENTIAL_REF>_<SUFFIX> where CREDENTIAL_REF matches feed_configs.credential_ref '
  'uppercased with non-alphanumerics replaced by "_", and SUFFIX is one of '
  'CLIENT_CERT, CLIENT_KEY, CERT_P12_BASE64, CERT_PASSWORD, WEBHOOK_SECRET. '
  'The reserved prefix MOBILITHEK_ acts as a global fallback across all feeds.';

COMMENT ON COLUMN app_secrets.value IS
  'Raw secret. For CERT_P12_BASE64 this is the base64-encoded PKCS#12 bundle. '
  'For CLIENT_CERT / CLIENT_KEY this is the PEM text with real newlines (not "\\n").';

-- Raw feed payloads can get large (Vaylens static ~40+ MB). Storing the full
-- payload as jsonb blows up the row and slows queries. We keep the preview +
-- size metadata; the full payload is only retained when explicitly requested.
ALTER TABLE raw_feed_payloads
  ADD COLUMN IF NOT EXISTS payload_size_bytes INTEGER,
  ADD COLUMN IF NOT EXISTS truncated BOOLEAN NOT NULL DEFAULT false;

COMMENT ON COLUMN raw_feed_payloads.payload IS
  'JSON payload from Mobilithek. For large feeds (>512 KB) this holds a '
  'structural preview with __truncated=true; payload_size_bytes is the real size.';

-- Allow sync_runs to reference a feed that is later deleted without cascading
-- the runs away — audit trail should survive feed deletion. (Skip if already
-- matches; IF the FK is the original ON DELETE CASCADE, re-create it.)
DO $$
BEGIN
  IF EXISTS (
    SELECT 1
      FROM information_schema.referential_constraints
     WHERE constraint_name = 'sync_runs_feed_id_fkey'
       AND delete_rule = 'CASCADE'
  ) THEN
    ALTER TABLE sync_runs DROP CONSTRAINT sync_runs_feed_id_fkey;
    ALTER TABLE sync_runs
      ADD CONSTRAINT sync_runs_feed_id_fkey
      FOREIGN KEY (feed_id) REFERENCES feed_configs(id) ON DELETE SET NULL;
    ALTER TABLE sync_runs ALTER COLUMN feed_id DROP NOT NULL;
  END IF;
END
$$;

-- Index for the "most recent run per feed" query used by the admin UI.
CREATE INDEX IF NOT EXISTS idx_sync_runs_status_started
  ON sync_runs (status, started_at DESC);
