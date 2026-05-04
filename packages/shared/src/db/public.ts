import type { PoolClient } from "pg";
import type { CandidateFilters, StationRecord, TariffSummary } from "../domain/types";
import { stationRecordSchema, stationStatsSchema } from "../domain/types";
import { getPool } from "./pool";

type TariffSchemaCapabilities = {
  hasTariffKey: boolean;
  hasComponentTaxMeta: boolean;
};

type StationRow = {
  station_id: string;
  station_code: string;
  cpo_id: string;
  cpo_name: string;
  name: string;
  address_line: string;
  city: string;
  postal_code: string;
  country_code: string;
  lat: number;
  lng: number;
  charge_point_count: number;
  current_types: string[];
  connector_types: string[];
  payment_methods: string[];
  max_power_kw: number;
  available_count: number;
  occupied_count: number;
  out_of_service_count: number;
  unknown_count: number;
  last_price_update_at: string | null;
  last_status_update_at: string | null;
};

type StationBounds = {
  minLat: number;
  minLng: number;
  maxLat: number;
  maxLng: number;
};

type StationTile = {
  z: number;
  x: number;
  y: number;
};

type RoutePoint = {
  lat: number;
  lng: number;
};

type RouteCorridorFilter = {
  points: RoutePoint[];
  corridorKm: number;
  rowLimit?: number;
};

type PaymentFilterProperty = "pay_emv" | "pay_applepay" | "pay_googlepay" | "pay_website";

type StationStatsRow = {
  station_count: number;
  charge_point_count: number;
  available_charge_point_count: number;
  max_power_kw: number | null;
  ac_count: number;
  dc_count: number;
  hpc_count: number;
  min_price_kwh: number | null;
  max_price_kwh: number | null;
  complete_price_count: number;
  provider_list: Array<{
    cpoId: string;
    cpoName: string;
    stations: number;
    chargePoints: number;
  }> | null;
};

type TariffRow = {
  station_id: string;
  tariff_key: string;
  tariff_code: string;
  tariff_scope: "station" | "charge_point";
  charge_point_code: string | null;
  charge_point_current_type: "AC" | "DC" | null;
  charge_point_max_power_kw: number | null;
  label: string;
  currency: string;
  is_complete: boolean;
  payment_methods: string[];
  brands: string[];
};

type ComponentRow = {
  tariff_key: string;
  component_type: string;
  amount: number | null;
  starts_after_minutes: number | null;
  price_cap: number | null;
  tax_included: boolean | null;
  tax_rate: number | null;
};

function grossAmount(
  amount: number | null,
  taxIncluded: boolean | null,
  taxRate: number | null,
) {
  if (amount == null) {
    return null;
  }

  if (taxIncluded !== false || taxRate == null) {
    return amount;
  }

  return amount * (1 + taxRate / 100);
}

function makeTariffSummary(
  row: TariffRow,
  components: ComponentRow[],
): TariffSummary {
  const summary: TariffSummary = {
    id: row.tariff_key,
    label: row.label,
    currency: row.currency,
    scope: row.tariff_scope,
    chargePointCode: row.charge_point_code,
    chargePointCurrentType: row.charge_point_current_type,
    chargePointMaxPowerKw: row.charge_point_max_power_kw,
    pricePerKwh: null,
    pricePerMinute: null,
    sessionFee: null,
    preauthAmount: null,
    blockingFeePerMinute: null,
    blockingFeeStartsAfterMinutes: null,
    caps: [],
    paymentMethods: row.payment_methods,
    brandsAccepted: row.brands,
    isComplete: row.is_complete,
  };

  for (const component of components) {
    if (component.component_type === "pricePerKWh") {
      summary.pricePerKwh = grossAmount(
        component.amount,
        component.tax_included,
        component.tax_rate,
      );
    } else if (component.component_type === "pricePerMinute") {
      summary.pricePerMinute = grossAmount(
        component.amount,
        component.tax_included,
        component.tax_rate,
      );
    } else if (component.component_type === "sessionFee") {
      summary.sessionFee = grossAmount(
        component.amount,
        component.tax_included,
        component.tax_rate,
      );
    } else if (component.component_type === "preauth") {
      summary.preauthAmount = grossAmount(
        component.amount,
        component.tax_included,
        component.tax_rate,
      );
    } else if (component.component_type === "blockingFee") {
      summary.blockingFeePerMinute = grossAmount(
        component.amount,
        component.tax_included,
        component.tax_rate,
      );
      summary.blockingFeeStartsAfterMinutes = component.starts_after_minutes;
    } else if (component.component_type === "cap" && component.price_cap != null) {
      summary.caps.push({
        label: "priceCap",
        amount: component.price_cap,
        currency: row.currency,
      });
    }
  }

  return summary;
}

