import type { PoolClient } from "pg";
import type {
  AdminStationRecord,
  FeedConfig,
  StationOverride,
  SyncRun,
} from "../domain/types";
import { adminStationRecordSchema, feedConfigSchema, stationOverrideSchema, syncRunSchema } from "../domain/types";
import { getPool } from "./pool";

function mapFeedRow(row: Record<string, unknown>): FeedConfig {
  return feedConfigSchema.parse({
    id: String(row.id),
    source: row.source ?? "mobilithek",
    cpoId: row.cpo_id ? String(row.cpo_id) : null,
    name: String(row.name),
    mode: row.mode,
    type: row.type,
    subscriptionId: String(row.subscription_id),
    urlOverride: row.url_override ? String(row.url_override) : null,
    pollIntervalMinutes:
      row.poll_interval_minutes == null ? null : Number(row.poll_interval_minutes),
    reconciliationIntervalMinutes:
      row.reconciliation_interval_minutes == null
        ? null
        : Number(row.reconciliation_interval_minutes),
    isActive: Boolean(row.is_active),
    ingestCatalog: Boolean(row.ingest_catalog),
    ingestPrices: Boolean(row.ingest_prices),
    ingestStatus: Boolean(row.ingest_status),
    credentialRef: row.credential_ref ? String(row.credential_ref) : null,
    webhookSecretRef: row.webhook_secret_ref ? String(row.webhook_secret_ref) : null,
    notes: String(row.notes ?? ""),
    lastSuccessAt: row.last_success_at ? new Date(String(row.last_success_at)).toISOString() : null,
    lastSnapshotAt: row.last_snapshot_at ? new Date(String(row.last_snapshot_at)).toISOString() : null,
    lastDeltaCount: Number(row.last_delta_count ?? 0),
    errorRate: Number(row.error_rate ?? 0),
    cursorState:
      row.cursor_state && typeof row.cursor_state === "object"
        ? (row.cursor_state as Record<string, unknown>)
        : null,
    lastErrorMessage: row.last_error_message ? String(row.last_error_message) : null,
    consecutiveFailures: Number(row.consecutive_failures ?? 0),
  });
}

function mapSyncRunRow(row: Record<string, unknown>): SyncRun {
  return syncRunSchema.parse({
    id: String(row.id),
    feedId: String(row.feed_id),
    kind: row.kind,
    status: row.status,
    startedAt: new Date(String(row.started_at)).toISOString(),
    finishedAt: row.finished_at ? new Date(String(row.finished_at)).toISOString() : null,
    message: String(row.message ?? ""),
    deltaCount: Number(row.delta_count ?? 0),
  });
}

function mapStationOverride(row: Record<string, unknown>): StationOverride | null {
  if (!row.override_station_id) {
    return null;
  }

  return stationOverrideSchema.parse({
    stationId: String(row.override_station_id),
    displayName: row.override_display_name ? String(row.override_display_name) : null,
    addressLine: row.override_address_line ? String(row.override_address_line) : null,
    city: row.override_city ? String(row.override_city) : null,
    postalCode: row.override_postal_code ? String(row.override_postal_code) : null,
    maxPowerKw:
      row.override_max_power_kw == null ? null : Number(row.override_max_power_kw),
    isHidden: Boolean(row.override_is_hidden),
    adminNote: row.override_admin_note ? String(row.override_admin_note) : null,
    updatedAt: new Date(String(row.override_updated_at)).toISOString(),
  });
}

function mapAdminStationRow(row: Record<string, unknown>): AdminStationRecord {
  const override = mapStationOverride(row);

  return adminStationRecordSchema.parse({
    stationId: String(row.station_id),
    stationCode: String(row.station_code),
    cpoId: String(row.cpo_id),
    cpoName: String(row.cpo_name),
    sourceName: String(row.source_name),
    effectiveName: override?.displayName ?? String(row.source_name),
    sourceAddressLine: String(row.source_address_line),
    effectiveAddressLine: override?.addressLine ?? String(row.source_address_line),
    sourceCity: String(row.source_city),
    effectiveCity: override?.city ?? String(row.source_city),
    sourcePostalCode: String(row.source_postal_code),
    effectivePostalCode: override?.postalCode ?? String(row.source_postal_code),
    sourceMaxPowerKw: Number(row.source_max_power_kw),
    effectiveMaxPowerKw: override?.maxPowerKw ?? Number(row.source_max_power_kw),
    isHidden: override?.isHidden ?? false,
    override,
  });
}

