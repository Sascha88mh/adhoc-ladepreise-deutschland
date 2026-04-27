-- Migration 003: durable feed-run claims
--
-- A feed may only have one running sync at a time. The ingestion code now
-- claims a run row before touching Mobilithek, so overlapping cron invocations
-- skip cleanly without producing "Lock belegt" failures or duplicate static
-- downloads.

UPDATE sync_runs
   SET status = 'failed',
       finished_at = COALESCE(finished_at, now()),
       message = 'Abgebrochen (alter laufender Sync vor Claim-Migration)'
 WHERE status = 'running'
   AND started_at < now() - interval '15 minutes';

WITH ranked AS (
  SELECT id,
         row_number() OVER (
           PARTITION BY feed_id
           ORDER BY started_at DESC, id DESC
         ) AS rn
    FROM sync_runs
   WHERE status = 'running'
     AND feed_id IS NOT NULL
)
UPDATE sync_runs sr
   SET status = 'failed',
       finished_at = COALESCE(sr.finished_at, now()),
       message = 'Abgebrochen (durch neueren laufenden Sync ersetzt)'
  FROM ranked r
 WHERE sr.id = r.id
   AND r.rn > 1;

CREATE UNIQUE INDEX IF NOT EXISTS idx_sync_runs_one_running_per_feed
  ON sync_runs (feed_id)
  WHERE status = 'running';

CREATE INDEX IF NOT EXISTS idx_sync_runs_running_started
  ON sync_runs (started_at)
  WHERE status = 'running';
