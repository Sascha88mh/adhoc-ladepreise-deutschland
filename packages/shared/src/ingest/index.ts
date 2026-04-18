import type { PoolClient } from "pg";
import type { FeedConfig, SyncRun, TariffSummary } from "../domain/types";
import {
  parseDynamicMobilithekPayload,
  parseStaticMobilithekPayload,
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

function errorMessage(error: unknown) {
  return error instanceof Error ? error.message : "Unbekannter Fehler";
}

async function withFeedLock<T>(feedId: string, work: (client: PoolClient) => Promise<T>) {
  const client = await getPool().connect();
  const lockKey = hashLockKey(feedId);

  try {
    const lock = await client.query<{ locked: boolean }>(
      `select pg_try_advisory_lock($1) as locked`,
      [lockKey],
    );

    if (!lock.rows[0]?.locked) {
      throw new Error("Feed wird bereits verarbeitet");
    }

    return await work(client);
  } finally {
    await client.query(`select pg_advisory_unlock($1)`, [lockKey]).catch(() => undefined);
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

async function recordPayload(
  client: PoolClient,
  input: {
    runId: string;
    feedId: string;
    payloadKind: "snapshot" | "delta" | "webhook";
    payload: string;
  },
) {
  let value: Record<string, unknown>;

  try {
    value = JSON.parse(input.payload) as Record<string, unknown>;
  } catch {
    value = { raw: input.payload };
  }

  await client.query(
    `insert into raw_feed_payloads (
        run_id,
        feed_id,
        payload_kind,
        content_type,
        payload
      ) values ($1::uuid, $2::uuid, $3, 'application/json', $4::jsonb)`,
    [input.runId, input.feedId, input.payloadKind, JSON.stringify(value)],
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
        tariff_code,
        label,
        currency,
        is_complete,
        updated_at
      ) values ($1::uuid, $2::uuid, $3, $4, $5, $6, now())
      on conflict (tariff_code) do update
        set station_id = excluded.station_id,
            charge_point_id = excluded.charge_point_id,
            label = excluded.label,
            currency = excluded.currency,
            is_complete = excluded.is_complete,
            updated_at = now()
      returning id::text`,
    [
      input.stationId,
      input.chargePointId,
      input.tariff.id,
      input.tariff.label,
      input.tariff.currency,
      input.tariff.isComplete,
    ],
  );

  const tariffId = String(tariffResult.rows[0].id);

  await client.query(`delete from tariff_components where tariff_id = $1::uuid`, [tariffId]);
  await client.query(`delete from tariff_payment_methods where tariff_id = $1::uuid`, [tariffId]);
  await client.query(`delete from tariff_brands_accepted where tariff_id = $1::uuid`, [tariffId]);

  const componentRows: Array<[string, number | null, number | null, number | null]> = [];
  if (input.tariff.pricePerKwh != null) {
    componentRows.push(["pricePerKWh", input.tariff.pricePerKwh, null, null]);
  }
  if (input.tariff.pricePerMinute != null) {
    componentRows.push(["pricePerMinute", input.tariff.pricePerMinute, null, null]);
  }
  if (input.tariff.sessionFee != null) {
    componentRows.push(["sessionFee", input.tariff.sessionFee, null, null]);
  }
  if (input.tariff.preauthAmount != null) {
    componentRows.push(["preauth", input.tariff.preauthAmount, null, null]);
  }
  if (input.tariff.blockingFeePerMinute != null) {
    componentRows.push([
      "blockingFee",
      input.tariff.blockingFeePerMinute,
      input.tariff.blockingFeeStartsAfterMinutes,
      null,
    ]);
  }
  for (const cap of input.tariff.caps) {
    componentRows.push(["cap", null, null, cap.amount]);
  }

  for (const [componentType, amount, startsAfterMinutes, priceCap] of componentRows) {
    await client.query(
      `insert into tariff_components (
          tariff_id,
          component_type,
          amount,
          starts_after_minutes,
          price_cap
        ) values ($1::uuid, $2, $3, $4, $5)`,
      [tariffId, componentType, amount, startsAfterMinutes, priceCap],
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

async function loadCurrentTariffSummary(client: PoolClient, tariffCode: string) {
  const result = await client.query<{
    label: string;
    currency: string;
    is_complete: boolean;
    component_type: string;
    amount: number | null;
    starts_after_minutes: number | null;
    price_cap: number | null;
    payment_methods: string[];
    brands: string[];
  }>(
    `select
        t.label,
        t.currency,
        t.is_complete,
        c.component_type,
        c.amount::float8 as amount,
        c.starts_after_minutes,
        c.price_cap::float8 as price_cap,
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
     where t.tariff_code = $1`,
    [tariffCode],
  );

  if (!result.rows.length) {
    return null;
  }

  const first = result.rows[0];
  const summary: TariffSummary = {
    id: tariffCode,
    label: first.label,
    currency: first.currency,
    pricePerKwh: null,
    pricePerMinute: null,
    sessionFee: null,
    preauthAmount: null,
    blockingFeePerMinute: null,
    blockingFeeStartsAfterMinutes: null,
    caps: [],
    paymentMethods: first.payment_methods ?? [],
    brandsAccepted: first.brands ?? [],
    isComplete: first.is_complete,
  };

  for (const row of result.rows) {
    if (row.component_type === "pricePerKWh") {
      summary.pricePerKwh = row.amount;
    } else if (row.component_type === "pricePerMinute") {
      summary.pricePerMinute = row.amount;
    } else if (row.component_type === "sessionFee") {
      summary.sessionFee = row.amount;
    } else if (row.component_type === "preauth") {
      summary.preauthAmount = row.amount;
    } else if (row.component_type === "blockingFee") {
      summary.blockingFeePerMinute = row.amount;
      summary.blockingFeeStartsAfterMinutes = row.starts_after_minutes;
    } else if (row.component_type === "cap" && row.price_cap != null) {
      summary.caps.push({
        label: "priceCap",
        amount: row.price_cap,
        currency: first.currency,
      });
    }
  }

  return summary;
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
        coalesce(string_to_array(nullif(t.cur_types, ''), '|'), '{}'),
        coalesce(string_to_array(nullif(t.conn_types, ''), '|'), '{}'),
        coalesce(string_to_array(nullif(t.pay_methods, ''), '|'), '{}'),
        0, 0, 0, t.cp_count, now(), now(), now()
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
            unknown_count = excluded.charge_point_count, last_price_update_at = now(), updated_at = now()
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
  const tariffRows: Array<{ stationId: string; cpId: string | null; code: string; label: string; currency: string; isComplete: boolean; tariff: typeof allCps[0]["tariffs"][0] }> = [];
  for (const cp of allCps) {
    const cpId = cpIdMap.get(cp.code) ?? null;
    const stationId = cp.stationId;
    for (const tariff of cp.tariffs) tariffRows.push({ stationId, cpId, code: tariff.id, label: tariff.label ?? "", currency: tariff.currency ?? "EUR", isComplete: tariff.isComplete ?? false, tariff });
  }
  if (tariffRows.length) {
    const tariffResult = await client.query<{ tariff_code: string; id: string }>(
      `insert into tariffs (station_id, charge_point_id, tariff_code, label, currency, is_complete, updated_at)
       select t.sid::uuid, t.cpid::uuid, t.code, t.label, t.currency, t.complete, now()
       from unnest($1::text[], $2::text[], $3::text[], $4::text[], $5::text[], $6::bool[]) as t(sid, cpid, code, label, currency, complete)
       on conflict (tariff_code) do update
         set station_id = excluded.station_id, charge_point_id = excluded.charge_point_id,
             label = excluded.label, currency = excluded.currency, is_complete = excluded.is_complete, updated_at = now()
       returning tariff_code, id::text`,
      [tariffRows.map((t) => t.stationId), tariffRows.map((t) => t.cpId ?? ""), tariffRows.map((t) => t.code), tariffRows.map((t) => t.label), tariffRows.map((t) => t.currency), tariffRows.map((t) => t.isComplete)],
    );
    const tariffIdMap = new Map(tariffResult.rows.map((r) => [r.tariff_code, r.id]));
    const allTariffIds = tariffResult.rows.map((r) => r.id);

    await client.query(`delete from tariff_components where tariff_id = any($1::uuid[])`, [allTariffIds]);
    await client.query(`delete from tariff_payment_methods where tariff_id = any($1::uuid[])`, [allTariffIds]);
    await client.query(`delete from tariff_brands_accepted where tariff_id = any($1::uuid[])`, [allTariffIds]);

    const compRows: Array<[string, string, number | null, number | null, number | null]> = [];
    const pmRows: Array<[string, string]> = [];
    const brandRows: Array<[string, string]> = [];
    for (const row of tariffRows) {
      const tid = tariffIdMap.get(row.code);
      if (!tid) continue;
      const t = row.tariff;
      if (t.pricePerKwh != null) compRows.push([tid, "pricePerKWh", t.pricePerKwh, null, null]);
      if (t.pricePerMinute != null) compRows.push([tid, "pricePerMinute", t.pricePerMinute, null, null]);
      if (t.sessionFee != null) compRows.push([tid, "sessionFee", t.sessionFee, null, null]);
      if (t.preauthAmount != null) compRows.push([tid, "preauth", t.preauthAmount, null, null]);
      if (t.blockingFeePerMinute != null) compRows.push([tid, "blockingFee", t.blockingFeePerMinute, t.blockingFeeStartsAfterMinutes ?? null, null]);
      for (const cap of t.caps ?? []) compRows.push([tid, "cap", null, null, cap.amount]);
      for (const pm of t.paymentMethods ?? []) pmRows.push([tid, pm]);
      for (const brand of t.brandsAccepted ?? []) brandRows.push([tid, brand]);
    }
    if (compRows.length) {
      await client.query(
        `insert into tariff_components (tariff_id, component_type, amount, starts_after_minutes, price_cap)
         select t.tid::uuid, t.ctype, t.amount, t.sam, t.pcap
         from unnest($1::text[], $2::text[], $3::float8[], $4::float8[], $5::float8[]) as t(tid, ctype, amount, sam, pcap)`,
        [compRows.map((r) => r[0]), compRows.map((r) => r[1]), compRows.map((r) => r[2]), compRows.map((r) => r[3]), compRows.map((r) => r[4])],
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
  }

  // ── 6. Cleanup: remove stale charge_points, tariffs, stations ─────────────
  const stationIdsByCode = [...stationIdMap.values()];
  if (stationIdsByCode.length) {
    await client.query(
      `delete from charge_points where station_id = any($1::uuid[]) and not (charge_point_code = any($2::text[]))`,
      [stationIdsByCode, allCps.map((cp) => cp.code)],
    );
    await client.query(
      `delete from tariffs where station_id = any($1::uuid[]) and not (tariff_code = any($2::text[]))`,
      [stationIdsByCode, tariffRows.map((t) => t.code)],
    );
  }
  if (feed.cpoId && stationIdMap.size) {
    await client.query(
      `delete from stations where cpo_id = $1 and not (station_code = any($2::text[]))`,
      [feed.cpoId, c.map((s) => s.stationCode)],
    );
  }

  return parsed.catalog.length;
}

async function aggregateStationStatus(client: PoolClient, stationId: string, touchedAt: string) {
  await client.query(
    `with status_counts as (
        select
          station_id,
          count(*) filter (where last_status_canonical = 'AVAILABLE') as available_count,
          count(*) filter (where last_status_canonical in ('CHARGING', 'RESERVED', 'BLOCKED')) as occupied_count,
          count(*) filter (where last_status_canonical in ('OUT_OF_SERVICE', 'MAINTENANCE')) as out_of_service_count,
          count(*) filter (where last_status_canonical = 'UNKNOWN') as unknown_count
        from charge_points
       where station_id = $1::uuid
       group by station_id
      )
      update stations s
         set available_count = coalesce(c.available_count, 0),
             occupied_count = coalesce(c.occupied_count, 0),
             out_of_service_count = coalesce(c.out_of_service_count, 0),
             unknown_count = coalesce(c.unknown_count, 0),
             last_status_update_at = $2::timestamptz,
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
        const before = await loadCurrentTariffSummary(client, tariff.id);
        const tariffId = await insertTariffShape(client, {
          stationId: chargePoint.station_id,
          chargePointId: chargePoint.id,
          tariff,
        });
        const afterSummary = summarizeTariff(tariff);

        if (!before || summarizeTariff(before) !== afterSummary) {
          await client.query(
            `insert into price_snapshots (
                tariff_id,
                recorded_at,
                summary
              ) values ($1::uuid, $2::timestamptz, $3::jsonb)`,
            [tariffId, updateTime, afterSummary],
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

export async function runFeedAction(
  feedId: string,
  action: FeedAction,
  options?: {
    payload?: string;
    dryRun?: boolean;
  },
) {
  return withFeedLock(feedId, async (client) => {
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
        const payload = options?.payload ?? (await fetchStaticMobilithekPayload(feed));
        await recordPayload(client, {
          runId,
          feedId: feed.id,
          payloadKind: payloadKindFor(feed, action),
          payload,
        });

        const parsed = parseStaticMobilithekPayload(payload);
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

      await markFeedSuccess(client, feed, {
        lastSnapshotAt,
        lastDeltaCount: deltaCount,
        cursorState,
      });
      await finishRun(client, runId, {
        status: "success",
        message,
        deltaCount,
      });
    } catch (error) {
      const message = errorMessage(error);
      await markFeedFailure(client, feed, message);
      await finishRun(client, runId, {
        status: "failed",
        message,
        deltaCount: 0,
      });
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
}

export async function runDueFeedCycle() {
  // Clean up any sync runs that got stuck in "running" state (e.g. Lambda timeout)
  await cleanupStuckSyncRunsDb().catch(() => undefined);

  const feeds = await listFeedConfigsDb();
  const dueFeeds = feeds.filter((feed: FeedConfig) => shouldRunFeed(feed));

  for (const feed of dueFeeds) {
    const kind: FeedAction =
      feed.type === "dynamic" && feed.mode !== "pull" ? "reconciliation" : "manual";

    await runFeedAction(feed.id, kind).catch((error) => {
      console.error(`[ingest] ${feed.name} failed:`, errorMessage(error));
    });
  }

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
