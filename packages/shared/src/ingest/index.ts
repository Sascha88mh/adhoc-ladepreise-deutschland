import type { PoolClient } from "pg";
import type { FeedConfig, SyncRun, TariffSummary } from "../domain/types";
import {
  parseDynamicMobilithekPayload,
  parseStaticMobilithekPayload,
  sanitizeMobilithekJsonPayload,
} from "../mobilithek/parser";
import type { ParsedStaticFeed, ParsedTariff } from "../mobilithek/types";
import {
  fetchStaticMobilithekPayload,
  pullDynamicMobilithekPayload,
  resolveSecretRef,
} from "../mobilithek/client";
import {
  cleanupStuckSyncRunsDb,
  getFeedConfigDb,
  listFeedConfigsDb,
  updateFeedConfigDb,
} from "../db/admin";
import { getPool } from "../db/pool";

type FeedAction = "test" | "manual" | "reconciliation" | "webhook";

function hashLockKey(input: string) {
  let hash = 0;
  for (let index = 0; index < input.length; index += 1) {
    hash = (hash << 5) - hash + input.charCodeAt(index);
    hash |= 0;
  }
  return hash;
}

function payloadKindFor(feed: FeedConfig, action: FeedAction) {
  if (action === "webhook") {
    return "webhook";
  }

  return feed.type === "static" ? "snapshot" : "delta";
}

function intervalMinutesFor(feed: FeedConfig) {
  if (feed.type === "static") {
    return feed.pollIntervalMinutes ?? 60 * 24;
  }

  if (feed.mode === "pull") {
    return feed.pollIntervalMinutes ?? 2;
  }

  return feed.reconciliationIntervalMinutes;
}

function shouldRunFeed(feed: FeedConfig) {
  if (!feed.isActive) {
    return false;
  }

  if (feed.type === "static" && !feed.ingestCatalog && !feed.ingestPrices) {
    return false;
  }

  if (feed.type === "dynamic" && !feed.ingestPrices && !feed.ingestStatus) {
    return false;
  }

  const interval = intervalMinutesFor(feed);
  if (interval == null) {
    return false;
  }

  if (!feed.lastSuccessAt) {
    return true;
  }

  return Date.now() - new Date(feed.lastSuccessAt).getTime() >= interval * 60_000;
}

function summarizeTariff(tariff: TariffSummary) {
  return JSON.stringify({
    pricePerKwh: tariff.pricePerKwh,
    pricePerMinute: tariff.pricePerMinute,
    sessionFee: tariff.sessionFee,
    preauthAmount: tariff.preauthAmount,
    blockingFeePerMinute: tariff.blockingFeePerMinute,
    blockingFeeStartsAfterMinutes: tariff.blockingFeeStartsAfterMinutes,
    caps: tariff.caps,
    paymentMethods: tariff.paymentMethods,
    brandsAccepted: tariff.brandsAccepted,
  });
}

function tariffFingerprint(tariff: ParsedTariff) {
  return JSON.stringify({
    id: tariff.id,
    externalCode: tariff.externalCode,
    label: tariff.label,
    currency: tariff.currency,
    isComplete: tariff.isComplete,
    paymentMethods: [...tariff.paymentMethods].sort(),
    brandsAccepted: [...tariff.brandsAccepted].sort(),
    caps: tariff.caps
      .map((cap) => `${cap.label}|${cap.amount}|${cap.currency}`)
      .sort(),
    components: tariff.components.map((component) => ({
      componentType: component.componentType,
      amount: component.amount,
      startsAfterMinutes: component.startsAfterMinutes,
      priceCap: component.priceCap,
      timeBasedApplicability: component.timeBasedApplicability,
      overallPeriod: component.overallPeriod,
      energyBasedApplicability: component.energyBasedApplicability,
      taxIncluded: component.taxIncluded,
      taxRate: component.taxRate,
    })),
  });
}

type TariffShapeRow = {
  stationId: string;
  cpId: string | null;
  code: string;
  externalCode: string;
  scope: ParsedTariff["scope"];
  label: string;
  currency: string;
  isComplete: boolean;
  tariff: ParsedTariff;
};

function mergeTariffShapes(
  existing: TariffShapeRow,
  incoming: TariffShapeRow,
): TariffShapeRow {
  const mergedPaymentMethods = Array.from(
    new Set([...existing.tariff.paymentMethods, ...incoming.tariff.paymentMethods]),
  );
  const mergedBrandsAccepted = Array.from(
    new Set([...existing.tariff.brandsAccepted, ...incoming.tariff.brandsAccepted]),
  );
  const mergedCaps = Array.from(
    new Map(
      [...existing.tariff.caps, ...incoming.tariff.caps].map((cap) => [
        `${cap.label}|${cap.amount}|${cap.currency}`,
        cap,
      ]),
    ).values(),
  );

  return {
    stationId: existing.stationId,
    cpId:
      existing.cpId === incoming.cpId
        ? existing.cpId
        : null,
    code: existing.code,
    externalCode: existing.externalCode,
    scope: existing.scope,
    label: existing.label || incoming.label,
    currency: existing.currency || incoming.currency,
    isComplete: existing.isComplete || incoming.isComplete,
    tariff: {
      ...existing.tariff,
      label: existing.tariff.label || incoming.tariff.label,
      currency: existing.tariff.currency || incoming.tariff.currency,
      pricePerKwh: existing.tariff.pricePerKwh ?? incoming.tariff.pricePerKwh,
      pricePerMinute: existing.tariff.pricePerMinute ?? incoming.tariff.pricePerMinute,
      sessionFee: existing.tariff.sessionFee ?? incoming.tariff.sessionFee,
      preauthAmount: existing.tariff.preauthAmount ?? incoming.tariff.preauthAmount,
      blockingFeePerMinute:
        existing.tariff.blockingFeePerMinute ?? incoming.tariff.blockingFeePerMinute,
      blockingFeeStartsAfterMinutes:
        existing.tariff.blockingFeeStartsAfterMinutes ??
        incoming.tariff.blockingFeeStartsAfterMinutes,
      caps: mergedCaps,
      paymentMethods: mergedPaymentMethods,
      brandsAccepted: mergedBrandsAccepted,
      isComplete: existing.tariff.isComplete || incoming.tariff.isComplete,
      components: Array.from(
        new Map(
          [...existing.tariff.components, ...incoming.tariff.components].map((component) => [
            JSON.stringify(component),
            component,
          ]),
        ).values(),
      ),
    },
  };
}

