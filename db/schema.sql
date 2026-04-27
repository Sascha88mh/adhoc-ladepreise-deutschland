CREATE EXTENSION IF NOT EXISTS postgis;
CREATE EXTENSION IF NOT EXISTS pgcrypto;

CREATE TABLE cpos (
  id TEXT PRIMARY KEY,
  name TEXT NOT NULL,
  country_code CHAR(2) NOT NULL DEFAULT 'DE',
  website_url TEXT,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE TABLE feed_configs (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  source TEXT NOT NULL DEFAULT 'mobilithek' CHECK (source IN ('mobilithek')),
  cpo_id TEXT REFERENCES cpos(id) ON DELETE SET NULL,
  name TEXT NOT NULL,
  type TEXT NOT NULL CHECK (type IN ('static', 'dynamic')),
  mode TEXT NOT NULL CHECK (mode IN ('push', 'pull', 'hybrid')),
  subscription_id TEXT NOT NULL,
  url_override TEXT,
  poll_interval_minutes INTEGER,
  reconciliation_interval_minutes INTEGER,
  is_active BOOLEAN NOT NULL DEFAULT true,
  ingest_catalog BOOLEAN NOT NULL DEFAULT true,
  ingest_prices BOOLEAN NOT NULL DEFAULT true,
  ingest_status BOOLEAN NOT NULL DEFAULT false,
  credential_ref TEXT,
  webhook_secret_ref TEXT,
  notes TEXT NOT NULL DEFAULT '',
  last_success_at TIMESTAMPTZ,
  last_snapshot_at TIMESTAMPTZ,
  last_delta_count INTEGER NOT NULL DEFAULT 0,
  error_rate NUMERIC(6, 4) NOT NULL DEFAULT 0,
  cursor_state JSONB,
  last_error_message TEXT,
  consecutive_failures INTEGER NOT NULL DEFAULT 0,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE TABLE sync_runs (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  feed_id UUID NOT NULL REFERENCES feed_configs(id) ON DELETE CASCADE,
  kind TEXT NOT NULL CHECK (kind IN ('test', 'manual', 'webhook', 'reconciliation')),
  status TEXT NOT NULL CHECK (status IN ('queued', 'running', 'success', 'failed')),
  started_at TIMESTAMPTZ NOT NULL,
  finished_at TIMESTAMPTZ,
  message TEXT NOT NULL DEFAULT '',
  delta_count INTEGER NOT NULL DEFAULT 0
);

CREATE INDEX idx_sync_runs_feed_started ON sync_runs(feed_id, started_at DESC);
CREATE UNIQUE INDEX idx_sync_runs_one_running_per_feed
  ON sync_runs(feed_id)
  WHERE status = 'running';
CREATE INDEX idx_sync_runs_running_started
  ON sync_runs(started_at)
  WHERE status = 'running';

CREATE TABLE webhook_deliveries (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  feed_id UUID NOT NULL REFERENCES feed_configs(id) ON DELETE CASCADE,
  received_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  status TEXT NOT NULL CHECK (status IN ('accepted', 'ignored', 'failed')),
  payload_size INTEGER NOT NULL DEFAULT 0
);

CREATE TABLE raw_feed_payloads (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  run_id UUID REFERENCES sync_runs(id) ON DELETE SET NULL,
  feed_id UUID NOT NULL REFERENCES feed_configs(id) ON DELETE CASCADE,
  payload_kind TEXT NOT NULL CHECK (payload_kind IN ('snapshot', 'delta', 'webhook')),
  content_type TEXT NOT NULL DEFAULT 'application/json',
  payload JSONB NOT NULL,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE TABLE stations (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  station_code TEXT NOT NULL UNIQUE,
  cpo_id TEXT NOT NULL REFERENCES cpos(id) ON DELETE CASCADE,
  name TEXT NOT NULL,
  address_line TEXT NOT NULL,
  city TEXT NOT NULL,
  postal_code TEXT NOT NULL,
  country_code CHAR(2) NOT NULL DEFAULT 'DE',
  geom GEOMETRY(Point, 4326) NOT NULL,
  charge_point_count INTEGER NOT NULL DEFAULT 1,
  max_power_kw NUMERIC(7, 2) NOT NULL DEFAULT 0,
  current_types TEXT[] NOT NULL DEFAULT '{}',
  connector_types TEXT[] NOT NULL DEFAULT '{}',
  payment_methods TEXT[] NOT NULL DEFAULT '{}',
  available_count INTEGER NOT NULL DEFAULT 0,
  occupied_count INTEGER NOT NULL DEFAULT 0,
  out_of_service_count INTEGER NOT NULL DEFAULT 0,
  unknown_count INTEGER NOT NULL DEFAULT 0,
  last_price_update_at TIMESTAMPTZ,
  last_status_update_at TIMESTAMPTZ,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE INDEX idx_stations_geom ON stations USING GIST (geom);
CREATE INDEX idx_stations_cpo ON stations(cpo_id);

CREATE TABLE station_overrides (
  station_id UUID PRIMARY KEY REFERENCES stations(id) ON DELETE CASCADE,
  display_name TEXT,
  address_line TEXT,
  city TEXT,
  postal_code TEXT,
  max_power_kw NUMERIC(7, 2),
  is_hidden BOOLEAN NOT NULL DEFAULT false,
  admin_note TEXT,
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE TABLE charge_points (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  station_id UUID NOT NULL REFERENCES stations(id) ON DELETE CASCADE,
  charge_point_code TEXT NOT NULL UNIQUE,
  current_type TEXT NOT NULL CHECK (current_type IN ('AC', 'DC')),
  max_power_kw NUMERIC(7, 2) NOT NULL DEFAULT 0,
  last_status_raw TEXT NOT NULL DEFAULT 'UNKNOWN',
  last_status_canonical TEXT NOT NULL DEFAULT 'UNKNOWN' CHECK (
    last_status_canonical IN (
      'AVAILABLE',
      'CHARGING',
      'RESERVED',
      'BLOCKED',
      'OUT_OF_SERVICE',
      'MAINTENANCE',
      'UNKNOWN'
    )
  ),
  last_status_update_at TIMESTAMPTZ,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE INDEX idx_charge_points_station ON charge_points(station_id);
CREATE INDEX idx_charge_points_status ON charge_points(last_status_canonical);

CREATE TABLE connectors (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  charge_point_id UUID NOT NULL REFERENCES charge_points(id) ON DELETE CASCADE,
  connector_type TEXT NOT NULL,
  max_power_kw NUMERIC(7, 2),
  created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE TABLE tariffs (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  station_id UUID NOT NULL REFERENCES stations(id) ON DELETE CASCADE,
  charge_point_id UUID REFERENCES charge_points(id) ON DELETE CASCADE,
  tariff_key TEXT NOT NULL UNIQUE,
  tariff_code TEXT NOT NULL,
  tariff_scope TEXT NOT NULL CHECK (tariff_scope IN ('station', 'charge_point')),
  label TEXT NOT NULL,
  currency CHAR(3) NOT NULL DEFAULT 'EUR',
  is_complete BOOLEAN NOT NULL DEFAULT false,
  valid_from TIMESTAMPTZ,
  valid_until TIMESTAMPTZ,
  provider_id TEXT,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE INDEX idx_tariffs_station ON tariffs(station_id);
CREATE INDEX idx_tariffs_charge_point ON tariffs(charge_point_id);
CREATE INDEX idx_tariffs_station_code ON tariffs(station_id, tariff_code);

CREATE TABLE tariff_components (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  tariff_id UUID NOT NULL REFERENCES tariffs(id) ON DELETE CASCADE,
  component_type TEXT NOT NULL CHECK (
    component_type IN (
      'pricePerKWh',
      'pricePerMinute',
      'sessionFee',
      'preauth',
      'blockingFee',
      'cap'
    )
  ),
  amount NUMERIC(10, 4),
  unit TEXT,
  starts_after_minutes INTEGER,
  price_cap NUMERIC(10, 2),
  tax_included BOOLEAN,
  tax_rate NUMERIC(6, 3),
  overall_period JSONB,
  time_based_applicability JSONB,
  energy_based_applicability JSONB,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE INDEX idx_tariff_components_tariff ON tariff_components(tariff_id);

CREATE TABLE tariff_payment_methods (
  tariff_id UUID NOT NULL REFERENCES tariffs(id) ON DELETE CASCADE,
  payment_method TEXT NOT NULL,
  PRIMARY KEY (tariff_id, payment_method)
);

CREATE TABLE tariff_brands_accepted (
  tariff_id UUID NOT NULL REFERENCES tariffs(id) ON DELETE CASCADE,
  brand TEXT NOT NULL,
  PRIMARY KEY (tariff_id, brand)
);

CREATE TABLE availability_snapshots (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  charge_point_id UUID NOT NULL REFERENCES charge_points(id) ON DELETE CASCADE,
  recorded_at TIMESTAMPTZ NOT NULL,
  status_raw TEXT NOT NULL,
  status_canonical TEXT NOT NULL
);

CREATE INDEX idx_availability_snapshots_charge_point_recorded
  ON availability_snapshots(charge_point_id, recorded_at DESC);

CREATE TABLE price_snapshots (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  tariff_id UUID NOT NULL REFERENCES tariffs(id) ON DELETE CASCADE,
  recorded_at TIMESTAMPTZ NOT NULL,
  summary JSONB NOT NULL
);

CREATE INDEX idx_price_snapshots_tariff_recorded
  ON price_snapshots(tariff_id, recorded_at DESC);

CREATE VIEW station_search_view AS
SELECT
  s.id,
  s.station_code,
  s.cpo_id,
  c.name AS cpo_name,
  COALESCE(o.display_name, s.name) AS name,
  COALESCE(o.address_line, s.address_line) AS address_line,
  COALESCE(o.city, s.city) AS city,
  COALESCE(o.postal_code, s.postal_code) AS postal_code,
  ST_X(s.geom) AS lng,
  ST_Y(s.geom) AS lat,
  s.charge_point_count,
  COALESCE(o.max_power_kw, s.max_power_kw) AS max_power_kw,
  s.current_types,
  s.connector_types,
  s.payment_methods,
  s.available_count,
  s.occupied_count,
  s.out_of_service_count,
  s.unknown_count,
  s.last_price_update_at,
  s.last_status_update_at
FROM stations s
JOIN cpos c ON c.id = s.cpo_id
LEFT JOIN station_overrides o ON o.station_id = s.id
WHERE COALESCE(o.is_hidden, false) = false;

CREATE VIEW route_candidate_view AS
SELECT
  search.*,
  (
    SELECT jsonb_build_object(
      'pricePerKwh', MIN(CASE WHEN component.component_type = 'pricePerKWh' THEN component.amount END),
      'pricePerMinute', MIN(CASE WHEN component.component_type = 'pricePerMinute' THEN component.amount END),
      'sessionFee', MIN(CASE WHEN component.component_type = 'sessionFee' THEN component.amount END),
      'blockingFeePerMinute', MIN(CASE WHEN component.component_type = 'blockingFee' THEN component.amount END),
      'blockingFeeStartsAfterMinutes', MIN(component.starts_after_minutes)
    )
    FROM tariffs t
    JOIN tariff_components component ON component.tariff_id = t.id
    WHERE t.station_id = search.id
  ) AS tariff_summary
FROM station_search_view search;