async function getTariffSchemaCapabilities(client?: PoolClient) {
  if (client) {
    const result = await client.query<{
      has_tariff_key: boolean;
      has_component_tax_meta: boolean;
    }>(
      `select
          exists (
            select 1
              from information_schema.columns
             where table_name = 'tariffs'
               and column_name = 'tariff_key'
          ) as has_tariff_key,
          exists (
            select 1
              from information_schema.columns
             where table_name = 'tariff_components'
               and column_name = 'tax_included'
          ) as has_component_tax_meta`,
    );

    return {
      hasTariffKey: Boolean(result.rows[0]?.has_tariff_key),
      hasComponentTaxMeta: Boolean(result.rows[0]?.has_component_tax_meta),
    };
  }

  const pool = getPool();
  const result = await pool.query<{
    has_tariff_key: boolean;
    has_component_tax_meta: boolean;
  }>(
    `select
        exists (
          select 1
            from information_schema.columns
           where table_name = 'tariffs'
             and column_name = 'tariff_key'
        ) as has_tariff_key,
        exists (
          select 1
            from information_schema.columns
           where table_name = 'tariff_components'
             and column_name = 'tax_included'
        ) as has_component_tax_meta`,
  );

  return {
    hasTariffKey: Boolean(result.rows[0]?.has_tariff_key),
    hasComponentTaxMeta: Boolean(result.rows[0]?.has_component_tax_meta),
  };
}

function normalizeBounds(bounds: StationBounds) {
  return {
    minLat: Math.min(bounds.minLat, bounds.maxLat),
    minLng: Math.min(bounds.minLng, bounds.maxLng),
    maxLat: Math.max(bounds.minLat, bounds.maxLat),
    maxLng: Math.max(bounds.minLng, bounds.maxLng),
  };
}

function paymentFilterProperty(method: string): PaymentFilterProperty | null {
  const normalized = method.toLowerCase();

  if (normalized === "eccard" || normalized === "creditcard" || normalized === "emv") {
    return "pay_emv";
  }

  if (normalized === "applepay" || normalized === "apple_pay" || normalized === "apple pay") {
    return "pay_applepay";
  }

  if (normalized === "googlepay" || normalized === "google_pay" || normalized === "google pay") {
    return "pay_googlepay";
  }

  if (normalized === "webqr" || normalized === "website" || normalized === "web_qr" || normalized === "web qr") {
    return "pay_website";
  }

  return null;
}

function stationStatsWhereClause(filters: CandidateFilters, params: unknown[]) {
  const clauses: string[] = [];
  const useHpcPrice =
    filters.currentTypes?.includes("DC") &&
    (filters.minPowerKw ?? 0) >= 100 &&
    filters.maxPowerKw === undefined;
  const hasPriceColumn = useHpcPrice ? "hpc_has_price" : "has_price";
  const minPriceColumn = useHpcPrice ? "hpc_min_price_kwh" : "min_price_kwh";
  const maxPriceColumn = useHpcPrice ? "hpc_max_price_kwh" : "max_price_kwh";

  if (filters.currentTypes?.includes("AC")) {
    clauses.push("has_ac");
  }

  if (filters.currentTypes?.includes("DC")) {
    clauses.push("has_dc");
  }

  if (filters.minPowerKw !== undefined) {
    params.push(filters.minPowerKw);
    clauses.push(`max_power_kw >= $${params.length}::float8`);
  }

  if (filters.maxPowerKw !== undefined) {
    params.push(filters.maxPowerKw);
    clauses.push(`max_power_kw <= $${params.length}::float8`);
  }

  if (filters.minChargePointCount !== undefined) {
    params.push(filters.minChargePointCount);
    clauses.push(`charge_point_count >= $${params.length}::int`);
  }

  if (filters.maxChargePointCount !== undefined) {
    params.push(filters.maxChargePointCount);
    clauses.push(`charge_point_count <= $${params.length}::int`);
  }

  if (filters.availableOnly) {
    clauses.push("available_count > 0");
  }

  if (filters.minPriceKwh !== undefined || filters.maxPriceKwh !== undefined) {
    clauses.push(hasPriceColumn);
  }

  if (filters.minPriceKwh !== undefined) {
    params.push(filters.minPriceKwh);
    clauses.push(`${maxPriceColumn} >= $${params.length}::float8`);
  }

  if (filters.maxPriceKwh !== undefined) {
    params.push(filters.maxPriceKwh);
    clauses.push(`${minPriceColumn} <= $${params.length}::float8`);
  }

  if (filters.onlyCompletePrices) {
    clauses.push("complete_price");
  }

  if (filters.allowSessionFee === false) {
    clauses.push("not has_session_fee");
  }

  if (filters.allowBlockingFee === false) {
    clauses.push("not has_blocking_fee");
  }

  if (filters.freshWithinMinutes !== undefined) {
    params.push(filters.freshWithinMinutes);
    clauses.push(`status_age_min <= $${params.length}::int`);
    clauses.push(`price_age_min <= $${params.length}::int`);
  }

  if (filters.cpoIds?.length) {
    params.push(filters.cpoIds);
    clauses.push(`cpo_id = any($${params.length}::text[])`);
  }

  const paymentProperties = new Set(
    (filters.paymentMethods ?? [])
      .map(paymentFilterProperty)
      .filter((property): property is PaymentFilterProperty => property != null),
  );

  for (const property of paymentProperties) {
    clauses.push(property);
  }

  return clauses.length ? `where ${clauses.join(" and ")}` : "";
}