function errorMessage(error: unknown) {
  return error instanceof Error ? error.message : "Unbekannter Fehler";
}

function parsePayloadJson(payload: string) {
  try {
    return JSON.parse(payload) as Record<string, unknown>;
  } catch (error) {
    const sanitized = sanitizeMobilithekJsonPayload(payload);

    if (sanitized !== payload) {
      return JSON.parse(sanitized) as Record<string, unknown>;
    }

    throw error;
  }
}

async function withFeedLock<T>(
  feedId: string,
  work: (client: PoolClient) => Promise<T>,
): Promise<{ ok: true; value: T } | { ok: false; reason: "busy" }> {
  const client = await getPool().connect();
  const lockKey = hashLockKey(feedId);
  let committed = false;

  try {
    await client.query("BEGIN");

    const lock = await client.query<{ locked: boolean }>(
      // Transaction-level advisory lock: released automatically on COMMIT/ROLLBACK.
      // This works correctly with Supabase pgBouncer (transaction mode) where
      // session-level locks can leak across pool connections.
      `select pg_try_advisory_xact_lock($1) as locked`,
      [lockKey],
    );

    if (!lock.rows[0]?.locked) {
      await client.query("ROLLBACK");
      return { ok: false, reason: "busy" };
    }

    // Run work, capturing errors so we can COMMIT before re-throwing.
    // Always committing ensures sync_runs audit entries (incl. failure records
    // written inside work's own catch block) are persisted even on errors.
    let workError: unknown = undefined;
    let workResult: T | undefined;
    try {
      workResult = await work(client);
    } catch (err) {
      workError = err;
    }

    await client.query("COMMIT");
    committed = true;

    if (workError !== undefined) {
      throw workError;
    }

    return { ok: true, value: workResult as T };
  } catch (error) {
    if (!committed) {
      await client.query("ROLLBACK").catch(() => undefined);
    }
    throw error;
  } finally {
    client.release();
  }
}

async function createRun(
  client: PoolClient,
  feedId: string,
  kind: FeedAction,
  message: string,
) {
  const result = await client.query(
    `insert into sync_runs (
        feed_id,
        kind,
        status,
        started_at,
        finished_at,
        message,
        delta_count
      ) values ($1::uuid, $2, 'running', now(), null, $3, 0)
      returning id::text`,
    [feedId, kind, message],
  );

  return String(result.rows[0].id);
}

async function finishRun(
  client: PoolClient,
  runId: string,
  input: {
    status: SyncRun["status"];
    message: string;
    deltaCount: number;
  },
) {
  await client.query(
    `update sync_runs
        set status = $2,
            finished_at = now(),
            message = $3,
            delta_count = $4
      where id = $1::uuid`,
    [runId, input.status, input.message, input.deltaCount],
  );
}

/**
 * Maximum raw-payload size (bytes) we persist in full. Bigger payloads are
 * summarised to avoid blowing up the jsonb column (Vaylens static is ~40 MB).
 * Override via RAW_PAYLOAD_MAX_BYTES (0 = no limit).
 */
const RAW_PAYLOAD_MAX_BYTES = Number(process.env.RAW_PAYLOAD_MAX_BYTES ?? 512 * 1024);

function summarizeLargePayload(payload: string, parsed: Record<string, unknown> | null) {
  const head = payload.slice(0, 4_000);
  const tail = payload.length > 8_000 ? payload.slice(-2_000) : "";
  return {
    __truncated: true,
    __size_bytes: Buffer.byteLength(payload, "utf8"),
    __top_level_keys: parsed ? Object.keys(parsed) : [],
    __preview_head: head,
    __preview_tail: tail,
  };
}

async function recordPayload(
  client: PoolClient,
  input: {
    runId: string;
    feedId: string;
    payloadKind: "snapshot" | "delta" | "webhook";
    payload: string;
  },
) {
  const sizeBytes = Buffer.byteLength(input.payload, "utf8");
  const tooBig = RAW_PAYLOAD_MAX_BYTES > 0 && sizeBytes > RAW_PAYLOAD_MAX_BYTES;

  let storedValue: Record<string, unknown>;
  let truncated = false;

  if (tooBig) {
    let parsedTop: Record<string, unknown> | null = null;
    try {
      parsedTop = parsePayloadJson(input.payload);
    } catch {
      parsedTop = null;
    }
    storedValue = summarizeLargePayload(input.payload, parsedTop);
    truncated = true;
  } else {
    try {
      storedValue = parsePayloadJson(input.payload);
    } catch {
      storedValue = { raw: input.payload };
    }
  }

  await client.query(
    `insert into raw_feed_payloads (
        run_id,
        feed_id,
        payload_kind,
        content_type,
        payload,
        payload_size_bytes,
        truncated
      ) values ($1::uuid, $2::uuid, $3, 'application/json', $4::jsonb, $5, $6)`,
    [input.runId, input.feedId, input.payloadKind, JSON.stringify(storedValue), sizeBytes, truncated],
  );
}