export async function listFeedConfigsDb(client?: PoolClient) {
  const executor = client ?? getPool();
  const result = await executor.query<Record<string, unknown>>(
    `select *
       from feed_configs
      order by created_at desc`,
  );

  return result.rows.map((row) => mapFeedRow(row));
}

export async function getFeedConfigDb(id: string, client?: PoolClient) {
  const executor = client ?? getPool();
  const result = await executor.query<Record<string, unknown>>(
    `select *
       from feed_configs
      where id = $1`,
    [id],
  );

  return result.rows[0] ? mapFeedRow(result.rows[0]) : null;
}

export async function createFeedConfigDb(
  input: Omit<
    FeedConfig,
    | "id"
    | "lastSuccessAt"
    | "lastSnapshotAt"
    | "lastDeltaCount"
    | "errorRate"
    | "cursorState"
    | "lastErrorMessage"
    | "consecutiveFailures"
  >,
  client?: PoolClient,
) {
  const executor = client ?? getPool();
  const result = await executor.query<Record<string, unknown>>(
    `insert into feed_configs (
        source,
        cpo_id,
        name,
        type,
        mode,
        subscription_id,
        url_override,
        poll_interval_minutes,
        reconciliation_interval_minutes,
        is_active,
        ingest_catalog,
        ingest_prices,
        ingest_status,
        credential_ref,
        webhook_secret_ref,
        notes
      ) values (
        $1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13, $14, $15, $16
      )
      returning *`,
    [
      input.source,
      input.cpoId,
      input.name,
      input.type,
      input.mode,
      input.subscriptionId,
      input.urlOverride,
      input.pollIntervalMinutes,
      input.reconciliationIntervalMinutes,
      input.isActive,
      input.ingestCatalog,
      input.ingestPrices,
      input.ingestStatus,
      input.credentialRef,
      input.webhookSecretRef,
      input.notes,
    ],
  );

  return mapFeedRow(result.rows[0]);
}

export async function updateFeedConfigDb(
  id: string,
  patch: Partial<FeedConfig>,
  client?: PoolClient,
) {
  const executor = client ?? getPool();
  const current = await getFeedConfigDb(id, client);
  if (!current) {
    return null;
  }

  const next = {
    ...current,
    ...patch,
    id,
  };

  const result = await executor.query<Record<string, unknown>>(
    `update feed_configs
        set source = $2,
            cpo_id = $3,
            name = $4,
            type = $5,
            mode = $6,
            subscription_id = $7,
            url_override = $8,
            poll_interval_minutes = $9,
            reconciliation_interval_minutes = $10,
            is_active = $11,
            ingest_catalog = $12,
            ingest_prices = $13,
            ingest_status = $14,
            credential_ref = $15,
            webhook_secret_ref = $16,
            notes = $17,
            last_success_at = $18,
            last_snapshot_at = $19,
            last_delta_count = $20,
            error_rate = $21,
            cursor_state = $22,
            last_error_message = $23,
            consecutive_failures = $24,
            updated_at = now()
      where id = $1
      returning *`,
    [
      id,
      next.source,
      next.cpoId,
      next.name,
      next.type,
      next.mode,
      next.subscriptionId,
      next.urlOverride,
      next.pollIntervalMinutes,
      next.reconciliationIntervalMinutes,
      next.isActive,
      next.ingestCatalog,
      next.ingestPrices,
      next.ingestStatus,
      next.credentialRef,
      next.webhookSecretRef,
      next.notes,
      next.lastSuccessAt,
      next.lastSnapshotAt,
      next.lastDeltaCount,
      next.errorRate,
      next.cursorState,
      next.lastErrorMessage,
      next.consecutiveFailures,
    ],
  );

  return result.rows[0] ? mapFeedRow(result.rows[0]) : null;
}

export async function deleteFeedConfigDb(id: string, client?: PoolClient) {
  const executor = client ?? getPool();
  const result = await executor.query(
    `delete from feed_configs
      where id = $1`,
    [id],
  );

  return (result.rowCount ?? 0) > 0;
}

export async function getAppSecret(key: string): Promise<string | null> {
  try {
    const result = await getPool().query<{ value: string }>(
      `select value from app_secrets where key = $1`,
      [key],
    );
    return result.rows[0]?.value ?? null;
  } catch {
    return null;
  }
}

export async function cleanupStuckSyncRunsDb(client?: PoolClient) {
  const executor = client ?? getPool();
  const result = await executor.query<{ id: string }>(
    `update sync_runs
        set status = 'failed',
            finished_at = now(),
            message = 'Abgebrochen (Timeout)'
      where status = 'running'
        and started_at < now() - interval '5 minutes'
      returning id::text`,
  );
  return result.rowCount ?? 0;
}

