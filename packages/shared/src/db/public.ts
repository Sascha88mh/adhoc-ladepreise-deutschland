import type { PoolClient } from "pg";
import type { StationRecord, TariffSummary } from "../domain/types";
import { stationRecordSchema } from "../domain/types";
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

type TariffRow = {
  station_id: string;
  tariff_key: string;
  tariff_code: string;
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

async function loadStationRows(stationCode?: string, client?: PoolClient) {
  const executor = client ?? getPool();
  const result = await executor.query<StationRow>(
    `select
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
        coalesce(o.max_power_kw, s.max_power_kw)::float8 as max_power_kw,
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
     where ($1::text is null or s.station_code = $1::text)
       and coalesce(o.is_hidden, false) = false
     order by c.name asc, name asc`,
    [stationCode ?? null],
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
        t.label,
        t.currency,
        t.is_complete,
        coalesce(array_remove(array_agg(distinct pm.payment_method), null), '{}') as payment_methods,
        coalesce(array_remove(array_agg(distinct ba.brand), null), '{}') as brands
      from tariffs t
 left join tariff_payment_methods pm
        on pm.tariff_id = t.id
 left join tariff_brands_accepted ba
        on ba.tariff_id = t.id
     where t.station_id = any($1::uuid[])
     group by t.id, t.station_id, ${tariffIdentitySql}, t.tariff_code, t.label, t.currency, t.is_complete`,
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
        cp.max_power_kw::float8,
        cp.last_status_canonical,
        coalesce(
          array_agg(c.connector_type order by c.id) filter (where c.id is not null),
          '{}'
        ) as connector_types,
        coalesce(
          array_agg(c.max_power_kw::float8 order by c.id) filter (where c.id is not null),
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

export async function listStationRecordsDb(stationCode?: string, client?: PoolClient) {
  const stationRows = await loadStationRows(stationCode, client);
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