async function insertTariffShape(
  client: PoolClient,
  input: {
    stationId: string;
    chargePointId: string | null;
    tariff: ParsedTariff;
  },
) {
  const tariffResult = await client.query<{ id: string }>(
    `insert into tariffs (
        station_id,
        charge_point_id,
        tariff_key,
        tariff_code,
        tariff_scope,
        label,
        currency,
        is_complete,
        updated_at
      ) values ($1::uuid, $2::uuid, $3, $4, $5, $6, $7, $8, now())
      on conflict (tariff_key) do update
        set station_id = excluded.station_id,
            charge_point_id = excluded.charge_point_id,
            tariff_code = excluded.tariff_code,
            tariff_scope = excluded.tariff_scope,
            label = excluded.label,
            currency = excluded.currency,
            is_complete = excluded.is_complete,
            updated_at = now()
      returning id::text`,
    [
      input.stationId,
      input.chargePointId,
      input.tariff.id,
      input.tariff.externalCode,
      input.tariff.scope,
      input.tariff.label,
      input.tariff.currency,
      input.tariff.isComplete,
    ],
  );

  const tariffId = String(tariffResult.rows[0].id);

  await client.query(`delete from tariff_components where tariff_id = $1::uuid`, [tariffId]);
  await client.query(`delete from tariff_payment_methods where tariff_id = $1::uuid`, [tariffId]);
  await client.query(`delete from tariff_brands_accepted where tariff_id = $1::uuid`, [tariffId]);

  const componentRows = input.tariff.components.map((component) => ({
    componentType: component.componentType,
    amount: component.amount,
    startsAfterMinutes: component.startsAfterMinutes,
    priceCap: component.priceCap,
    taxIncluded: component.taxIncluded,
    taxRate: component.taxRate,
    overallPeriod: component.overallPeriod,
    timeBasedApplicability: component.timeBasedApplicability,
    energyBasedApplicability: component.energyBasedApplicability,
  }));

  for (const component of componentRows) {
    await client.query(
      `insert into tariff_components (
          tariff_id,
          component_type,
          amount,
          starts_after_minutes,
          price_cap,
          tax_included,
          tax_rate,
          overall_period,
          time_based_applicability,
          energy_based_applicability
        ) values ($1::uuid, $2, $3, $4, $5, $6, $7, $8::jsonb, $9::jsonb, $10::jsonb)`,
      [
        tariffId,
        component.componentType,
        component.amount,
        component.startsAfterMinutes,
        component.priceCap,
        component.taxIncluded,
        component.taxRate,
        component.overallPeriod ? JSON.stringify(component.overallPeriod) : null,
        component.timeBasedApplicability ? JSON.stringify(component.timeBasedApplicability) : null,
        component.energyBasedApplicability ? JSON.stringify(component.energyBasedApplicability) : null,
      ],
    );
  }

  for (const cap of input.tariff.caps) {
    await client.query(
      `insert into tariff_components (
          tariff_id,
          component_type,
          amount,
          starts_after_minutes,
          price_cap
        ) values ($1::uuid, 'cap', null, null, $2)`,
      [tariffId, cap.amount],
    );
  }

  for (const method of input.tariff.paymentMethods) {
    await client.query(
      `insert into tariff_payment_methods (tariff_id, payment_method)
       values ($1::uuid, $2)
       on conflict do nothing`,
      [tariffId, method],
    );
  }

  for (const brand of input.tariff.brandsAccepted) {
    await client.query(
      `insert into tariff_brands_accepted (tariff_id, brand)
       values ($1::uuid, $2)
       on conflict do nothing`,
      [tariffId, brand],
    );
  }

  return tariffId;
}

async function loadCurrentTariffFingerprint(client: PoolClient, tariffKey: string) {
  const result = await client.query<{
    tariff_key: string;
    tariff_code: string;
    label: string;
    currency: string;
    is_complete: boolean;
    component_type: string;
    amount: number | null;
    starts_after_minutes: number | null;
    price_cap: number | null;
    tax_included: boolean | null;
    tax_rate: number | null;
    overall_period: Record<string, unknown> | null;
    time_based_applicability: Record<string, unknown> | null;
    energy_based_applicability: Record<string, unknown> | null;
    payment_methods: string[];
    brands: string[];
  }>(
    `select
        t.tariff_key,
        t.tariff_code,
        t.label,
        t.currency,
        t.is_complete,
        c.component_type,
        c.amount::float8 as amount,
        c.starts_after_minutes,
        c.price_cap::float8 as price_cap,
        c.tax_included,
        c.tax_rate::float8 as tax_rate,
        c.overall_period,
        c.time_based_applicability,
        c.energy_based_applicability,
        coalesce(
          array(
            select payment_method
              from tariff_payment_methods
             where tariff_id = t.id
             order by payment_method
          ),
          '{}'
        ) as payment_methods,
        coalesce(
          array(
            select brand
              from tariff_brands_accepted
             where tariff_id = t.id
             order by brand
          ),
          '{}'
        ) as brands
      from tariffs t
 left join tariff_components c
        on c.tariff_id = t.id
     where t.tariff_key = $1`,
    [tariffKey],
  );

  if (!result.rows.length) {
    return null;
  }

  return JSON.stringify(
    result.rows.map((row) => ({
      tariffKey: row.tariff_key,
      tariffCode: row.tariff_code,
      label: row.label,
      currency: row.currency,
      isComplete: row.is_complete,
      componentType: row.component_type,
      amount: row.amount,
      startsAfterMinutes: row.starts_after_minutes,
      priceCap: row.price_cap,
      taxIncluded: row.tax_included,
      taxRate: row.tax_rate,
      overallPeriod: row.overall_period,
      timeBasedApplicability: row.time_based_applicability,
      energyBasedApplicability: row.energy_based_applicability,
      paymentMethods: row.payment_methods,
      brands: row.brands,
    })),
  );
}

