ALTER TABLE tariffs
  ADD COLUMN IF NOT EXISTS tariff_key TEXT,
  ADD COLUMN IF NOT EXISTS tariff_scope TEXT;

UPDATE tariffs t
   SET tariff_scope = CASE
         WHEN t.charge_point_id IS NOT NULL THEN 'charge_point'
         ELSE 'station'
       END,
       tariff_key = CASE
         WHEN t.charge_point_id IS NOT NULL THEN
           'charge_point|' || COALESCE(
             (
               SELECT cp.charge_point_code
                 FROM charge_points cp
                WHERE cp.id = t.charge_point_id
             ),
             'unknown'
           ) || '|' || t.tariff_code
         ELSE
           'station|' || s.station_code || '|' || t.tariff_code
       END
  FROM stations s
 WHERE s.id = t.station_id
   AND (t.tariff_key IS NULL OR t.tariff_scope IS NULL);

ALTER TABLE tariffs
  ALTER COLUMN tariff_key SET NOT NULL,
  ALTER COLUMN tariff_scope SET NOT NULL;

ALTER TABLE tariffs
  ADD CONSTRAINT tariffs_tariff_scope_check
    CHECK (tariff_scope IN ('station', 'charge_point'));

ALTER TABLE tariffs
  DROP CONSTRAINT IF EXISTS tariffs_tariff_code_key;

CREATE UNIQUE INDEX IF NOT EXISTS idx_tariffs_tariff_key
  ON tariffs(tariff_key);

CREATE INDEX IF NOT EXISTS idx_tariffs_station_code
  ON tariffs(station_id, tariff_code);

ALTER TABLE tariff_components
  ADD COLUMN IF NOT EXISTS tax_included BOOLEAN,
  ADD COLUMN IF NOT EXISTS tax_rate NUMERIC(6, 3),
  ADD COLUMN IF NOT EXISTS overall_period JSONB,
  ADD COLUMN IF NOT EXISTS energy_based_applicability JSONB;