async function loadStationRows(
  stationCode?: string,
  client?: PoolClient,
  bounds?: StationBounds,
  routeCorridor?: RouteCorridorFilter,
) {
  const executor = client ?? getPool();
  const normalizedBounds = bounds ? normalizeBounds(bounds) : null;
  const routeLats = routeCorridor?.points.map((point) => point.lat) ?? null;
  const routeLngs = routeCorridor?.points.map((point) => point.lng) ?? null;
  const corridorMeters = routeCorridor ? routeCorridor.corridorKm * 1000 : null;
  const rowLimit = routeCorridor?.rowLimit ?? null;
  const result = await executor.query<StationRow>(
    `with route_line as (
       select ST_SetSRID(
         ST_MakeLine(point_geom order by ord),
         4326
       ) as geom
       from (
         select
           ST_MakePoint(point.lng, point.lat) as point_geom,
           point.ord
         from unnest($6::float8[], $7::float8[]) with ordinality as point(lat, lng, ord)
       ) points
     )
     select
        s.id::text as station_id,
        s.station_code,
        s.cpo_id,
        c.name as cpo_name,
        coalesce(o.display_name, s.name) as name,
        coalesce(o.address_line, s.address_line) as address_line,
        coalesce(o.city, s.city) as city,
        coalesce(o.postal_code, s.postal_code) as postal_code,
        s.country_code,
        st_y(s.geom)::float8 as lat,
        st_x(s.geom)::float8 as lng,
        s.charge_point_count,
        s.current_types,
        s.connector_types,
        s.payment_methods,
        coalesce(o.max_power_kw, derived.max_power_kw, s.max_power_kw)::float8 as max_power_kw,
        s.available_count,
        s.occupied_count,
        s.out_of_service_count,
        s.unknown_count,
        s.last_price_update_at,
        s.last_status_update_at
      from stations s
      join cpos c
        on c.id = s.cpo_id
 left join station_overrides o
        on o.station_id = s.id
 cross join route_line route
 left join lateral (
        select nullif(max(
          case
            when cp.current_type = 'AC'
             and cp.max_power_kw >= 7
             and cp.max_power_kw <= 7.5
             and exists (
               select 1
                 from connectors c
                where c.charge_point_id = cp.id
                  and lower(c.connector_type) like '%iec62196t2%'
                  and lower(c.connector_type) not like '%combo%'
                  and lower(c.connector_type) not like '%ccs%'
             )
              then 22
            else cp.max_power_kw
          end
        ), 0)::float8 as max_power_kw
          from charge_points cp
         where cp.station_id = s.id
      ) derived on true
     where ($1::text is null or s.station_code = $1::text)
       and (
         $2::float8 is null
         or s.geom && ST_MakeEnvelope($2::float8, $3::float8, $4::float8, $5::float8, 4326)
       )
       and (
         $8::float8 is null
         or ST_DWithin(s.geom::geography, route.geom::geography, $8::float8)
       )
       and coalesce(o.is_hidden, false) = false
     order by
       case when $8::float8 is null then null else s.geom <-> route.geom end asc nulls last,
       c.name asc,
       name asc
     limit coalesce($9::int, 2147483647)`,
    [
      stationCode ?? null,
      normalizedBounds?.minLng ?? null,
      normalizedBounds?.minLat ?? null,
      normalizedBounds?.maxLng ?? null,
      normalizedBounds?.maxLat ?? null,
      routeLats ?? [],
      routeLngs ?? [],
      corridorMeters,
      rowLimit,
    ],
  );

  return result.rows;
}