async function upsertStaticCatalog(
  client: PoolClient,
  feed: FeedConfig,
  parsed: ParsedStaticFeed,
) {
  if (!parsed.catalog.length) return 0;

  // ── 1. CPOs (deduplicated, one bulk upsert) ───────────────────────────────
  const cpoMap = new Map<string, { name: string; countryCode: string }>();
  for (const s of parsed.catalog) cpoMap.set(s.cpoId, { name: s.cpoName, countryCode: s.countryCode });
  const cpoIds = [...cpoMap.keys()];
  await client.query(
    `insert into cpos (id, name, country_code)
     select * from unnest($1::text[], $2::text[], $3::text[]) as t(id, name, country_code)
     on conflict (id) do update
       set name = excluded.name, country_code = excluded.country_code`,
    [cpoIds, cpoIds.map((id) => cpoMap.get(id)!.name), cpoIds.map((id) => cpoMap.get(id)!.countryCode)],
  );

  // ── 2. Stations (one bulk upsert, returns station_code → id map) ──────────
  const c = parsed.catalog;
  const stationResult = await client.query<{ station_code: string; id: string }>(
    `insert into stations (
        station_code, cpo_id, name, address_line, city, postal_code, country_code,
        geom, charge_point_count, max_power_kw, current_types, connector_types,
        payment_methods, available_count, occupied_count, out_of_service_count,
        unknown_count, last_price_update_at, last_status_update_at, updated_at
      )
      select
        t.station_code, t.cpo_id, t.name, t.address_line, t.city, t.postal_code, t.country_code,
        st_setsrid(st_makepoint(t.lng, t.lat), 4326),
        t.cp_count, t.max_kw,
        coalesce(string_to_array(nullif(t.cur_types, ''), '|'), '{}'::text[]),
        coalesce(string_to_array(nullif(t.conn_types, ''), '|'), '{}'::text[]),
        coalesce(string_to_array(nullif(t.pay_methods, ''), '|'), '{}'::text[]),
        0, 0, 0, t.cp_count, null, null, now()
      from unnest(
        $1::text[], $2::text[], $3::text[], $4::text[], $5::text[], $6::text[], $7::text[],
        $8::float8[], $9::float8[],
        $10::int[], $11::float8[], $12::text[], $13::text[], $14::text[]
      ) as t(
        station_code, cpo_id, name, address_line, city, postal_code, country_code,
        lng, lat, cp_count, max_kw, cur_types, conn_types, pay_methods
      )
      on conflict (station_code) do update
        set cpo_id = excluded.cpo_id, name = excluded.name,
            address_line = excluded.address_line, city = excluded.city,
            postal_code = excluded.postal_code, country_code = excluded.country_code,
            geom = excluded.geom, charge_point_count = excluded.charge_point_count,
            max_power_kw = excluded.max_power_kw, current_types = excluded.current_types,
            connector_types = excluded.connector_types, payment_methods = excluded.payment_methods,
            updated_at = now()
      returning station_code, id::text`,
    [
      c.map((s) => s.stationCode),
      c.map((s) => s.cpoId),
      c.map((s) => s.name),
      c.map((s) => s.addressLine),
      c.map((s) => s.city),
      c.map((s) => s.postalCode ?? ""),
      c.map((s) => s.countryCode),
      c.map((s) => s.coordinates.lng),
      c.map((s) => s.coordinates.lat),
      c.map((s) => s.chargePointCount),
      c.map((s) => s.maxPowerKw ?? null),
      c.map((s) => s.currentTypes.join("|")),
      c.map((s) => s.connectorTypes.join("|")),
      c.map((s) => s.paymentMethods.join("|")),
    ],
  );
  const stationIdMap = new Map(stationResult.rows.map((r) => [r.station_code, r.id]));

  // ── 3. Charge points (one bulk upsert) ────────────────────────────────────
  type FlatCp = { stationCode: string; stationId: string; code: string; currentType: string; maxPowerKw: number | null; connectors: typeof parsed.catalog[0]["chargePoints"][0]["connectors"]; tariffs: typeof parsed.catalog[0]["chargePoints"][0]["tariffs"] };
  const allCps: FlatCp[] = [];
  for (const station of c) {
    const stationId = stationIdMap.get(station.stationCode);
    if (!stationId) continue;
    for (const cp of station.chargePoints) {
      allCps.push({ stationCode: station.stationCode, stationId, code: cp.chargePointCode, currentType: cp.currentType, maxPowerKw: cp.maxPowerKw ?? null, connectors: cp.connectors, tariffs: cp.tariffs });
    }
  }

  const cpResult = await client.query<{ charge_point_code: string; id: string }>(
    `insert into charge_points (station_id, charge_point_code, current_type, max_power_kw, last_status_raw, last_status_canonical, last_status_update_at)
     select t.sid::uuid, t.code, t.cur_type, t.max_kw, 'UNKNOWN', 'UNKNOWN', now()
     from unnest($1::text[], $2::text[], $3::text[], $4::float8[]) as t(sid, code, cur_type, max_kw)
     on conflict (charge_point_code) do update
       set station_id = excluded.station_id, current_type = excluded.current_type, max_power_kw = excluded.max_power_kw
     returning charge_point_code, id::text`,
    [allCps.map((cp) => cp.stationId), allCps.map((cp) => cp.code), allCps.map((cp) => cp.currentType), allCps.map((cp) => cp.maxPowerKw)],
  );
  const cpIdMap = new Map(cpResult.rows.map((r) => [r.charge_point_code, r.id]));
  const allCpIds = cpResult.rows.map((r) => r.id);

  // ── 4. Connectors (bulk delete + insert) ─────────────────────────────────
  if (allCpIds.length) {
    await client.query(`delete from connectors where charge_point_id = any($1::uuid[])`, [allCpIds]);
  }
  const connRows: Array<{ cpId: string; connType: string; maxKw: number | null }> = [];
  for (const cp of allCps) {
    const cpId = cpIdMap.get(cp.code);
    if (!cpId) continue;
    for (const conn of cp.connectors) connRows.push({ cpId, connType: conn.connectorType, maxKw: conn.maxPowerKw ?? null });
  }
  if (connRows.length) {
    await client.query(
      `insert into connectors (charge_point_id, connector_type, max_power_kw)
       select t.cp_id::uuid, t.conn_type, t.max_kw
       from unnest($1::text[], $2::text[], $3::float8[]) as t(cp_id, conn_type, max_kw)`,
      [connRows.map((r) => r.cpId), connRows.map((r) => r.connType), connRows.map((r) => r.maxKw)],
    );
  }

  // ── 5. Tariffs (bulk upsert per charge-point, then components) ─────────────
  const tariffRows: TariffShapeRow[] = [];
  for (const cp of allCps) {
    const cpId = cpIdMap.get(cp.code) ?? null;
    const stationId = cp.stationId;
    for (const tariff of cp.tariffs) {
      tariffRows.push({
        stationId,
        cpId,
        code: tariff.id,
        externalCode: tariff.externalCode,
        scope: tariff.scope,
        label: tariff.label ?? "",
        currency: tariff.currency ?? "EUR",
        isComplete: tariff.isComplete ?? false,
        tariff,
      });
    }
  }
  const uniqueTariffRows = [
    ...tariffRows.reduce<Map<string, TariffShapeRow>>((acc, row) => {
      const current = acc.get(row.code);
      acc.set(row.code, current ? mergeTariffShapes(current, row) : row);
      return acc;
    }, new Map()).values(),
  ];

  if (uniqueTariffRows.length) {
    const tariffResult = await client.query<{ tariff_key: string; id: string }>(
      `insert into tariffs (station_id, charge_point_id, tariff_key, tariff_code, tariff_scope, label, currency, is_complete, updated_at)
       select t.sid::uuid, t.cpid::uuid, t.tkey, t.tcode, t.tscope, t.label, t.currency, t.complete, now()
       from unnest($1::text[], $2::text[], $3::text[], $4::text[], $5::text[], $6::text[], $7::text[], $8::bool[]) as t(sid, cpid, tkey, tcode, tscope, label, currency, complete)
       on conflict (tariff_key) do update
         set station_id = excluded.station_id, charge_point_id = excluded.charge_point_id,
             tariff_code = excluded.tariff_code, tariff_scope = excluded.tariff_scope,
             label = excluded.label, currency = excluded.currency, is_complete = excluded.is_complete, updated_at = now()
       returning tariff_key, id::text`,
      [
        uniqueTariffRows.map((t) => t.stationId),
        uniqueTariffRows.map((t) => t.cpId),
        uniqueTariffRows.map((t) => t.code),
        uniqueTariffRows.map((t) => t.externalCode),
        uniqueTariffRows.map((t) => t.scope),
        uniqueTariffRows.map((t) => t.label),
        uniqueTariffRows.map((t) => t.currency),
        uniqueTariffRows.map((t) => t.isComplete),
      ],
    );
    const tariffIdMap = new Map(tariffResult.rows.map((r) => [r.tariff_key, r.id]));
    const allTariffIds = tariffResult.rows.map((r) => r.id);

    await client.query(`delete from tariff_components where tariff_id = any($1::uuid[])`, [allTariffIds]);
    await client.query(`delete from tariff_payment_methods where tariff_id = any($1::uuid[])`, [allTariffIds]);
    await client.query(`delete from tariff_brands_accepted where tariff_id = any($1::uuid[])`, [allTariffIds]);

    const compRows: Array<{
      tariffId: string;
      componentType: string;
      amount: number | null;
      startsAfterMinutes: number | null;
      priceCap: number | null;
      taxIncluded: boolean | null;
      taxRate: number | null;
      overallPeriod: string | null;
      timeBasedApplicability: string | null;
      energyBasedApplicability: string | null;
    }> = [];
    const pmRows: Array<[string, string]> = [];
    const brandRows: Array<[string, string]> = [];
    for (const row of uniqueTariffRows) {
      const tid = tariffIdMap.get(row.code);
      if (!tid) continue;
      const t = row.tariff;
      for (const component of t.components ?? []) {
        compRows.push({
          tariffId: tid,
          componentType: component.componentType,
          amount: component.amount,
          startsAfterMinutes: component.startsAfterMinutes,
          priceCap: component.priceCap,
          taxIncluded: component.taxIncluded,
          taxRate: component.taxRate,
          overallPeriod: component.overallPeriod ? JSON.stringify(component.overallPeriod) : null,
          timeBasedApplicability: component.timeBasedApplicability ? JSON.stringify(component.timeBasedApplicability) : null,
          energyBasedApplicability: component.energyBasedApplicability ? JSON.stringify(component.energyBasedApplicability) : null,
        });
      }
      for (const cap of t.caps ?? []) {
        compRows.push({
          tariffId: tid,
          componentType: "cap",
          amount: null,
          startsAfterMinutes: null,
          priceCap: cap.amount,
          taxIncluded: null,
          taxRate: null,
          overallPeriod: null,
          timeBasedApplicability: null,
          energyBasedApplicability: null,
        });
      }
      for (const pm of t.paymentMethods ?? []) pmRows.push([tid, pm]);
      for (const brand of t.brandsAccepted ?? []) brandRows.push([tid, brand]);
    }
    if (compRows.length) {
      await client.query(
        `insert into tariff_components (
            tariff_id, component_type, amount, starts_after_minutes, price_cap,
            tax_included, tax_rate, overall_period, time_based_applicability, energy_based_applicability
          )
         select t.tid::uuid, t.ctype, t.amount, t.sam, t.pcap, t.tax_included, t.tax_rate,
                t.overall_period::jsonb, t.time_based_applicability::jsonb, t.energy_based_applicability::jsonb
         from unnest(
           $1::text[], $2::text[], $3::float8[], $4::float8[], $5::float8[],
           $6::bool[], $7::float8[], $8::text[], $9::text[], $10::text[]
         ) as t(tid, ctype, amount, sam, pcap, tax_included, tax_rate, overall_period, time_based_applicability, energy_based_applicability)`,
        [
          compRows.map((r) => r.tariffId),
          compRows.map((r) => r.componentType),
          compRows.map((r) => r.amount),
          compRows.map((r) => r.startsAfterMinutes),
          compRows.map((r) => r.priceCap),
          compRows.map((r) => r.taxIncluded),
          compRows.map((r) => r.taxRate),
          compRows.map((r) => r.overallPeriod),
          compRows.map((r) => r.timeBasedApplicability),
          compRows.map((r) => r.energyBasedApplicability),
        ],
      );
    }
    if (pmRows.length) {
      await client.query(
        `insert into tariff_payment_methods (tariff_id, payment_method) select t.tid::uuid, t.pm from unnest($1::text[], $2::text[]) as t(tid, pm) on conflict do nothing`,
        [pmRows.map((r) => r[0]), pmRows.map((r) => r[1])],
      );
    }
    if (brandRows.length) {
      await client.query(
        `insert into tariff_brands_accepted (tariff_id, brand) select t.tid::uuid, t.brand from unnest($1::text[], $2::text[]) as t(tid, brand) on conflict do nothing`,
        [brandRows.map((r) => r[0]), brandRows.map((r) => r[1])],
      );
    }

    const pricedStationIds = [...new Set(uniqueTariffRows.map((row) => row.stationId))];
    if (pricedStationIds.length) {
      await client.query(
        `update stations
            set last_price_update_at = now(),
                updated_at = now()
          where id = any($1::uuid[])`,
        [pricedStationIds],
      );
    }
  }

  // ── 6. Cleanup: remove stale charge_points, tariffs, stations ─────────────
  const stationIdsByCode = [...stationIdMap.values()];
  if (stationIdsByCode.length) {
    await client.query(
      `delete from charge_points where station_id = any($1::uuid[]) and not (charge_point_code = any($2::text[]))`,
      [stationIdsByCode, allCps.map((cp) => cp.code)],
    );
    if (tariffRows.length) {
      await client.query(
        `delete from tariffs where station_id = any($1::uuid[]) and not (tariff_key = any($2::text[]))`,
        [stationIdsByCode, tariffRows.map((t) => t.code)],
      );
    }
  }
  // Remove stale stations: use feed.cpoId if configured, otherwise use the CPO IDs from
  // this parse run (handles cases where the station grouping changes between syncs).
  const staleCpoIds = feed.cpoId ? [feed.cpoId] : [...cpoMap.keys()];
  if (staleCpoIds.length && stationIdMap.size) {
    await client.query(
      `delete from stations where cpo_id = any($1::text[]) and not (station_code = any($2::text[]))`,
      [staleCpoIds, c.map((s) => s.stationCode)],
    );
  }

  for (const stationId of stationIdsByCode) {
    await aggregateStationStatus(client, stationId, null);
  }

  return parsed.catalog.length;
}

