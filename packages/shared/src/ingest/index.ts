import type { PoolClient } from "pg";
import { gunzipSync } from "node:zlib";
import { timingSafeEqual } from "node:crypto";

function timingSafeEqualStrings(a: string, b: string): boolean {
  const aBuf = Buffer.from(a, "utf8");
  const bBuf = Buffer.from(b, "utf8");
  if (aBuf.length !== bBuf.length) return false;
  return timingSafeEqual(aBuf, bBuf);
}
import type { FeedConfig, SyncRun, TariffSummary } from "../domain/types";
import {
  parseDynamicMobilithekPayload,
  parseStaticMobilithekPayload,
  sanitizeMobilithekJsonPayload,
} from "../mobilithek/parser";
import type { ParsedChargePoint, ParsedStaticFeed, ParsedStationCatalog, ParsedTariff } from "../mobilithek/types";
import {
  fetchStaticMobilithekPayload,
  pullDynamicMobilithekPayload,
  resolveSecretRef,
} from "../mobilithek/client";
import {
  cleanupIngestHistoryDb,
  cleanupStuckSyncRunsDb,
  getFeedConfigDb,
  listFeedConfigsDb,
  updateFeedConfigDb,
} from "../db/admin";
import { getPool } from "../db/pool";

type FeedAction = "test" | "manual" | "reconciliation" | "webhook";

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

  if (feed.mode === "push") {
    return feed.reconciliationIntervalMinutes;
  }

  return feed.reconciliationIntervalMinutes ?? feed.pollIntervalMinutes ?? 2;
}

function sanitizeWebhookPayload(raw: string): string {
  return raw
    .replace(/\u0000/g, "")
    .replace(/\\u0000/gi, "")
    .replace(/\\u\{([0-9a-fA-F]+)\}/g, (_, hex) => {
      const cp = Number.parseInt(hex, 16);
      if (Number.isNaN(cp) || cp > 0x10ffff) return "";
      return String.fromCodePoint(cp);
    })
    .replace(/\\u(?![0-9a-fA-F]{4})/gi, "\\uFFFD")
    .replace(/\\uD[89AB][0-9A-F]{2}(?!\\uD[CDEF][0-9A-F]{2})/gi, "\\uFFFD")
    .replace(/(^|[^\\])(\\uD[CDEF][0-9A-F]{2})/gi, (_, prefix) => `${prefix}\\uFFFD`);
}

export function decodeMobilithekWebhookPayload(
  rawBody: ArrayBuffer | Buffer | Uint8Array,
  contentEncoding?: string | null,
) {
  const buffer = Buffer.isBuffer(rawBody)
    ? rawBody
    : rawBody instanceof Uint8Array
      ? Buffer.from(rawBody)
      : Buffer.from(rawBody);
  const normalizedEncoding = contentEncoding?.toLowerCase() ?? "";
  const looksGzip = buffer.length >= 2 && buffer[0] === 0x1f && buffer[1] === 0x8b;
  const diagnostics: Record<string, unknown> = {
    bodyLen: buffer.length,
    first8Hex: buffer.slice(0, 8).toString("hex"),
    contentEncoding: contentEncoding ?? null,
    looksGzip,
  };

  let raw: string;
  if (looksGzip || normalizedEncoding.includes("gzip")) {
    raw = gunzipSync(buffer).toString("utf-8");
    diagnostics.gunzipped = true;
  } else {
    raw = buffer.toString("utf-8");
    diagnostics.decodedAsUtf8 = true;
  }

  return {
    payload: sanitizeWebhookPayload(raw),
    diagnostics,
  };
}

function failureBackoffMinutesFor(feed: FeedConfig) {
  const failures = Math.max(feed.consecutiveFailures, 1);
  const baseMinutes = feed.type === "static" ? 60 : 2;
  const maxMinutes = feed.type === "static" ? 6 * 60 : 30;
  return Math.min(maxMinutes, baseMinutes * 2 ** Math.min(failures - 1, 6));
}