async function loadTariffRows(stationIds: string[], client?: PoolClient) {
  if (!stationIds.length) {
    return {
      tariffs: [] as TariffRow[],
      components: [] as ComponentRow[],
    };
  }

  const executor = client ?? getPool();
  const capabilities = await getTariffSchemaCapabilities(client);
  const tariffIdentitySql = capabilities.hasTariffKey
    ? "t.tariff_key"
    : "t.tariff_code";
  const componentTaxIncludedSql = capabilities.hasComponentTaxMeta
    ? "c.tax_included"
    : "null::boolean";
  const componentTaxRateSql = capabilities.hasComponentTaxMeta
    ? "c.tax_rate::float8"
    : "null::float8";
  const tariffResult = await executor.query<TariffRow>(
    `select
        t.station_id::text as station_id,
        ${tariffIdentitySql} as tariff_key,
        t.tariff_code,
        t.tariff_scope,
        cp.charge_point_code,
        cp.current_type as charge_point_current_type,
        (case
          when cp.current_type = 'AC'
           and cp.max_power_kw >= 7
           and cp.max_power_kw <= 7.5
           and exists (
             select 1
               from connectors c2
              where c2.charge_point_id = cp.id
                and lower(c2.connector_type) like '%iec62196t2%'
                and lower(c2.connector_type) not like '%combo%'
                and lower(c2.connector_type) not like '%ccs%'
           )
            then 22
          else cp.max_power_kw
        end)::float8 as charge_point_max_power_kw,
        t.label,
        t.currency,
        t.is_complete,
        coalesce(array_remove(array_agg(distinct pm.payment_method), null), '{}') as payment_methods,
        coalesce(array_remove(array_agg(distinct ba.brand), null), '{}') as brands
      from tariffs t
 left join charge_points cp
        on cp.id = t.charge_point_id
 left join tariff_payment_methods pm
        on pm.tariff_id = t.id
 left join tariff_brands_accepted ba
        on ba.tariff_id = t.id
     where t.station_id = any($1::uuid[])
     group by
        t.id,
        t.station_id,
        ${tariffIdentitySql},
        t.tariff_code,
        t.tariff_scope,
        cp.id,
        cp.charge_point_code,
        cp.current_type,
        cp.max_power_kw,
        t.label,
        t.currency,
        t.is_complete`,
    [stationIds],
  );

  const keys = tariffResult.rows.map((row) => row.tariff_key);
  const componentResult = keys.length
    ? await executor.query<ComponentRow>(
        `select
            ${tariffIdentitySql} as tariff_key,
            c.component_type,
            c.amount::float8 as amount,
            c.starts_after_minutes,
            c.price_cap::float8 as price_cap,
            ${componentTaxIncludedSql} as tax_included,
            ${componentTaxRateSql} as tax_rate
          from tariff_components c
          join tariffs t
            on t.id = c.tariff_id
         where ${tariffIdentitySql} = any($1::text[])`,
        [keys],
      )
    : { rows: [] as ComponentRow[] };

  return {
    tariffs: tariffResult.rows,
    components: componentResult.rows,
  };
}

export async function loadChargePointRowsDb(stationCode: string, client?: PoolClient) {
  const executor = client ?? getPool();
  const result = await executor.query<{
    charge_point_code: string;
    current_type: string;
    max_power_kw: number | null;
    last_status_canonical: string;
    connector_types: string[];
    connector_powers: (number | null)[];
  }>(
    `select
        cp.charge_point_code,
        cp.current_type,
        (case
          when cp.current_type = 'AC'
           and cp.max_power_kw >= 7
           and cp.max_power_kw <= 7.5
           and exists (
             select 1
               from connectors c2
              where c2.charge_point_id = cp.id
                and lower(c2.connector_type) like '%iec62196t2%'
                and lower(c2.connector_type) not like '%combo%'
                and lower(c2.connector_type) not like '%ccs%'
           )
            then 22
          else cp.max_power_kw
        end)::float8,
        cp.last_status_canonical,
        coalesce(
          array_agg(c.connector_type order by c.id) filter (where c.id is not null),
          '{}'
        ) as connector_types,
        coalesce(
          array_agg(
            (case
              when cp.current_type = 'AC'
               and c.max_power_kw >= 7
               and c.max_power_kw <= 7.5
               and lower(c.connector_type) like '%iec62196t2%'
               and lower(c.connector_type) not like '%combo%'
               and lower(c.connector_type) not like '%ccs%'
                then 22
              else c.max_power_kw
            end)::float8
            order by c.id
          ) filter (where c.id is not null),
          '{}'
        ) as connector_powers
       from charge_points cp
       join stations s on s.id = cp.station_id
  left join connectors c on c.charge_point_id = cp.id
      where s.station_code = $1
      group by cp.id, cp.charge_point_code, cp.current_type, cp.max_power_kw, cp.last_status_canonical
      order by cp.charge_point_code`,
    [stationCode],
  );
  return result.rows;
}