async function aggregateStationStatus(
  client: PoolClient,
  stationId: string,
  touchedAt: string | null,
) {
  await client.query(
    `with status_counts as (
        select
          station_id,
          count(*) filter (where last_status_canonical = 'AVAILABLE') as available_count,
          count(*) filter (where last_status_canonical in ('CHARGING', 'RESERVED', 'BLOCKED')) as occupied_count,
          count(*) filter (where last_status_canonical in ('OUT_OF_SERVICE', 'MAINTENANCE')) as out_of_service_count,
          count(*) filter (where last_status_canonical = 'UNKNOWN') as unknown_count,
          max(last_status_update_at) as max_status_update_at
        from charge_points
       where station_id = $1::uuid
       group by station_id
      )
      update stations s
         set available_count = coalesce(c.available_count, 0),
             occupied_count = coalesce(c.occupied_count, 0),
             out_of_service_count = coalesce(c.out_of_service_count, 0),
             unknown_count = coalesce(c.unknown_count, 0),
             last_status_update_at = coalesce($2::timestamptz, c.max_status_update_at, s.last_status_update_at),
             updated_at = now()
        from status_counts c
       where s.id = c.station_id`,
    [stationId, touchedAt],
  );
}

async function applyDynamicUpdates(
  client: PoolClient,
  feed: FeedConfig,
  updates: ReturnType<typeof parseDynamicMobilithekPayload>["updates"],
) {
  const touchedStations = new Set<string>();
  let deltaCount = 0;
  const nowIso = new Date().toISOString();

  for (const update of updates) {
    const chargePointResult = await client.query<{
      id: string;
      station_id: string;
      last_status_raw: string | null;
      last_status_canonical: string | null;
    }>(
      `select id::text, station_id::text, last_status_raw, last_status_canonical
         from charge_points
        where charge_point_code = $1`,
      [update.chargePointId],
    );

    if (!chargePointResult.rows[0]) {
      continue;
    }

    const chargePoint = chargePointResult.rows[0];
    const updateTime = update.lastUpdatedAt ?? nowIso;

    if (
      feed.ingestStatus &&
      (chargePoint.last_status_raw !== update.statusRaw ||
        chargePoint.last_status_canonical !== update.statusCanonical)
    ) {
      await client.query(
        `update charge_points
            set last_status_raw = $2,
                last_status_canonical = $3,
                last_status_update_at = $4::timestamptz
          where id = $1::uuid`,
        [chargePoint.id, update.statusRaw, update.statusCanonical, updateTime],
      );
      await client.query(
        `insert into availability_snapshots (
            charge_point_id,
            recorded_at,
            status_raw,
            status_canonical
          ) values ($1::uuid, $2::timestamptz, $3, $4)`,
        [chargePoint.id, updateTime, update.statusRaw, update.statusCanonical],
      );
      touchedStations.add(chargePoint.station_id);
      deltaCount += 1;
    }

    if (feed.ingestPrices) {
      for (const tariff of update.tariffs) {
        const before = await loadCurrentTariffFingerprint(client, tariff.id);
        const tariffId = await insertTariffShape(client, {
          stationId: chargePoint.station_id,
          chargePointId: chargePoint.id,
          tariff,
        });
        const afterFingerprint = tariffFingerprint(tariff);

        if (!before || before !== afterFingerprint) {
          await client.query(
            `insert into price_snapshots (
                tariff_id,
                recorded_at,
                summary
              ) values ($1::uuid, $2::timestamptz, $3::jsonb)`,
            [tariffId, updateTime, summarizeTariff(tariff)],
          );
          await client.query(
            `update stations
                set last_price_update_at = $2::timestamptz,
                    updated_at = now()
              where id = $1::uuid`,
            [chargePoint.station_id, updateTime],
          );
          touchedStations.add(chargePoint.station_id);
          deltaCount += 1;
        }
      }
    }
  }

  for (const stationId of touchedStations) {
    await aggregateStationStatus(client, stationId, nowIso);
  }

  return deltaCount;
}

