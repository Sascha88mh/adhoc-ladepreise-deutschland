-- Migration 009: restore minimal FK referencing-side indexes so ON DELETE
-- CASCADE stays cheap. Migration 008 dropped composite covers because their
-- secondary columns were never queried; the CASCADE paths still need the
-- leading FK column though.

-- charge_points cascades to tariffs and availability_snapshots.
CREATE INDEX IF NOT EXISTS idx_tariffs_charge_point
  ON tariffs (charge_point_id);

CREATE INDEX IF NOT EXISTS idx_availability_snapshots_charge_point
  ON availability_snapshots (charge_point_id);

-- stations cascades to tariffs (charge_points already has idx_charge_points_station).
CREATE INDEX IF NOT EXISTS idx_tariffs_station
  ON tariffs (station_id);

-- tariffs cascades to price_snapshots — never had an FK index at all.
CREATE INDEX IF NOT EXISTS idx_price_snapshots_tariff
  ON price_snapshots (tariff_id);