async function mapStationRowsToRecords(stationRows: StationRow[], client?: PoolClient) {
  const { tariffs, components } = await loadTariffRows(
    stationRows.map((row) => row.station_id),
    client,
  );

  const componentsByTariff = new Map<string, ComponentRow[]>();
  for (const component of components) {
    const entry = componentsByTariff.get(component.tariff_key) ?? [];
    entry.push(component);
    componentsByTariff.set(component.tariff_key, entry);
  }

  const tariffsByStation = new Map<string, TariffSummary[]>();
  for (const tariff of tariffs) {
    const entry = tariffsByStation.get(tariff.station_id) ?? [];
    entry.push(makeTariffSummary(tariff, componentsByTariff.get(tariff.tariff_key) ?? []));
    tariffsByStation.set(tariff.station_id, entry);
  }

  return stationRows.map((row) =>
    stationRecordSchema.parse({
      stationId: row.station_code,
      cpoId: row.cpo_id,
      cpoName: row.cpo_name,
      name: row.name,
      addressLine: row.address_line,
      city: row.city,
      postalCode: row.postal_code,
      countryCode: row.country_code,
      coordinates: {
        lat: Number(row.lat),
        lng: Number(row.lng),
      },
      chargePointCount: Number(row.charge_point_count),
      currentTypes: row.current_types,
      connectorTypes: row.connector_types,
      paymentMethods: row.payment_methods,
      maxPowerKw: Number(row.max_power_kw),
      availabilitySummary: {
        available: Number(row.available_count),
        occupied: Number(row.occupied_count),
        outOfService: Number(row.out_of_service_count),
        unknown: Number(row.unknown_count),
      },
      lastPriceUpdateAt:
        row.last_price_update_at != null
          ? new Date(row.last_price_update_at).toISOString()
          : new Date(0).toISOString(),
      lastStatusUpdateAt:
        row.last_status_update_at != null
          ? new Date(row.last_status_update_at).toISOString()
          : new Date(0).toISOString(),
      tariffs: tariffsByStation.get(row.station_id) ?? [],
      notes: [],
    }),
  );
}

export async function listStationRecordsDb(stationCode?: string, client?: PoolClient) {
  return mapStationRowsToRecords(await loadStationRows(stationCode, client), client);
}

export async function listCpoSummariesDb(client?: PoolClient) {
  const executor = client ?? getPool();
  const result = await executor.query<{ id: string; name: string; stations: number }>(
    `select
        c.id,
        c.name,
        count(s.id)::int as stations
       from cpos c
       join stations s
         on s.cpo_id = c.id
  left join station_overrides o
         on o.station_id = s.id
      where coalesce(o.is_hidden, false) = false
      group by c.id, c.name
      order by count(s.id) desc, c.name asc`,
  );

  return result.rows.map((row) => ({
    id: row.id,
    name: row.name,
    stations: Number(row.stations),
  }));
}

export async function listStationRecordsInBoundsDb(
  bounds: StationBounds,
  client?: PoolClient,
) {
  return mapStationRowsToRecords(await loadStationRows(undefined, client, bounds), client);
}

export async function listStationRecordsNearRouteDb(
  bounds: StationBounds,
  routeCorridor: RouteCorridorFilter,
  client?: PoolClient,
) {
  return mapStationRowsToRecords(
    await loadStationRows(undefined, client, bounds, routeCorridor),
    client,
  );
}