async function markFeedFailure(client: PoolClient, feed: FeedConfig, message: string) {
  await updateFeedConfigDb(
    feed.id,
    {
      ...feed,
      lastErrorMessage: message,
      consecutiveFailures: feed.consecutiveFailures + 1,
      errorRate: Math.min(1, (feed.consecutiveFailures + 1) / 10),
    },
    client,
  );
}

async function markFeedSuccess(
  client: PoolClient,
  feed: FeedConfig,
  input: {
    lastSnapshotAt?: string | null;
    lastDeltaCount: number;
    cursorState?: Record<string, unknown> | null;
  },
) {
  await updateFeedConfigDb(
    feed.id,
    {
      ...feed,
      lastSuccessAt: new Date().toISOString(),
      lastSnapshotAt: input.lastSnapshotAt ?? feed.lastSnapshotAt,
      lastDeltaCount: input.lastDeltaCount,
      errorRate: feed.consecutiveFailures > 0 ? Math.max(0, feed.errorRate - 0.1) : feed.errorRate,
      cursorState: input.cursorState ?? feed.cursorState,
      lastErrorMessage: null,
      consecutiveFailures: 0,
    },
    client,
  );
}

/**
 * Hard cap per feed. A single slow/hung upstream (Vaylens mTLS timeout, huge
 * payload) must never block other feeds in the cycle. Configurable via
 * FEED_RUN_TIMEOUT_MS. Default 90s — enough for a 40 MB Vaylens pull + parse.
 */
