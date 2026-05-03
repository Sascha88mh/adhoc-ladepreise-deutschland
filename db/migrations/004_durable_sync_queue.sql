-- Migration 004: durable queued feed syncs
--
-- Manual admin syncs are persisted as queued sync_runs. The scheduled ingest
-- cycle promotes queued rows to running work, which avoids short-lived
-- serverless background tasks and keeps one active run per feed.

UPDATE sync_runs
   SET status = 'failed',
       finished_at = COALESCE(finished_at, now()),
       message = 'Abgebrochen (alter aktiver Sync vor Queue-Migration)'
 WHERE status IN ('queued', 'running')
   AND started_at < now() - interval '15 minutes';

WITH ranked AS (
  SELECT id,
         row_number() OVER (
           PARTITION BY feed_id
           ORDER BY
             CASE status WHEN 'running' THEN 0 ELSE 1 END,
             started_at DESC,
             id DESC
         ) AS rn
    FROM sync_runs
   WHERE status IN ('queued', 'running')
     AND feed_id IS NOT NULL
)
UPDATE sync_runs sr
   SET status = 'failed',
       finished_at = COALESCE(sr.finished_at, now()),
       message = 'Abgebrochen (durch neueren aktiven Sync ersetzt)'
  FROM ranked r
 WHERE sr.id = r.id
   AND r.rn > 1;

CREATE UNIQUE INDEX IF NOT EXISTS idx_sync_runs_one_active_per_feed
  ON sync_runs (feed_id)
  WHERE status IN ('queued', 'running');