export async function loadStationStatsInBoundsDb(
  bounds: StationBounds,
  filters: CandidateFilters = {},
  client?: PoolClient,
) {
  const executor = client ?? getPool();
  const normalizedBounds = normalizeBounds(bounds);
  const params: unknown[] = [
    normalizedBounds.minLng,
    normalizedBounds.minLat,
    normalizedBounds.maxLng,
    normalizedBounds.maxLat,
  ];
  const filteredWhere = stationStatsWhereClause(filters, params);
  const result = await executor.query<StationStatsRow>(
    `with station_base as (
        select
          s.id,
          s.cpo_id,
          c.name as cpo_name,
          s.charge_point_count,
          coalesce(o.max_power_kw, derived.max_power_kw, s.max_power_kw)::float8 as max_power_kw,
          s.current_types,
          s.available_count,
          s.last_price_update_at,
          s.last_status_update_at
        from stations s
        join cpos c
          on c.id = s.cpo_id
   left join station_overrides o
          on o.station_id = s.id
   left join lateral (
          select nullif(max(
            case
              when cp.current_type = 'AC'
               and cp.max_power_kw >= 7
               and cp.max_power_kw <= 7.5
               and exists (
                 select 1
                   from connectors c2
                  where c2.charge_point_id = cp.id
                    and lower(c2.connector_type) like '%iec62196t2%'
                    and lower(c2.connector_type) not like '%combo%'
                    and lower(c2.connector_type) not like '%ccs%'
               )
                then 22
              else cp.max_power_kw
            end
          ), 0)::float8 as max_power_kw
            from charge_points cp
           where cp.station_id = s.id
        ) derived on true
       where s.geom && ST_MakeEnvelope($1::float8, $2::float8, $3::float8, $4::float8, 4326)
         and coalesce(o.is_hidden, false) = false
      ),
      tariff_components_by_tariff as (
        select
          t.id as tariff_id,
          t.station_id,
          t.tariff_scope,
          cp.current_type as charge_point_current_type,
          (case
            when cp.current_type = 'AC'
             and cp.max_power_kw >= 7
             and cp.max_power_kw <= 7.5
             and exists (
               select 1
                 from connectors c2
                where c2.charge_point_id = cp.id
                  and lower(c2.connector_type) like '%iec62196t2%'
                  and lower(c2.connector_type) not like '%combo%'
                  and lower(c2.connector_type) not like '%ccs%'
             )
              then 22
            else cp.max_power_kw
          end)::float8 as charge_point_max_power_kw,
          t.is_complete,
          min(
            case
              when tc.component_type = 'pricePerKWh' and tc.amount is not null then
                case
                  when tc.tax_included = false and tc.tax_rate is not null then
                    tc.amount * (1 + tc.tax_rate / 100)
                  else tc.amount
                end
            end
          )::float8 as price_per_kwh,
          bool_or(tc.component_type = 'sessionFee' and coalesce(tc.amount, 0) > 0) as has_session_fee,
          bool_or(
            tc.component_type = 'blockingFee' and
            (coalesce(tc.amount, 0) > 0 or tc.starts_after_minutes is not null)
          ) as has_blocking_fee
        from tariffs t
   left join charge_points cp
          on cp.id = t.charge_point_id
   left join tariff_components tc
          on tc.tariff_id = t.id
       where t.station_id in (select id from station_base)
       group by t.id, t.station_id, t.tariff_scope, cp.id, cp.current_type, cp.max_power_kw, t.is_complete
      ),
      tariff_by_station as (
        select
          station_id,
          min(price_per_kwh) as min_price_kwh,
          max(price_per_kwh) as max_price_kwh,
          min(price_per_kwh) filter (
            where tariff_scope = 'station'
               or (
                 charge_point_current_type = 'DC'
                 and charge_point_max_power_kw >= 100
               )
          ) as hpc_min_price_kwh,
          max(price_per_kwh) filter (
            where tariff_scope = 'station'
               or (
                 charge_point_current_type = 'DC'
                 and charge_point_max_power_kw >= 100
               )
          ) as hpc_max_price_kwh,
          bool_or(is_complete) as complete_price,
          bool_or(coalesce(has_session_fee, false)) as has_session_fee,
          bool_or(coalesce(has_blocking_fee, false)) as has_blocking_fee
        from tariff_components_by_tariff
       group by station_id
      ),
      payment_by_station as (
        select
          t.station_id,
          bool_or(lower(pm.payment_method) in ('emv', 'eccard', 'creditcard')) as pay_emv,
          bool_or(lower(pm.payment_method) in ('applepay', 'apple_pay', 'apple pay')) as pay_applepay,
          bool_or(lower(pm.payment_method) in ('googlepay', 'google_pay', 'google pay')) as pay_googlepay,
          bool_or(lower(pm.payment_method) in ('website', 'webqr', 'web_qr', 'web qr')) as pay_website
        from tariffs t
        join tariff_payment_methods pm
          on pm.tariff_id = t.id
       where t.station_id in (select id from station_base)
       group by t.station_id
      ),
      station_features as (
        select
          s.cpo_id,
          s.cpo_name,
          s.charge_point_count::int,
          s.max_power_kw,
          s.available_count::int,
          'AC' = any(s.current_types) as has_ac,
          'DC' = any(s.current_types) as has_dc,
          'DC' = any(s.current_types) and s.max_power_kw >= 100 as is_hpc,
          case
            when s.last_status_update_at is null then 2147483647
            else greatest(0, floor(extract(epoch from (now() - s.last_status_update_at)) / 60))::int
          end as status_age_min,
          case
            when s.last_price_update_at is null then 2147483647
            else greatest(0, floor(extract(epoch from (now() - s.last_price_update_at)) / 60))::int
          end as price_age_min,
          t.min_price_kwh,
          t.max_price_kwh,
          t.hpc_min_price_kwh,
          t.hpc_max_price_kwh,
          t.min_price_kwh is not null as has_price,
          t.hpc_min_price_kwh is not null as hpc_has_price,
          coalesce(t.complete_price, false) as complete_price,
          coalesce(t.has_session_fee, false) as has_session_fee,
          coalesce(t.has_blocking_fee, false) as has_blocking_fee,
          coalesce(p.pay_emv, false) as pay_emv,
          coalesce(p.pay_applepay, false) as pay_applepay,
          coalesce(p.pay_googlepay, false) as pay_googlepay,
          coalesce(p.pay_website, false) as pay_website
        from station_base s
   left join tariff_by_station t
          on t.station_id = s.id
   left join payment_by_station p
          on p.station_id = s.id
      ),
      filtered_stations as (
        select *
          from station_features
          ${filteredWhere}
      ),
      provider_stats as (
        select
          cpo_id,
          cpo_name,
          count(*)::int as stations,
          coalesce(sum(charge_point_count), 0)::int as charge_points
        from filtered_stations
       group by cpo_id, cpo_name
      ),
      summary as (
        select
          count(*)::int as station_count,
          coalesce(sum(charge_point_count), 0)::int as charge_point_count,
          coalesce(sum(available_count), 0)::int as available_charge_point_count,
          max(max_power_kw)::float8 as max_power_kw,
          count(*) filter (where has_ac)::int as ac_count,
          count(*) filter (where has_dc)::int as dc_count,
          count(*) filter (where is_hpc)::int as hpc_count,
          min(min_price_kwh)::float8 as min_price_kwh,
          max(max_price_kwh)::float8 as max_price_kwh,
          count(*) filter (where complete_price)::int as complete_price_count
        from filtered_stations
      )
      select
        summary.*,
        coalesce(
          (
            select json_agg(
              json_build_object(
                'cpoId', cpo_id,
                'cpoName', cpo_name,
                'stations', stations,
                'chargePoints', charge_points
              )
              order by charge_points desc, stations desc, cpo_name asc
            )
            from provider_stats
          ),
          '[]'::json
        ) as provider_list
      from summary`,
    params,
  );
  const row = result.rows[0];

  return stationStatsSchema.parse({
    stationCount: Number(row?.station_count ?? 0),
    chargePointCount: Number(row?.charge_point_count ?? 0),
    availableChargePointCount: Number(row?.available_charge_point_count ?? 0),
    maxPowerKw: row?.max_power_kw == null ? null : Number(row.max_power_kw),
    currentTypeCounts: {
      ac: Number(row?.ac_count ?? 0),
      dc: Number(row?.dc_count ?? 0),
      hpc: Number(row?.hpc_count ?? 0),
    },
    priceBand: {
      min: row?.min_price_kwh == null ? null : Number(row.min_price_kwh),
      max: row?.max_price_kwh == null ? null : Number(row.max_price_kwh),
    },
    completePriceShare: Number(row?.station_count ?? 0) > 0
      ? Number(row?.complete_price_count ?? 0) / Number(row?.station_count ?? 1)
      : null,
    providerList: row?.provider_list ?? [],
  });
}