const FEED_RUN_TIMEOUT_MS = Number(process.env.FEED_RUN_TIMEOUT_MS ?? 90_000);

function withTimeout<T>(promise: Promise<T>, ms: number, label: string): Promise<T> {
  return new Promise<T>((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error(`Timeout nach ${ms}ms: ${label}`)), ms);
    promise.then(
      (value) => {
        clearTimeout(timer);
        resolve(value);
      },
      (error) => {
        clearTimeout(timer);
        reject(error);
      },
    );
  });
}

export async function runFeedAction(
  feedId: string,
  action: FeedAction,
  options?: {
    payload?: string;
    dryRun?: boolean;
  },
) {
  let prefetchedStaticPayload: string | undefined = options?.payload;
  let prefetchedStaticParsed: ParsedStaticFeed | undefined;

  if (!prefetchedStaticPayload) {
    const feed = await getFeedConfigDb(feedId);
    if (!feed) {
      throw new Error("Feed not found");
    }

    if (feed.type === "static") {
      prefetchedStaticPayload = await fetchStaticMobilithekPayload(feed);
      prefetchedStaticParsed = parseStaticMobilithekPayload(prefetchedStaticPayload);
    }
  } else {
    const feed = await getFeedConfigDb(feedId);
    if (!feed) {
      throw new Error("Feed not found");
    }

    if (feed.type === "static") {
      prefetchedStaticParsed = parseStaticMobilithekPayload(prefetchedStaticPayload);
    }
  }

  const lockResult = await withFeedLock(feedId, async (client) => {
    const feed = await getFeedConfigDb(feedId, client);
    if (!feed) {
      throw new Error("Feed not found");
    }

    const runId = await createRun(client, feed.id, action, options?.dryRun ? "Feed-Test gestartet" : "Feed-Sync gestartet");

    try {
      let deltaCount = 0;
      let message = "Keine Änderungen";
      let cursorState = feed.cursorState ?? null;
      let lastSnapshotAt = feed.lastSnapshotAt;

      if (feed.type === "static") {
        const payload = prefetchedStaticPayload ?? (await fetchStaticMobilithekPayload(feed));
        await recordPayload(client, {
          runId,
          feedId: feed.id,
          payloadKind: payloadKindFor(feed, action),
          payload,
        });

        const parsed = prefetchedStaticParsed ?? parseStaticMobilithekPayload(payload);
        deltaCount = parsed.catalog.length;
        message = `${parsed.catalog.length} Stationen verarbeitet`;

        if (!options?.dryRun) {
          await upsertStaticCatalog(client, feed, parsed);
          lastSnapshotAt = new Date().toISOString();
        }
      } else {
        const dynamic = options?.payload
          ? {
              payload: options.payload,
              lastModified:
                typeof feed.cursorState?.lastModified === "string"
                  ? feed.cursorState.lastModified
                  : null,
            }
          : await pullDynamicMobilithekPayload(
              feed,
              typeof feed.cursorState?.lastModified === "string"
                ? feed.cursorState.lastModified
                : null,
            );

        if (!dynamic) {
          message = "Keine Änderungen seit dem letzten Pull";
        } else {
          await recordPayload(client, {
            runId,
            feedId: feed.id,
            payloadKind: payloadKindFor(feed, action),
            payload: dynamic.payload,
          });
          const parsed = parseDynamicMobilithekPayload(dynamic.payload);
          deltaCount = parsed.updates.length;
          message = `${parsed.updates.length} Delta-Updates verarbeitet`;

          if (!options?.dryRun) {
            deltaCount = await applyDynamicUpdates(client, feed, parsed.updates);
          }

          cursorState = {
            ...(feed.cursorState ?? {}),
            lastModified: dynamic.lastModified,
            lastWebhookAt: action === "webhook" ? new Date().toISOString() : feed.cursorState?.lastWebhookAt,
          };
        }
      }

      if (!options?.dryRun) {
        await markFeedSuccess(client, feed, {
          lastSnapshotAt,
          lastDeltaCount: deltaCount,
          cursorState,
        });
      }
      await finishRun(client, runId, {
        status: "success",
        message,
        deltaCount,
      });
    } catch (error) {
      const message = errorMessage(error);
      try {
        await markFeedFailure(client, feed, message);
        await finishRun(client, runId, {
          status: "failed",
          message,
          deltaCount: 0,
        });
      } catch (recordError) {
        console.error(
          `[ingest] failed to persist failure state for ${feed.id}:`,
          errorMessage(recordError),
        );
      }
      throw error;
    }

    const result = await client.query(
      `select *
         from sync_runs
        where id = $1::uuid`,
      [runId],
    );

    return result.rows[0]
      ? ({
          id: String(result.rows[0].id),
          feedId: String(result.rows[0].feed_id),
          kind: result.rows[0].kind,
          status: result.rows[0].status,
          startedAt: new Date(String(result.rows[0].started_at)).toISOString(),
          finishedAt: result.rows[0].finished_at
            ? new Date(String(result.rows[0].finished_at)).toISOString()
            : null,
          message: String(result.rows[0].message ?? ""),
          deltaCount: Number(result.rows[0].delta_count ?? 0),
        } satisfies SyncRun)
      : null;
  });

  if (!lockResult.ok) {
    // Another worker already holds the advisory lock. Persist a short
    // sync_runs entry so the admin UI sees the skip instead of silently
    // going stale, and bump the feed's lastErrorMessage for diagnostics.
    try {
      const feed = await getFeedConfigDb(feedId);
      if (feed) {
        const client = await getPool().connect();
        try {
          const runId = await createRun(client, feed.id, action, "Lock belegt");
          await finishRun(client, runId, {
            status: "failed",
            message: "Feed wird bereits verarbeitet (Lock belegt)",
            deltaCount: 0,
          });
        } finally {
          client.release();
        }
      }
    } catch (err) {
      console.error(`[ingest] failed to record lock-busy run for ${feedId}:`, errorMessage(err));
    }
    throw new Error("Feed wird bereits verarbeitet");
  }

  return lockResult.value;
}