export async function listSyncRunsDb(feedId?: string, client?: PoolClient) {
  const executor = client ?? getPool();
  const result = await executor.query<Record<string, unknown>>(
    `select *
       from sync_runs
      where ($1::uuid is null or feed_id = $1::uuid)
      order by started_at desc
      limit 100`,
    [feedId ?? null],
  );

  return result.rows.map((row) => mapSyncRunRow(row));
}

export async function searchAdminStationsDb(query: string, client?: PoolClient) {
  const executor = client ?? getPool();
  const needle = `%${query.trim()}%`;
  const result = await executor.query<Record<string, unknown>>(
    `select
        s.id::text as station_id,
        s.station_code,
        s.cpo_id,
        c.name as cpo_name,
        s.name as source_name,
        s.address_line as source_address_line,
        s.city as source_city,
        s.postal_code as source_postal_code,
        s.max_power_kw as source_max_power_kw,
        o.station_id::text as override_station_id,
        o.display_name as override_display_name,
        o.address_line as override_address_line,
        o.city as override_city,
        o.postal_code as override_postal_code,
        o.max_power_kw as override_max_power_kw,
        coalesce(o.is_hidden, false) as override_is_hidden,
        o.admin_note as override_admin_note,
        o.updated_at as override_updated_at
      from stations s
      join cpos c
        on c.id = s.cpo_id
 left join station_overrides o
        on o.station_id = s.id
     where $1 = '%%'
        or s.name ilike $1
        or s.address_line ilike $1
        or s.city ilike $1
        or s.station_code ilike $1
        or c.name ilike $1
     order by c.name asc, s.name asc
     limit 25`,
    [needle],
  );

  return result.rows.map((row) => mapAdminStationRow(row));
}

export async function getAdminStationRecordDb(stationId: string, client?: PoolClient) {
  const executor = client ?? getPool();
  const result = await executor.query<Record<string, unknown>>(
    `select
        s.id::text as station_id,
        s.station_code,
        s.cpo_id,
        c.name as cpo_name,
        s.name as source_name,
        s.address_line as source_address_line,
        s.city as source_city,
        s.postal_code as source_postal_code,
        s.max_power_kw as source_max_power_kw,
        o.station_id::text as override_station_id,
        o.display_name as override_display_name,
        o.address_line as override_address_line,
        o.city as override_city,
        o.postal_code as override_postal_code,
        o.max_power_kw as override_max_power_kw,
        coalesce(o.is_hidden, false) as override_is_hidden,
        o.admin_note as override_admin_note,
        o.updated_at as override_updated_at
      from stations s
      join cpos c
        on c.id = s.cpo_id
 left join station_overrides o
        on o.station_id = s.id
     where s.id = $1::uuid`,
    [stationId],
  );

  return result.rows[0] ? mapAdminStationRow(result.rows[0]) : null;
}

export async function upsertStationOverrideDb(
  stationId: string,
  patch: {
    displayName: string | null;
    addressLine: string | null;
    city: string | null;
    postalCode: string | null;
    maxPowerKw: number | null;
    isHidden: boolean;
    adminNote: string | null;
  },
  client?: PoolClient,
) {
  const executor = client ?? getPool();
  await executor.query(
    `insert into station_overrides (
        station_id,
        display_name,
        address_line,
        city,
        postal_code,
        max_power_kw,
        is_hidden,
        admin_note
      ) values ($1::uuid, $2, $3, $4, $5, $6, $7, $8)
      on conflict (station_id) do update
        set display_name = excluded.display_name,
            address_line = excluded.address_line,
            city = excluded.city,
            postal_code = excluded.postal_code,
            max_power_kw = excluded.max_power_kw,
            is_hidden = excluded.is_hidden,
            admin_note = excluded.admin_note,
            updated_at = now()`,
    [
      stationId,
      patch.displayName,
      patch.addressLine,
      patch.city,
      patch.postalCode,
      patch.maxPowerKw,
      patch.isHidden,
      patch.adminNote,
    ],
  );

  return getAdminStationRecordDb(stationId, client);
}

export async function deleteStationOverrideDb(stationId: string, client?: PoolClient) {
  const executor = client ?? getPool();
  const result = await executor.query(
    `delete from station_overrides
      where station_id = $1::uuid`,
    [stationId],
  );

  return (result.rowCount ?? 0) > 0;
}