export async function loadStationMapTileDb(
  tile: StationTile,
  client?: PoolClient,
): Promise<Buffer> {
  const executor = client ?? getPool();
  const result = await executor.query<{ tile: Buffer }>(
    `with bounds as (
        select
          ST_TileEnvelope($1::int, $2::int, $3::int) as geom_3857,
          ST_Transform(ST_TileEnvelope($1::int, $2::int, $3::int), 4326) as geom_4326
      ),
      station_base as (
        select
          s.id,
          s.station_code,
          s.cpo_id,
          s.geom,
          s.charge_point_count,
          coalesce(o.max_power_kw, derived.max_power_kw, s.max_power_kw)::float8 as max_power_kw,
          s.current_types,
          s.available_count,
          s.last_price_update_at,
          s.last_status_update_at
        from stations s
   left join station_overrides o
          on o.station_id = s.id
   left join lateral (
          select nullif(max(
            case
              when cp.current_type = 'AC'
               and cp.max_power_kw >= 7
               and cp.max_power_kw <= 7.5
               and exists (
                 select 1
                   from connectors c
                  where c.charge_point_id = cp.id
                    and lower(c.connector_type) like '%iec62196t2%'
                    and lower(c.connector_type) not like '%combo%'
                    and lower(c.connector_type) not like '%ccs%'
               )
                then 22
              else cp.max_power_kw
            end
          ), 0)::float8 as max_power_kw
            from charge_points cp
           where cp.station_id = s.id
        ) derived on true
       cross join bounds b
       where s.geom && b.geom_4326
         and coalesce(o.is_hidden, false) = false
      ),
      tariff_components_by_tariff as (
        select
          t.id as tariff_id,
          t.station_id,
          t.tariff_scope,
          cp.current_type as charge_point_current_type,
          (case
            when cp.current_type = 'AC'
             and cp.max_power_kw >= 7
             and cp.max_power_kw <= 7.5
             and exists (
               select 1
                 from connectors c2
                where c2.charge_point_id = cp.id
                  and lower(c2.connector_type) like '%iec62196t2%'
                  and lower(c2.connector_type) not like '%combo%'
                  and lower(c2.connector_type) not like '%ccs%'
             )
              then 22
            else cp.max_power_kw
          end)::float8 as charge_point_max_power_kw,
          t.is_complete,
          min(
            case
              when tc.component_type = 'pricePerKWh' and tc.amount is not null then
                case
                  when tc.tax_included = false and tc.tax_rate is not null then
                    tc.amount * (1 + tc.tax_rate / 100)
                  else tc.amount
                end
            end
          )::float8 as price_per_kwh,
          bool_or(tc.component_type = 'sessionFee' and coalesce(tc.amount, 0) > 0) as has_session_fee,
          bool_or(
            tc.component_type = 'blockingFee' and
            (coalesce(tc.amount, 0) > 0 or tc.starts_after_minutes is not null)
          ) as has_blocking_fee
        from tariffs t
   left join charge_points cp
          on cp.id = t.charge_point_id
   left join tariff_components tc
          on tc.tariff_id = t.id
       where t.station_id in (select id from station_base)
       group by t.id, t.station_id, t.tariff_scope, cp.id, cp.current_type, cp.max_power_kw, t.is_complete
      ),
      tariff_by_station as (
        select
          station_id,
          min(price_per_kwh) as min_price_kwh,
          max(price_per_kwh) as max_price_kwh,
          min(price_per_kwh) filter (
            where tariff_scope = 'station'
               or (
                 charge_point_current_type = 'DC'
                 and charge_point_max_power_kw >= 100
               )
          ) as hpc_min_price_kwh,
          max(price_per_kwh) filter (
            where tariff_scope = 'station'
               or (
                 charge_point_current_type = 'DC'
                 and charge_point_max_power_kw >= 100
               )
          ) as hpc_max_price_kwh,
          bool_or(is_complete) as complete_price,
          bool_or(coalesce(has_session_fee, false)) as has_session_fee,
          bool_or(coalesce(has_blocking_fee, false)) as has_blocking_fee
        from tariff_components_by_tariff
       group by station_id
      ),
      payment_by_station as (
        select
          t.station_id,
          bool_or(lower(pm.payment_method) in ('emv', 'eccard', 'creditcard')) as pay_emv,
          bool_or(lower(pm.payment_method) in ('applepay', 'apple_pay', 'apple pay')) as pay_applepay,
          bool_or(lower(pm.payment_method) in ('googlepay', 'google_pay', 'google pay')) as pay_googlepay,
          bool_or(lower(pm.payment_method) in ('website', 'webqr', 'web_qr', 'web qr')) as pay_website
        from tariffs t
        join tariff_payment_methods pm
          on pm.tariff_id = t.id
       where t.station_id in (select id from station_base)
       group by t.station_id
      ),
      tile_features as (
        select
          ST_AsMVTGeom(
            ST_Transform(s.geom, 3857),
            b.geom_3857,
            4096,
            64,
            true
          ) as geom,
          s.station_code as id,
          s.cpo_id as cpo,
          round(s.max_power_kw)::int as power_kw,
          s.charge_point_count::int as charge_points,
          case when 'AC' = any(s.current_types) then 1 else 0 end as has_ac,
          case when 'DC' = any(s.current_types) then 1 else 0 end as has_dc,
          case when 'DC' = any(s.current_types) and s.max_power_kw >= 100 then 1 else 0 end as is_hpc,
          s.available_count::int as available,
          case
            when s.last_status_update_at is null then 2147483647
            else greatest(0, floor(extract(epoch from (now() - s.last_status_update_at)) / 60))::int
          end as status_age_min,
          case
            when s.last_price_update_at is null then 2147483647
            else greatest(0, floor(extract(epoch from (now() - s.last_price_update_at)) / 60))::int
          end as price_age_min,
          case when t.min_price_kwh is null then 0 else 1 end as has_price,
          case when t.min_price_kwh is null then null else round(t.min_price_kwh * 100)::int end as min_price_ct,
          case when t.max_price_kwh is null then null else round(t.max_price_kwh * 100)::int end as max_price_ct,
          case when t.hpc_min_price_kwh is null then 0 else 1 end as hpc_has_price,
          case when t.hpc_min_price_kwh is null then null else round(t.hpc_min_price_kwh * 100)::int end as hpc_min_price_ct,
          case when t.hpc_max_price_kwh is null then null else round(t.hpc_max_price_kwh * 100)::int end as hpc_max_price_ct,
          case when coalesce(t.complete_price, false) then 1 else 0 end as complete_price,
          case when coalesce(t.has_session_fee, false) then 1 else 0 end as has_session_fee,
          case when coalesce(t.has_blocking_fee, false) then 1 else 0 end as has_blocking_fee,
          case when coalesce(p.pay_emv, false) then 1 else 0 end as pay_emv,
          case when coalesce(p.pay_applepay, false) then 1 else 0 end as pay_applepay,
          case when coalesce(p.pay_googlepay, false) then 1 else 0 end as pay_googlepay,
          case when coalesce(p.pay_website, false) then 1 else 0 end as pay_website
        from station_base s
        cross join bounds b
   left join tariff_by_station t
          on t.station_id = s.id
   left join payment_by_station p
          on p.station_id = s.id
      )
      select coalesce(ST_AsMVT(tile_features, 'stations', 4096, 'geom'), '\\x'::bytea) as tile
        from tile_features`,
    [tile.z, tile.x, tile.y],
  );

  return result.rows[0]?.tile ?? Buffer.alloc(0);
}