export async function runDueFeedCycle() {
  // Clean up sync_runs stuck in "running" from prior Lambda timeouts or crashes.
  const cleaned = await cleanupStuckSyncRunsDb().catch((error) => {
    console.error("[ingest] cleanupStuckSyncRuns failed:", errorMessage(error));
    return 0;
  });
  if (cleaned) {
    console.log(`[ingest] cleaned up ${cleaned} stuck sync run(s)`);
  }

  let feeds: FeedConfig[];
  try {
    feeds = await listFeedConfigsDb();
  } catch (error) {
    console.error("[ingest] listFeedConfigsDb failed:", errorMessage(error));
    return 0;
  }

  const dueFeeds = feeds.filter((feed: FeedConfig) => shouldRunFeed(feed));
  if (!dueFeeds.length) {
    return 0;
  }

  // Parallelise — one slow/hung feed must not starve others. Each call is
  // additionally bounded by FEED_RUN_TIMEOUT_MS so the whole cycle has a
  // predictable upper bound.
  const results = await Promise.allSettled(
    dueFeeds.map((feed) => {
      const kind: FeedAction =
        feed.type === "dynamic" && feed.mode !== "pull" ? "reconciliation" : "manual";
      return withTimeout(runFeedAction(feed.id, kind), FEED_RUN_TIMEOUT_MS, feed.name);
    }),
  );

  results.forEach((result, index) => {
    if (result.status === "rejected") {
      console.error(
        `[ingest] ${dueFeeds[index]!.name} failed:`,
        errorMessage(result.reason),
      );
    }
  });

  return dueFeeds.length;
}

export async function processFeedWebhook(feedId: string, payload: string, incomingSecret?: string | null) {
  const feed = await getFeedConfigDb(feedId);
  if (!feed) {
    throw new Error("Feed not found");
  }

  const expectedSecret = resolveSecretRef(feed.webhookSecretRef);
  if (expectedSecret && incomingSecret !== expectedSecret) {
    throw new Error("Invalid webhook secret");
  }

  await getPool().query(
    `insert into webhook_deliveries (
        feed_id,
        received_at,
        status,
        payload_size
      ) values ($1::uuid, now(), 'accepted', $2)`,
    [feedId, payload.length],
  );

  return runFeedAction(feedId, "webhook", { payload });
}