function shouldRunFeed(feed: FeedConfig, latestRun?: SyncRun) {
  if (!feed.isActive) {
    return false;
  }

  if (feed.type === "static" && !feed.ingestCatalog && !feed.ingestPrices) {
    return false;
  }

  if (feed.type === "dynamic" && !feed.ingestPrices && !feed.ingestStatus) {
    return false;
  }

  if (latestRun?.status === "queued" || latestRun?.status === "running") {
    return false;
  }

  if (latestRun?.status === "failed") {
    const backoffMinutes = failureBackoffMinutesFor(feed);
    const failedAt = latestRun.finishedAt ?? latestRun.startedAt;
    if (
      backoffMinutes > 0 &&
      Date.now() - new Date(failedAt).getTime() < backoffMinutes * 60_000
    ) {
      return false;
    }
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

type TariffFingerprintRow = {
  tariffKey: string;
  tariffCode: string;
  label: string;
  currency: string;
  isComplete: boolean;
  componentType: string | null;
  amount: number | null;
  startsAfterMinutes: number | null;
  priceCap: number | null;
  taxIncluded: boolean | null;
  taxRate: number | null;
  overallPeriod: Record<string, unknown> | null;
  timeBasedApplicability: Record<string, unknown> | null;
  energyBasedApplicability: Record<string, unknown> | null;
  paymentMethods: string[];
  brands: string[];
};

function stableStringify(value: unknown): string {
  if (Array.isArray(value)) {
    return `[${value.map((entry) => stableStringify(entry)).join(",")}]`;
  }

  if (value && typeof value === "object") {
    return `{${Object.entries(value as Record<string, unknown>)
      .sort(([left], [right]) => left.localeCompare(right))
      .map(([key, entry]) => `${JSON.stringify(key)}:${stableStringify(entry)}`)
      .join(",")}}`;
  }

  return JSON.stringify(value);
}

function normalizeJsonObject(value: Record<string, unknown> | null) {
  return value == null ? null : stableStringify(value);
}

function tariffFingerprintRows(row: TariffShapeRow): TariffFingerprintRow[] {
  const paymentMethods = [...row.tariff.paymentMethods].sort();
  const brands = [...row.tariff.brandsAccepted].sort();
  const componentRows: TariffFingerprintRow[] = [
    ...row.tariff.components.map((component) => ({
      tariffKey: row.code,
      tariffCode: row.externalCode,
      label: row.label,
      currency: row.currency,
      isComplete: row.isComplete,
      componentType: component.componentType,
      amount: component.amount,
      startsAfterMinutes: component.startsAfterMinutes,
      priceCap: component.priceCap,
      taxIncluded: component.taxIncluded,
      taxRate: component.taxRate,
      overallPeriod: component.overallPeriod,
      timeBasedApplicability: component.timeBasedApplicability,
      energyBasedApplicability: component.energyBasedApplicability,
      paymentMethods,
      brands,
    })),
    ...row.tariff.caps.map((cap) => ({
      tariffKey: row.code,
      tariffCode: row.externalCode,
      label: row.label,
      currency: row.currency,
      isComplete: row.isComplete,
      componentType: "cap",
      amount: null,
      startsAfterMinutes: null,
      priceCap: cap.amount,
      taxIncluded: null,
      taxRate: null,
      overallPeriod: null,
      timeBasedApplicability: null,
      energyBasedApplicability: null,
      paymentMethods,
      brands,
    })),
  ];

  if (!componentRows.length) {
    componentRows.push({
      tariffKey: row.code,
      tariffCode: row.externalCode,
      label: row.label,
      currency: row.currency,
      isComplete: row.isComplete,
      componentType: null,
      amount: null,
      startsAfterMinutes: null,
      priceCap: null,
      taxIncluded: null,
      taxRate: null,
      overallPeriod: null,
      timeBasedApplicability: null,
      energyBasedApplicability: null,
      paymentMethods,
      brands,
    });
  }

  return componentRows;
}

function tariffStorageFingerprint(row: TariffShapeRow) {
  return JSON.stringify(
    tariffFingerprintRows(row)
      .map((entry) => ({
        ...entry,
        overallPeriod: normalizeJsonObject(entry.overallPeriod),
        timeBasedApplicability: normalizeJsonObject(entry.timeBasedApplicability),
        energyBasedApplicability: normalizeJsonObject(entry.energyBasedApplicability),
      }))
      .sort((left, right) =>
        [
          left.componentType ?? "",
          String(left.amount ?? ""),
          String(left.startsAfterMinutes ?? ""),
          String(left.priceCap ?? ""),
          left.overallPeriod ?? "",
          left.timeBasedApplicability ?? "",
          left.energyBasedApplicability ?? "",
        ].join("|").localeCompare([
          right.componentType ?? "",
          String(right.amount ?? ""),
          String(right.startsAfterMinutes ?? ""),
          String(right.priceCap ?? ""),
          right.overallPeriod ?? "",
          right.timeBasedApplicability ?? "",
          right.energyBasedApplicability ?? "",
        ].join("|")),
      ),
  );
}

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

function mergeUniqueValues<T>(...lists: T[][]): T[] {
  return Array.from(new Set(lists.flat()));
}

function mergeChargePoints(
  existing: ParsedChargePoint,
  incoming: ParsedChargePoint,
): ParsedChargePoint {
  return {
    ...existing,
    currentType: existing.currentType === "DC" ? existing.currentType : incoming.currentType,
    maxPowerKw: Math.max(existing.maxPowerKw ?? 0, incoming.maxPowerKw ?? 0),
    connectors: Array.from(
      new Map(
        [...existing.connectors, ...incoming.connectors].map((connector) => [
          `${connector.connectorType}|${connector.maxPowerKw ?? ""}`,
          connector,
        ]),
      ).values(),
    ),
    tariffs: Array.from(
      new Map(
        [...existing.tariffs, ...incoming.tariffs].map((tariff) => [tariff.id, tariff]),
      ).values(),
    ),
  };
}

function mergeStationCatalogEntries(
  existing: ParsedStationCatalog,
  incoming: ParsedStationCatalog,
): ParsedStationCatalog {
  const chargePoints = Array.from(
    [...existing.chargePoints, ...incoming.chargePoints]
      .reduce<Map<string, ParsedChargePoint>>((acc, point) => {
        const current = acc.get(point.chargePointCode);
        acc.set(point.chargePointCode, current ? mergeChargePoints(current, point) : point);
        return acc;
      }, new Map())
      .values(),
  );

  return {
    ...existing,
    chargePointCount: Math.max(existing.chargePointCount, incoming.chargePointCount, chargePoints.length),
    currentTypes: mergeUniqueValues(existing.currentTypes, incoming.currentTypes),
    connectorTypes: mergeUniqueValues(existing.connectorTypes, incoming.connectorTypes),
    paymentMethods: mergeUniqueValues(existing.paymentMethods, incoming.paymentMethods),
    maxPowerKw: Math.max(existing.maxPowerKw ?? 0, incoming.maxPowerKw ?? 0),
    chargePoints,
    notes: mergeUniqueValues(existing.notes, incoming.notes),
  };
}

function dedupeStaticCatalog(parsed: ParsedStaticFeed): ParsedStaticFeed {
  const catalog = Array.from(
    parsed.catalog
      .reduce<Map<string, ParsedStationCatalog>>((acc, station) => {
        const current = acc.get(station.stationCode);
        acc.set(station.stationCode, current ? mergeStationCatalogEntries(current, station) : station);
        return acc;
      }, new Map())
      .values(),
  );

  return {
    catalog,
    stations: parsed.stations,
  };
}

function errorMessage(error: unknown) {
  return error instanceof Error ? error.message : "Unbekannter Fehler";
}

function parsePayloadJson(payload: string) {
  return JSON.parse(sanitizeMobilithekJsonPayload(payload)) as Record<string, unknown>;
}

function mapSyncRun(row: Record<string, unknown>): SyncRun {
  return {
    id: String(row.id),
    feedId: String(row.feed_id),
    kind: row.kind as SyncRun["kind"],
    status: row.status as SyncRun["status"],
    startedAt: new Date(String(row.started_at)).toISOString(),
    finishedAt: row.finished_at ? new Date(String(row.finished_at)).toISOString() : null,
    message: String(row.message ?? ""),
    deltaCount: Number(row.delta_count ?? 0),
    progressStage: row.progress_stage ? String(row.progress_stage) : null,
    progressDetail: row.progress_detail ? String(row.progress_detail) : null,
    heartbeatAt: row.heartbeat_at ? new Date(String(row.heartbeat_at)).toISOString() : null,
    payloadSizeBytes: row.payload_size_bytes == null ? null : Number(row.payload_size_bytes),
    processedCount: row.processed_count == null ? null : Number(row.processed_count),
    totalCount: row.total_count == null ? null : Number(row.total_count),
  };
}

async function loadRun(client: PoolClient, runId: string) {
  const result = await client.query<Record<string, unknown>>(
    `select *
       from sync_runs
      where id = $1::uuid`,
    [runId],
  );

  return result.rows[0] ? mapSyncRun(result.rows[0]) : null;
}

async function loadRunningRun(feedId: string) {
  const result = await getPool().query<Record<string, unknown>>(
    `select *
       from sync_runs
      where feed_id = $1::uuid
        and status in ('queued', 'running')
      order by started_at asc
      limit 1`,
    [feedId],
  );

  return result.rows[0] ? mapSyncRun(result.rows[0]) : null;
}

async function cleanupStaleActiveRun(feedId: string) {
  await getPool().query(
    `update sync_runs
        set status = 'failed',
            finished_at = now(),
            message = case
              when status = 'queued' then 'Abgebrochen (Queue-Timeout)'
              else 'Abgebrochen (Timeout)'
            end,
            progress_stage = 'failed',
            progress_detail = 'Timeout-Cleanup',
            heartbeat_at = now()
      where feed_id = $1::uuid
        and (
          (status = 'running' and coalesce(heartbeat_at, started_at) < now() - ($2::text)::interval)
          or
          (status = 'queued' and started_at < now() - interval '60 minutes')
        )`,
    [feedId, process.env.SYNC_RUN_STALE_AFTER ?? "45 minutes"],
  );
}

async function claimFeedRun(feedId: string, kind: FeedAction, message: string) {
  await cleanupStaleActiveRun(feedId);

  const insertClaim = () => getPool().query<Record<string, unknown>>(
    `insert into sync_runs (
        feed_id,
        kind,
        status,
        started_at,
        finished_at,
        message,
        delta_count,
        progress_stage,
        heartbeat_at,
        processed_count
      ) values ($1::uuid, $2, 'running', now(), null, $3, 0, 'starting', now(), 0)
      on conflict (feed_id) where status in ('queued', 'running') do nothing
      returning *`,
    [feedId, kind, message],
  );
  const result = await insertClaim();

  if (result.rows[0]) {
    return { claimed: true as const, run: mapSyncRun(result.rows[0]) };
  }

  const running = await loadRunningRun(feedId);
  if (running) {
    return { claimed: false as const, run: running };
  }

  // The conflicting run may have finished between ON CONFLICT and the lookup.
  // Retry once so manual actions do not fail spuriously on that tiny race.
  const retry = await insertClaim();
  if (retry.rows[0]) {
    return { claimed: true as const, run: mapSyncRun(retry.rows[0]) };
  }

  return {
    claimed: false as const,
    run: await loadRunningRun(feedId),
  };
}

async function promoteQueuedRun(runId: string, message: string) {
  const result = await getPool().query<Record<string, unknown>>(
    `update sync_runs
        set status = 'running',
            started_at = now(),
            finished_at = null,
            message = $2,
            delta_count = 0,
            progress_stage = 'starting',
            progress_detail = null,
            heartbeat_at = now(),
            payload_size_bytes = null,
            processed_count = 0,
            total_count = null
      where id = $1::uuid
        and status = 'queued'
      returning *`,
    [runId, message],
  );

  return result.rows[0] ? mapSyncRun(result.rows[0]) : null;
}

async function loadQueuedRuns(limit: number) {
  const result = await getPool().query<Record<string, unknown>>(
    `select sr.*
       from sync_runs sr
       join feed_configs fc
         on fc.id = sr.feed_id
      where sr.status = 'queued'
      order by sr.started_at asc, sr.id asc
      limit $1`,
    [limit],
  );

  return result.rows.map((row) => mapSyncRun(row));
}

async function loadLatestRunsByFeed() {
  const result = await getPool().query<Record<string, unknown>>(
    `select distinct on (feed_id) *
       from sync_runs
      order by feed_id, started_at desc, id desc`,
  );

  return new Map(result.rows.map((row) => {
    const run = mapSyncRun(row);
    return [run.feedId, run] as const;
  }));
}

async function assertRunStillRunning(client: PoolClient, runId: string) {
  const run = await loadRun(client, runId);
  if (!run || run.status !== "running") {
    throw new Error("Feed-Lauf wurde abgebrochen");
  }
}

async function updateRunProgress(
  runId: string,
  input: {
    stage: string;
    detail?: string | null;
    message?: string;
    payloadSizeBytes?: number | null;
    processedCount?: number | null;
    totalCount?: number | null;
  },
  _client?: PoolClient,
) {
  // Progress must be committed independently from long ingest transactions.
  // Otherwise static/dynamic bulk writes look stuck at "parsed" until COMMIT.
  const executor = getPool();
  await executor.query(
    `update sync_runs
        set progress_stage = $2,
            progress_detail = $3,
            heartbeat_at = now(),
            message = coalesce($4, message),
            payload_size_bytes = coalesce($5, payload_size_bytes),
            processed_count = coalesce($6, processed_count),
            total_count = coalesce($7, total_count)
      where id = $1::uuid
        and status in ('queued', 'running')`,
    [
      runId,
      input.stage,
      input.detail ?? null,
      input.message ?? null,
      input.payloadSizeBytes ?? null,
      input.processedCount ?? null,
      input.totalCount ?? null,
    ],
  );
}

async function configureIngestTransaction(client: PoolClient) {
  await client.query(`select set_config('statement_timeout', $1, true)`, [
    process.env.INGEST_STATEMENT_TIMEOUT ?? "30min",
  ]);
  await client.query(`select set_config('lock_timeout', $1, true)`, [
    process.env.INGEST_LOCK_TIMEOUT ?? "30s",
  ]);
  await client.query(`select set_config('idle_in_transaction_session_timeout', $1, true)`, [
    process.env.INGEST_IDLE_IN_TRANSACTION_TIMEOUT ?? "30min",
  ]);
}

export async function enqueueFeedSync(feedId: string) {
  const feed = await getFeedConfigDb(feedId);
  if (!feed) {
    throw new Error("Feed not found");
  }

  await cleanupStaleActiveRun(feed.id);

  const result = await getPool().query<Record<string, unknown>>(
    `insert into sync_runs (
        feed_id,
        kind,
        status,
        started_at,
        finished_at,
        message,
        delta_count,
        progress_stage,
        progress_detail,
        heartbeat_at,
        processed_count
      ) values ($1::uuid, 'manual', 'queued', now(), null, 'Feed-Sync wartet auf Verarbeitung', 0, 'queued', 'Wartet auf nächsten Ingest-Zyklus', now(), 0)
      on conflict (feed_id) where status in ('queued', 'running') do nothing
      returning *`,
    [feed.id],
  );

  if (result.rows[0]) {
    return mapSyncRun(result.rows[0]);
  }

  const active = await loadRunningRun(feed.id);
  if (active) {
    return active;
  }

  const retry = await getPool().query<Record<string, unknown>>(
    `insert into sync_runs (
        feed_id,
        kind,
        status,
        started_at,
        finished_at,
        message,
        delta_count,
        progress_stage,
        progress_detail,
        heartbeat_at,
        processed_count
      ) values ($1::uuid, 'manual', 'queued', now(), null, 'Feed-Sync wartet auf Verarbeitung', 0, 'queued', 'Wartet auf nächsten Ingest-Zyklus', now(), 0)
      on conflict (feed_id) where status in ('queued', 'running') do nothing
      returning *`,
    [feed.id],
  );

  if (retry.rows[0]) {
    return mapSyncRun(retry.rows[0]);
  }

  const racedActive = await loadRunningRun(feed.id);
  if (!racedActive) {
    throw new Error("Sync run could not be queued");
  }

  return racedActive;
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
            delta_count = $4,
            progress_stage = $2,
            progress_detail = $3,
            heartbeat_at = now(),
            processed_count = case when $2 = 'success' then $4 else processed_count end,
            total_count = case when $2 = 'success' then $4 else total_count end
      where id = $1::uuid
        and status = 'running'`,
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

async function loadCurrentTariffFingerprints(client: PoolClient, tariffKeys: string[]) {
  if (!tariffKeys.length) {
    return new Map<string, string>();
  }

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
     where t.tariff_key = any($1::text[])
     order by
       t.tariff_key,
       c.component_type nulls first,
       c.amount nulls first,
       c.starts_after_minutes nulls first,
       c.price_cap nulls first,
       c.id`,
    [tariffKeys],
  );

  const rowsByKey = new Map<string, TariffFingerprintRow[]>();
  for (const row of result.rows) {
    const rows = rowsByKey.get(row.tariff_key) ?? [];
    rows.push({
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
    });
    rowsByKey.set(row.tariff_key, rows);
  }

  return new Map(
    [...rowsByKey.entries()].map(([key, rows]) => [
      key,
      JSON.stringify(
        rows
          .map((entry) => ({
            ...entry,
            paymentMethods: [...entry.paymentMethods].sort(),
            brands: [...entry.brands].sort(),
            overallPeriod: normalizeJsonObject(entry.overallPeriod),
            timeBasedApplicability: normalizeJsonObject(entry.timeBasedApplicability),
            energyBasedApplicability: normalizeJsonObject(entry.energyBasedApplicability),
          }))
          .sort((left, right) =>
            [
              left.componentType ?? "",
              String(left.amount ?? ""),
              String(left.startsAfterMinutes ?? ""),
              String(left.priceCap ?? ""),
              left.overallPeriod ?? "",
              left.timeBasedApplicability ?? "",
              left.energyBasedApplicability ?? "",
            ].join("|").localeCompare([
              right.componentType ?? "",
              String(right.amount ?? ""),
              String(right.startsAfterMinutes ?? ""),
              String(right.priceCap ?? ""),
              right.overallPeriod ?? "",
              right.timeBasedApplicability ?? "",
              right.energyBasedApplicability ?? "",
            ].join("|")),
          ),
      ),
    ]),
  );
}

async function upsertStaticCatalog(
  client: PoolClient,
  feed: FeedConfig,
  parsed: ParsedStaticFeed,
  runId?: string,
) {
  if (!parsed.catalog.length) return 0;

  // ── 1. CPOs (deduplicated, one bulk upsert) ───────────────────────────────
  if (runId) {
    await updateRunProgress(runId, {
      stage: "writing_cpos",
      detail: "Betreiber werden gespeichert",
      processedCount: 0,
      totalCount: parsed.catalog.length,
    }, client);
  }
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
  if (runId) {
    await updateRunProgress(runId, {
      stage: "writing_stations",
      detail: `${parsed.catalog.length} Stationen werden gespeichert`,
      processedCount: 0,
      totalCount: parsed.catalog.length,
    }, client);
  }
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
  if (runId) {
    await updateRunProgress(runId, {
      stage: "preparing_charge_points",
      detail: "Ladepunkte werden vorbereitet",
      processedCount: stationIdMap.size,
      totalCount: parsed.catalog.length,
    }, client);
  }
  type FlatCp = { stationCode: string; stationId: string; code: string; currentType: string; maxPowerKw: number | null; connectors: typeof parsed.catalog[0]["chargePoints"][0]["connectors"]; tariffs: typeof parsed.catalog[0]["chargePoints"][0]["tariffs"] };
  let allCps: FlatCp[] = [];
  for (const station of c) {
    const stationId = stationIdMap.get(station.stationCode);
    if (!stationId) continue;
    for (const cp of station.chargePoints) {
      allCps.push({ stationCode: station.stationCode, stationId, code: cp.chargePointCode, currentType: cp.currentType, maxPowerKw: cp.maxPowerKw ?? null, connectors: cp.connectors, tariffs: cp.tariffs });
    }
  }
  allCps = Array.from(
    allCps
      .reduce<Map<string, FlatCp>>((acc, cp) => {
        const current = acc.get(cp.code);
        acc.set(
          cp.code,
          current
            ? {
                ...current,
                maxPowerKw: Math.max(current.maxPowerKw ?? 0, cp.maxPowerKw ?? 0),
                connectors: Array.from(
                  new Map(
                    [...current.connectors, ...cp.connectors].map((connector) => [
                      `${connector.connectorType}|${connector.maxPowerKw ?? ""}`,
                      connector,
                    ]),
                  ).values(),
                ),
                tariffs: Array.from(
                  new Map([...current.tariffs, ...cp.tariffs].map((tariff) => [tariff.id, tariff])).values(),
                ),
              }
            : cp,
        );
        return acc;
      }, new Map())
      .values(),
  );

  if (runId) {
    await updateRunProgress(runId, {
      stage: "writing_charge_points",
      detail: `${allCps.length} Ladepunkte werden gespeichert`,
      processedCount: stationIdMap.size,
      totalCount: parsed.catalog.length,
    }, client);
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
  if (runId) {
    await updateRunProgress(runId, {
      stage: "writing_connectors",
      detail: "Stecker werden gespeichert",
      processedCount: stationIdMap.size,
      totalCount: parsed.catalog.length,
    }, client);
  }
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
  if (runId) {
    await updateRunProgress(runId, {
      stage: "preparing_tariffs",
      detail: "Tarife werden vorbereitet",
      processedCount: stationIdMap.size,
      totalCount: parsed.catalog.length,
    }, client);
  }
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
    if (runId) {
      await updateRunProgress(runId, {
        stage: "writing_tariffs",
        detail: `${uniqueTariffRows.length} Tarife werden gespeichert`,
        processedCount: stationIdMap.size,
        totalCount: parsed.catalog.length,
      }, client);
    }
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
  if (runId) {
    await updateRunProgress(runId, {
      stage: "cleanup_stale_rows",
      detail: "Veraltete Datensätze werden entfernt",
      processedCount: stationIdMap.size,
      totalCount: parsed.catalog.length,
    }, client);
  }
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
  // Remove stale stations for both the configured feed CPO and the parsed CPOs.
  // Some aggregator feeds normalize a shared upstream operator code into
  // per-operator IDs (for example DE*ISE:hash), so include the legacy base code too.
  const staleCpoIds = [
    ...new Set(
      [
        feed.cpoId,
        ...cpoMap.keys(),
        ...[...cpoMap.keys()]
          .map((id) => id.includes(":") ? id.split(":")[0] : null)
          .filter((id): id is string => Boolean(id)),
      ].filter((id): id is string => Boolean(id)),
    ),
  ];
  if (staleCpoIds.length && stationIdMap.size) {
    await client.query(
      `delete from stations where cpo_id = any($1::text[]) and not (station_code = any($2::text[]))`,
      [staleCpoIds, c.map((s) => s.stationCode)],
    );
  }

  if (stationIdsByCode.length) {
    if (runId) {
      await updateRunProgress(runId, {
        stage: "aggregating_status",
        detail: `${stationIdsByCode.length} Stationsstatus werden aggregiert`,
        processedCount: 0,
        totalCount: stationIdsByCode.length,
      }, client);
    }
    await aggregateStationStatuses(client, stationIdsByCode, null);
    if (runId) {
      await updateRunProgress(runId, {
        stage: "aggregating_status",
        detail: `${stationIdsByCode.length}/${stationIdsByCode.length} Stationsstatus aggregiert`,
        processedCount: stationIdsByCode.length,
        totalCount: stationIdsByCode.length,
      }, client);
    }
  }

  return parsed.catalog.length;
}

async function aggregateStationStatuses(
  client: PoolClient,
  stationIds: string[],
  touchedAt: string | null,
) {
  if (!stationIds.length) {
    return;
  }

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
        where station_id = any($1::uuid[])
        group by station_id
      )
      update stations s
         set available_count = c.available_count,
             occupied_count = c.occupied_count,
             out_of_service_count = c.out_of_service_count,
             unknown_count = c.unknown_count,
             last_status_update_at = coalesce($2::timestamptz, c.max_status_update_at, s.last_status_update_at),
             updated_at = now()
        from status_counts c
       where s.id = c.station_id`,
    [stationIds, touchedAt],
  );
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
  runId?: string,
) {
  const touchedStations = new Set<string>();
  let deltaCount = 0;
  const nowIso = new Date().toISOString();

  const uniqueChargePointCodes = [...new Set(updates.map((update) => update.chargePointId))];
  const chargePointResult = uniqueChargePointCodes.length
    ? await client.query<{
      id: string;
      charge_point_code: string;
      station_id: string;
    }>(
      `select id::text, charge_point_code, station_id::text
         from charge_points
        where charge_point_code = any($1::text[])`,
      [uniqueChargePointCodes],
    )
    : { rows: [] };
  const chargePointByCode = new Map(
    chargePointResult.rows.map((row) => [row.charge_point_code, row]),
  );

  if (runId) {
    await updateRunProgress(runId, {
      stage: "applying_updates",
      detail: `${updates.length} Dynamic-Updates werden abgeglichen`,
      processedCount: 0,
      totalCount: updates.length,
      message: "Dynamic-Updates werden geschrieben",
    }, client);
  }

  if (feed.ingestStatus) {
    const snapshotRows: Array<{
      chargePointId: string;
      statusRaw: string;
      statusCanonical: string;
      updateTime: string;
    }> = [];
    const latestStatusByChargePoint = new Map<string, {
      chargePointId: string;
      statusRaw: string;
      statusCanonical: string;
      updateTime: string;
      updateTimeMs: number;
    }>();

    for (const update of updates) {
      const chargePoint = chargePointByCode.get(update.chargePointId);
      if (!chargePoint) {
        continue;
      }

      const updateTime = update.lastUpdatedAt ?? nowIso;
      const updateTimeMs = Date.parse(updateTime) || 0;
      snapshotRows.push({
        chargePointId: chargePoint.id,
        statusRaw: update.statusRaw,
        statusCanonical: update.statusCanonical,
        updateTime,
      });
      touchedStations.add(chargePoint.station_id);
      deltaCount += 1;

      const current = latestStatusByChargePoint.get(chargePoint.id);
      if (!current || updateTimeMs >= current.updateTimeMs) {
        latestStatusByChargePoint.set(chargePoint.id, {
          chargePointId: chargePoint.id,
          statusRaw: update.statusRaw,
          statusCanonical: update.statusCanonical,
          updateTime,
          updateTimeMs,
        });
      }
    }

    if (snapshotRows.length) {
      const latestStatusRows = [...latestStatusByChargePoint.values()];
      await client.query(
        `with incoming as (
           select *
             from unnest(
               $1::uuid[],
               $2::text[],
               $3::text[],
               $4::timestamptz[]
             ) as t(charge_point_id, status_raw, status_canonical, update_time)
         )
         update charge_points cp
            set last_status_raw = incoming.status_raw,
                last_status_canonical = incoming.status_canonical,
                last_status_update_at = incoming.update_time
           from incoming
          where cp.id = incoming.charge_point_id`,
        [
          latestStatusRows.map((row) => row.chargePointId),
          latestStatusRows.map((row) => row.statusRaw),
          latestStatusRows.map((row) => row.statusCanonical),
          latestStatusRows.map((row) => row.updateTime),
        ],
      );
      await client.query(
        `insert into availability_snapshots (
            charge_point_id,
            recorded_at,
            status_raw,
            status_canonical
          )
         select *
           from unnest(
             $1::uuid[],
             $2::timestamptz[],
             $3::text[],
             $4::text[]
           ) as t(charge_point_id, recorded_at, status_raw, status_canonical)`,
        [
          snapshotRows.map((row) => row.chargePointId),
          snapshotRows.map((row) => row.updateTime),
          snapshotRows.map((row) => row.statusRaw),
          snapshotRows.map((row) => row.statusCanonical),
        ],
      );
    }

    if (runId) {
      await updateRunProgress(runId, {
        stage: "applying_updates",
        detail: `${snapshotRows.length}/${updates.length} Status-Updates geschrieben`,
        processedCount: snapshotRows.length,
        totalCount: updates.length,
        message: "Status-Updates geschrieben",
      }, client);
    }
  }

  if (feed.ingestPrices) {
    const tariffRowsByKey = new Map<string, {
      row: TariffShapeRow;
      updateTime: string;
      updateTimeMs: number;
    }>();

    for (const update of updates) {
      const chargePoint = chargePointByCode.get(update.chargePointId);
      if (!chargePoint) {
        continue;
      }

      const updateTime = update.lastUpdatedAt ?? nowIso;
      const updateTimeMs = Date.parse(updateTime) || 0;

      for (const tariff of update.tariffs) {
        const row: TariffShapeRow = {
          stationId: chargePoint.station_id,
          cpId: chargePoint.id,
          code: tariff.id,
          externalCode: tariff.externalCode,
          scope: tariff.scope,
          label: tariff.label ?? "",
          currency: tariff.currency ?? "EUR",
          isComplete: tariff.isComplete ?? false,
          tariff,
        };
        const current = tariffRowsByKey.get(row.code);
        tariffRowsByKey.set(row.code, {
          row: current ? mergeTariffShapes(current.row, row) : row,
          updateTime: !current || updateTimeMs >= current.updateTimeMs ? updateTime : current.updateTime,
          updateTimeMs: Math.max(current?.updateTimeMs ?? 0, updateTimeMs),
        });
      }
    }

    const tariffRows = [...tariffRowsByKey.values()];
    if (runId) {
      await updateRunProgress(runId, {
        stage: "applying_prices",
        detail: `${tariffRows.length} eindeutige Tarife werden geprüft`,
        processedCount: 0,
        totalCount: tariffRows.length,
        message: "Preis-Updates werden geprüft",
      }, client);
    }

    if (tariffRows.length) {
      const currentFingerprints = await loadCurrentTariffFingerprints(
        client,
        tariffRows.map((entry) => entry.row.code),
      );
      const changedTariffRows = tariffRows.filter(
        (entry) =>
          currentFingerprints.get(entry.row.code) !== tariffStorageFingerprint(entry.row),
      );
      const tariffResult = await client.query<{ tariff_key: string; id: string }>(
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
          )
         select t.sid::uuid, t.cpid::uuid, t.tkey, t.tcode, t.tscope, t.label, t.currency, t.complete, now()
           from unnest(
             $1::text[],
             $2::text[],
             $3::text[],
             $4::text[],
             $5::text[],
             $6::text[],
             $7::text[],
             $8::bool[]
           ) as t(sid, cpid, tkey, tcode, tscope, label, currency, complete)
         on conflict (tariff_key) do update
           set station_id = excluded.station_id,
               charge_point_id = excluded.charge_point_id,
               tariff_code = excluded.tariff_code,
               tariff_scope = excluded.tariff_scope,
               label = excluded.label,
               currency = excluded.currency,
               is_complete = excluded.is_complete,
               updated_at = now()
         returning tariff_key, id::text`,
        [
          tariffRows.map((entry) => entry.row.stationId),
          tariffRows.map((entry) => entry.row.cpId),
          tariffRows.map((entry) => entry.row.code),
          tariffRows.map((entry) => entry.row.externalCode),
          tariffRows.map((entry) => entry.row.scope),
          tariffRows.map((entry) => entry.row.label),
          tariffRows.map((entry) => entry.row.currency),
          tariffRows.map((entry) => entry.row.isComplete),
        ],
      );
      const tariffIdByKey = new Map(tariffResult.rows.map((row) => [row.tariff_key, row.id]));
      const tariffIds = [...tariffIdByKey.values()];

      await client.query(`delete from tariff_components where tariff_id = any($1::uuid[])`, [tariffIds]);
      await client.query(`delete from tariff_payment_methods where tariff_id = any($1::uuid[])`, [tariffIds]);
      await client.query(`delete from tariff_brands_accepted where tariff_id = any($1::uuid[])`, [tariffIds]);

      const componentRows = tariffRows.flatMap((entry) => {
        const tariffId = tariffIdByKey.get(entry.row.code);
        if (!tariffId) return [];
        return [
          ...entry.row.tariff.components.map((component) => ({
            tariffId,
            componentType: component.componentType,
            amount: component.amount,
            startsAfterMinutes: component.startsAfterMinutes,
            priceCap: component.priceCap,
            taxIncluded: component.taxIncluded,
            taxRate: component.taxRate,
            overallPeriod: component.overallPeriod ? JSON.stringify(component.overallPeriod) : null,
            timeBasedApplicability: component.timeBasedApplicability ? JSON.stringify(component.timeBasedApplicability) : null,
            energyBasedApplicability: component.energyBasedApplicability ? JSON.stringify(component.energyBasedApplicability) : null,
          })),
          ...entry.row.tariff.caps.map((cap) => ({
            tariffId,
            componentType: "cap",
            amount: null,
            startsAfterMinutes: null,
            priceCap: cap.amount,
            taxIncluded: null,
            taxRate: null,
            overallPeriod: null,
            timeBasedApplicability: null,
            energyBasedApplicability: null,
          })),
        ];
      });
      const paymentRows = tariffRows.flatMap((entry) => {
        const tariffId = tariffIdByKey.get(entry.row.code);
        return tariffId ? entry.row.tariff.paymentMethods.map((method) => ({ tariffId, method })) : [];
      });
      const brandRows = tariffRows.flatMap((entry) => {
        const tariffId = tariffIdByKey.get(entry.row.code);
        return tariffId ? entry.row.tariff.brandsAccepted.map((brand) => ({ tariffId, brand })) : [];
      });

      if (componentRows.length) {
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
            )
           select t.tid::uuid, t.ctype, t.amount, t.starts_after_minutes, t.price_cap,
                  t.tax_included, t.tax_rate, t.overall_period::jsonb,
                  t.time_based_applicability::jsonb, t.energy_based_applicability::jsonb
             from unnest(
               $1::text[],
               $2::text[],
               $3::float8[],
               $4::int[],
               $5::float8[],
               $6::bool[],
               $7::float8[],
               $8::text[],
               $9::text[],
               $10::text[]
             ) as t(
               tid, ctype, amount, starts_after_minutes, price_cap, tax_included,
               tax_rate, overall_period, time_based_applicability, energy_based_applicability
             )`,
          [
            componentRows.map((row) => row.tariffId),
            componentRows.map((row) => row.componentType),
            componentRows.map((row) => row.amount),
            componentRows.map((row) => row.startsAfterMinutes),
            componentRows.map((row) => row.priceCap),
            componentRows.map((row) => row.taxIncluded),
            componentRows.map((row) => row.taxRate),
            componentRows.map((row) => row.overallPeriod),
            componentRows.map((row) => row.timeBasedApplicability),
            componentRows.map((row) => row.energyBasedApplicability),
          ],
        );
      }
      if (paymentRows.length) {
        await client.query(
          `insert into tariff_payment_methods (tariff_id, payment_method)
           select t.tid::uuid, t.method
             from unnest($1::text[], $2::text[]) as t(tid, method)
           on conflict do nothing`,
          [paymentRows.map((row) => row.tariffId), paymentRows.map((row) => row.method)],
        );
      }
      if (brandRows.length) {
        await client.query(
          `insert into tariff_brands_accepted (tariff_id, brand)
           select t.tid::uuid, t.brand
             from unnest($1::text[], $2::text[]) as t(tid, brand)
           on conflict do nothing`,
          [brandRows.map((row) => row.tariffId), brandRows.map((row) => row.brand)],
        );
      }

      const changedSnapshotRows = changedTariffRows
        .map((entry) => ({
          tariffId: tariffIdByKey.get(entry.row.code),
          stationId: entry.row.stationId,
          updateTime: entry.updateTime,
          summary: summarizeTariff(entry.row.tariff),
        }))
        .filter((entry): entry is {
          tariffId: string;
          stationId: string;
          updateTime: string;
          summary: string;
        } => Boolean(entry.tariffId));

      if (changedSnapshotRows.length) {
        await client.query(
          `insert into price_snapshots (
              tariff_id,
              recorded_at,
              summary
            )
           select t.tid::uuid, t.recorded_at::timestamptz, t.summary::jsonb
             from unnest($1::text[], $2::text[], $3::text[]) as t(tid, recorded_at, summary)`,
          [
            changedSnapshotRows.map((row) => row.tariffId),
            changedSnapshotRows.map((row) => row.updateTime),
            changedSnapshotRows.map((row) => row.summary),
          ],
        );

        const latestPriceByStation = new Map<string, string>();
        for (const row of changedSnapshotRows) {
          const current = latestPriceByStation.get(row.stationId);
          if (!current || (Date.parse(row.updateTime) || 0) >= (Date.parse(current) || 0)) {
            latestPriceByStation.set(row.stationId, row.updateTime);
          }
          touchedStations.add(row.stationId);
        }
        const stationPriceRows = [...latestPriceByStation.entries()];
        await client.query(
          `update stations s
              set last_price_update_at = t.updated_at::timestamptz,
                  updated_at = now()
             from unnest($1::text[], $2::text[]) as t(station_id, updated_at)
            where s.id = t.station_id::uuid`,
          [
            stationPriceRows.map((row) => row[0]),
            stationPriceRows.map((row) => row[1]),
          ],
        );
        deltaCount += changedSnapshotRows.length;
      }
    }

    if (runId) {
      await updateRunProgress(runId, {
        stage: "applying_prices",
        detail: `${tariffRows.length}/${tariffRows.length} Tarife geprüft`,
        processedCount: tariffRows.length,
        totalCount: tariffRows.length,
        message: "Preis-Updates geprüft",
      }, client);
    }
  }

  if (touchedStations.size) {
    if (runId) {
      await updateRunProgress(runId, {
        stage: "aggregating_status",
        detail: `${touchedStations.size} Stationsstatus werden aggregiert`,
        processedCount: 0,
        totalCount: touchedStations.size,
        message: "Stationsstatus werden aggregiert",
      }, client);
    }
    await aggregateStationStatuses(client, [...touchedStations], nowIso);
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

async function markFeedNoopSuccess(client: PoolClient, feed: FeedConfig) {
  await updateFeedConfigDb(
    feed.id,
    {
      ...feed,
      lastSuccessAt: new Date().toISOString(),
      lastErrorMessage: null,
      consecutiveFailures: 0,
      errorRate: 0,
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
const FEED_CYCLE_CONCURRENCY = Math.max(
  1,
  Number(process.env.FEED_CYCLE_CONCURRENCY ?? 1),
);
const FEED_CYCLE_QUEUE_LIMIT = Math.max(
  1,
  Number(process.env.FEED_CYCLE_QUEUE_LIMIT ?? FEED_CYCLE_CONCURRENCY),
);

function abortMessage(signal?: AbortSignal) {
  const reason = signal?.reason;
  if (reason instanceof Error) {
    return reason.message;
  }
  if (typeof reason === "string") {
    return reason;
  }
  return "Feed-Verarbeitung wurde abgebrochen";
}

function throwIfAborted(signal?: AbortSignal) {
  if (signal?.aborted) {
    throw new Error(abortMessage(signal));
  }
}

async function runFeedActionWithTimeout(
  feed: FeedConfig,
  kind: FeedAction,
  queuedRunId?: string,
) {
  const controller = new AbortController();
  const timer = setTimeout(() => {
    controller.abort(new Error(`Timeout nach ${FEED_RUN_TIMEOUT_MS}ms: ${feed.name}`));
  }, FEED_RUN_TIMEOUT_MS);

  try {
    return await runFeedAction(feed.id, kind, {
      queuedRunId,
      signal: controller.signal,
    });
  } finally {
    clearTimeout(timer);
  }
}

async function runWithConcurrency<T, R>(
  items: T[],
  concurrency: number,
  worker: (item: T, index: number) => Promise<R>,
): Promise<PromiseSettledResult<R>[]> {
  const results = new Array<PromiseSettledResult<R>>(items.length);
  let nextIndex = 0;

  async function runWorker() {
    while (nextIndex < items.length) {
      const index = nextIndex;
      nextIndex += 1;

      try {
        results[index] = {
          status: "fulfilled",
          value: await worker(items[index]!, index),
        };
      } catch (error) {
        results[index] = {
          status: "rejected",
          reason: error,
        };
      }
    }
  }

  await Promise.all(
    Array.from({ length: Math.min(concurrency, items.length) }, () => runWorker()),
  );

  return results;
}

export async function runFeedAction(
  feedId: string,
  action: FeedAction,
  options?: {
    payload?: string;
    dryRun?: boolean;
    queuedRunId?: string;
    signal?: AbortSignal;
  },
) {
  const feed = await getFeedConfigDb(feedId);
  if (!feed) {
    throw new Error("Feed not found");
  }

  throwIfAborted(options?.signal);

  const claim = options?.queuedRunId
    ? {
        claimed: true as const,
        run: await promoteQueuedRun(options.queuedRunId, "Feed-Sync gestartet"),
      }
    : await claimFeedRun(
        feed.id,
        action,
        options?.dryRun ? "Feed-Test gestartet" : "Feed-Sync gestartet",
      );

  if (!claim.run) {
    const active = await loadRunningRun(feed.id);
    if (active) {
      return active;
    }
    throw new Error("Sync run could not be claimed");
  }

  if (!claim.claimed) {
    if (action === "webhook") {
      throw new Error("Feed wird bereits verarbeitet");
    }
    return claim.run;
  }

  const runId = claim.run.id;

  try {
    let deltaCount = 0;
    let message = "Keine Änderungen";
    let cursorState = feed.cursorState ?? null;
    let lastSnapshotAt = feed.lastSnapshotAt;
    let noRemoteWork = false;
    let payloadToRecord: string | null = null;
    let parsedStatic: ParsedStaticFeed | null = null;
    let parsedDynamic: ReturnType<typeof parseDynamicMobilithekPayload> | null = null;

    if (feed.type === "static") {
      await updateRunProgress(runId, {
        stage: "downloading",
        detail: "Static-Payload wird von Mobilithek geladen",
        message: "Mobilithek-Download gestartet",
      });
      payloadToRecord = options?.payload ?? (await fetchStaticMobilithekPayload(feed, options?.signal));
      if (!payloadToRecord) {
        noRemoteWork = true;
        message = "Keine Static-Daten verfügbar (204 No Content)";
        await updateRunProgress(runId, {
          stage: "not_modified",
          detail: message,
          message,
        });
      } else {
      const payloadSizeBytes = Buffer.byteLength(payloadToRecord, "utf8");
      await updateRunProgress(runId, {
        stage: "downloaded",
        detail: `${Math.round(payloadSizeBytes / 1024 / 1024)} MB geladen`,
        payloadSizeBytes,
        message: "Mobilithek-Download abgeschlossen",
      });
      throwIfAborted(options?.signal);
      await updateRunProgress(runId, {
        stage: "parsing",
        detail: "Static-Payload wird geparst",
        message: "Payload wird geparst",
        payloadSizeBytes,
      });
      parsedStatic = dedupeStaticCatalog(parseStaticMobilithekPayload(payloadToRecord));
      throwIfAborted(options?.signal);
      deltaCount = parsedStatic.catalog.length;
      message = `${parsedStatic.catalog.length} Stationen verarbeitet`;
      await updateRunProgress(runId, {
        stage: "parsed",
        detail: `${parsedStatic.catalog.length} Stationen erkannt`,
        processedCount: 0,
        totalCount: parsedStatic.catalog.length,
        payloadSizeBytes,
        message: `${parsedStatic.catalog.length} Stationen erkannt`,
      });
      }
    } else if (feed.mode === "push" && !options?.payload && !feed.reconciliationIntervalMinutes) {
      noRemoteWork = true;
      message = "Push-only Dynamic-Feed: kein Pull-Endpunkt, wartet auf Mobilithek-Webhook";
      await updateRunProgress(runId, {
        stage: "noop",
        detail: message,
        message,
      });
    } else {
      await updateRunProgress(runId, {
        stage: options?.payload ? "received_webhook" : "downloading",
        detail: options?.payload ? "Webhook-Payload wird verarbeitet" : "Dynamic-Payload wird von Mobilithek geladen",
        message: options?.payload ? "Webhook wird verarbeitet" : "Mobilithek-Download gestartet",
      });
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
            options?.signal,
          );

      if (!dynamic) {
        message = "Keine Änderungen seit dem letzten Pull";
        await updateRunProgress(runId, {
          stage: "not_modified",
          detail: message,
          message,
        });
      } else {
        payloadToRecord = dynamic.payload;
        const payloadSizeBytes = Buffer.byteLength(dynamic.payload, "utf8");
        await updateRunProgress(runId, {
          stage: "downloaded",
          detail: `${payloadSizeBytes} Bytes geladen`,
          payloadSizeBytes,
          message: "Payload empfangen",
        });
        throwIfAborted(options?.signal);
        await updateRunProgress(runId, {
          stage: "parsing",
          detail: "Dynamic-Payload wird geparst",
          payloadSizeBytes,
          message: "Payload wird geparst",
        });
        parsedDynamic = parseDynamicMobilithekPayload(dynamic.payload);
        throwIfAborted(options?.signal);
        deltaCount = parsedDynamic.updates.length;
        message = `${parsedDynamic.updates.length} Delta-Updates verarbeitet`;
        await updateRunProgress(runId, {
          stage: "parsed",
          detail: `${parsedDynamic.updates.length} Delta-Updates erkannt`,
          payloadSizeBytes,
          processedCount: 0,
          totalCount: parsedDynamic.updates.length,
          message: `${parsedDynamic.updates.length} Delta-Updates erkannt`,
        });
        cursorState = {
          ...(feed.cursorState ?? {}),
          lastModified: dynamic.lastModified,
          lastWebhookAt: action === "webhook" ? new Date().toISOString() : feed.cursorState?.lastWebhookAt,
        };
      }
    }

    const client = await getPool().connect();
    try {
      await client.query("BEGIN");
      await configureIngestTransaction(client);
      await assertRunStillRunning(client, runId);
      throwIfAborted(options?.signal);

      if (payloadToRecord) {
        await updateRunProgress(runId, {
          stage: "recording_payload",
          detail: "Raw-Payload wird gespeichert",
          message: "Raw-Payload wird gespeichert",
        }, client);
        await recordPayload(client, {
          runId,
          feedId: feed.id,
          payloadKind: payloadKindFor(feed, action),
          payload: payloadToRecord,
        });
      }

      if (!options?.dryRun && parsedStatic) {
        await assertRunStillRunning(client, runId);
        await upsertStaticCatalog(client, feed, parsedStatic, runId);
        lastSnapshotAt = new Date().toISOString();
      }

      if (!options?.dryRun && parsedDynamic) {
        await assertRunStillRunning(client, runId);
        await updateRunProgress(runId, {
          stage: "applying_updates",
          detail: `${parsedDynamic.updates.length} Dynamic-Updates werden vorbereitet`,
          processedCount: 0,
          totalCount: parsedDynamic.updates.length,
          message: "Dynamic-Updates werden geschrieben",
        }, client);
        deltaCount = await applyDynamicUpdates(client, feed, parsedDynamic.updates, runId);
      }

      if (!options?.dryRun) {
        await assertRunStillRunning(client, runId);
        await updateRunProgress(runId, {
          stage: "finalizing",
          detail: "Feed-Metadaten werden aktualisiert",
          message: "Feed-Metadaten werden aktualisiert",
        }, client);
        if (noRemoteWork) {
          await markFeedNoopSuccess(client, feed);
        } else {
          await markFeedSuccess(client, feed, {
            lastSnapshotAt,
            lastDeltaCount: deltaCount,
            cursorState,
          });
        }
      }

      await finishRun(client, runId, {
        status: "success",
        message,
        deltaCount,
      });

      const run = await loadRun(client, runId);
      await client.query("COMMIT");
      return run;
    } catch (error) {
      await client.query("ROLLBACK").catch(() => undefined);
      throw error;
    } finally {
      client.release();
    }
  } catch (error) {
    const message = errorMessage(error);
    const client = await getPool().connect();
    try {
      await client.query("BEGIN");
      await markFeedFailure(client, feed, message);
      await finishRun(client, runId, {
        status: "failed",
        message,
        deltaCount: 0,
      });
      await client.query("COMMIT");
    } catch (recordError) {
      await client.query("ROLLBACK").catch(() => undefined);
      console.error(
        `[ingest] failed to persist failure state for ${feed.id}:`,
        errorMessage(recordError),
      );
    } finally {
      client.release();
    }
    throw error;
  }
}

export async function runDueFeedCycle() {
  // No cycle-wide mutex: per-feed claims (`claimFeedRun`) already guarantee
  // that the same feed is never processed by two cycles at once. A session-
  // level advisory lock here would leak under Supavisor transaction-pooling
  // and pin a pool slot for the whole cycle, starving inner queries and
  // producing "timeout exceeded when trying to connect".
  return await runDueFeedCycleLocked();
}

async function runDueFeedCycleLocked() {
  // Clean up sync_runs stuck in "running" from prior Lambda timeouts or crashes.
  const cleaned = await cleanupStuckSyncRunsDb().catch((error) => {
    console.error("[ingest] cleanupStuckSyncRuns failed:", errorMessage(error));
    return 0;
  });
  if (cleaned) {
    console.log(`[ingest] cleaned up ${cleaned} stuck sync run(s)`);
  }

  if (process.env.INGEST_HISTORY_CLEANUP !== "0") {
    const historyCleanup = await cleanupIngestHistoryDb().catch((error) => {
      console.error("[ingest] cleanupIngestHistory failed:", errorMessage(error));
      return null;
    });
    if (
      historyCleanup &&
      (historyCleanup.rawPayloads ||
        historyCleanup.availabilitySnapshots ||
        historyCleanup.priceSnapshots)
    ) {
      console.log("[ingest] cleaned up ingest history", historyCleanup);
    }
  }

  let feeds: FeedConfig[];
  try {
    feeds = await listFeedConfigsDb();
  } catch (error) {
    console.error("[ingest] listFeedConfigsDb failed:", errorMessage(error));
    return 0;
  }

  const queuedRuns = await loadQueuedRuns(FEED_CYCLE_QUEUE_LIMIT).catch((error) => {
    console.error("[ingest] loadQueuedRuns failed:", errorMessage(error));
    return [] as SyncRun[];
  });
  const latestRunByFeed = await loadLatestRunsByFeed().catch((error) => {
    console.error("[ingest] loadLatestRunsByFeed failed:", errorMessage(error));
    return new Map<string, SyncRun>();
  });
  const feedById = new Map(feeds.map((feed) => [feed.id, feed]));
  const queuedFeedIds = new Set(queuedRuns.map((run) => run.feedId));
  const dueFeeds = feeds.filter((feed: FeedConfig) =>
    !queuedFeedIds.has(feed.id) && shouldRunFeed(feed, latestRunByFeed.get(feed.id))
  );

  if (!queuedRuns.length && !dueFeeds.length) {
    return 0;
  }

  const queuedResults = await runWithConcurrency(
    queuedRuns,
    FEED_CYCLE_CONCURRENCY,
    async (run) => {
      const feed = feedById.get(run.feedId);
      if (!feed) {
        throw new Error(`Feed not found for queued run ${run.id}`);
      }

      return runFeedActionWithTimeout(feed, run.kind as FeedAction, run.id);
    },
  );

  queuedResults.forEach((result, index) => {
    if (result.status === "rejected") {
      const run = queuedRuns[index]!;
      const feedName = feedById.get(run.feedId)?.name ?? run.feedId;
      console.error(`[ingest] queued ${feedName} failed:`, errorMessage(result.reason));
    }
  });

  if (queuedRuns.length) {
    return queuedRuns.length;
  }

  // Bounded parallelism: one slow feed must not starve the rest, but a large
  // backlog should also not open 100 upstream requests and DB transactions.
  const results = await runWithConcurrency(
    dueFeeds,
    FEED_CYCLE_CONCURRENCY,
    async (feed) => {
      const kind: FeedAction =
        feed.type === "dynamic" && feed.mode !== "pull" ? "reconciliation" : "manual";
      return runFeedActionWithTimeout(feed, kind);
    },
  );

  results.forEach((result, index) => {
    if (result.status === "rejected") {
      console.error(
        `[ingest] ${dueFeeds[index]!.name} failed:`,
        errorMessage(result.reason),
      );
    }
  });

  return queuedRuns.length + dueFeeds.length;
}

export async function processFeedWebhook(feedId: string, payload: string, incomingSecret?: string | null) {
  const feed = await getFeedConfigDb(feedId);
  if (!feed) {
    throw new Error("Feed not found");
  }

  const expectedSecret = resolveSecretRef(feed.webhookSecretRef);
  if (expectedSecret) {
    if (!incomingSecret || !timingSafeEqualStrings(incomingSecret, expectedSecret)) {
      throw new Error("Invalid webhook secret");
    }
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
