import type { AdminStationRecord, FeedConfig } from "@adhoc/shared";
import { DEMO_STATIONS } from "@adhoc/shared";
import {
  appendSyncRun,
  createFeedConfig,
  deleteFeedConfig,
  listFeedConfigs,
  listSyncRuns,
  updateFeedConfig,
} from "@adhoc/shared/store";
import {
  createFeedConfigDb,
  deleteFeedConfigDb,
  listFeedConfigsDb,
  listSyncRunsDb,
  searchAdminStationsDb,
  updateFeedConfigDb,
  upsertStationOverrideDb,
  deleteStationOverrideDb,
  usingDatabase,
} from "@adhoc/shared/db";
import { runFeedAction } from "@adhoc/shared/ingest";

function demoStationMatches(station: (typeof DEMO_STATIONS)[number], query: string) {
  const needle = query.trim().toLowerCase();
  if (!needle) {
    return true;
  }

  return [
    station.name,
    station.cpoName,
    station.addressLine,
    station.city,
    station.stationId,
  ].some((value) => value.toLowerCase().includes(needle));
}

function demoStationRecord(station: (typeof DEMO_STATIONS)[number]): AdminStationRecord {
  return {
    stationId: station.stationId,
    stationCode: station.stationId,
    cpoId: station.cpoId,
    cpoName: station.cpoName,
    sourceName: station.name,
    effectiveName: station.name,
    sourceAddressLine: station.addressLine,
    effectiveAddressLine: station.addressLine,
    sourceCity: station.city,
    effectiveCity: station.city,
    sourcePostalCode: station.postalCode,
    effectivePostalCode: station.postalCode,
    sourceMaxPowerKw: station.maxPowerKw,
    effectiveMaxPowerKw: station.maxPowerKw,
    isHidden: false,
    override: null,
  };
}

export function adminDataSource() {
  return usingDatabase() ? "db" : "demo";
}

export async function listAdminFeeds() {
  return usingDatabase() ? listFeedConfigsDb() : listFeedConfigs();
}

export async function findAdminFeedBySubscriptionId(subscriptionId: string) {
  const feeds = await listAdminFeeds();
  return feeds.find((feed) => feed.subscriptionId === subscriptionId) ?? null;
}

export async function createAdminFeedConfig(
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
) {
  return usingDatabase() ? createFeedConfigDb(input) : createFeedConfig(input);
}

export async function updateAdminFeedConfig(id: string, patch: Partial<FeedConfig>) {
  return usingDatabase() ? updateFeedConfigDb(id, patch) : updateFeedConfig(id, patch);
}

export async function deleteAdminFeedConfig(id: string) {
  return usingDatabase() ? deleteFeedConfigDb(id) : deleteFeedConfig(id);
}

export async function listAdminSyncRuns() {
  return usingDatabase() ? listSyncRunsDb() : listSyncRuns();
}

export async function triggerAdminFeedAction(id: string, action: "test" | "sync") {
  if (usingDatabase()) {
    const run = await runFeedAction(id, action === "test" ? "test" : "manual", {
      dryRun: action === "test",
    });

    if (!run) {
      throw new Error("Sync run could not be created");
    }

    return run;
  }

  const timestamp = new Date().toISOString();
  const updated = updateFeedConfig(id, {
    lastSuccessAt: timestamp,
    lastSnapshotAt: action === "sync" ? timestamp : undefined,
    lastDeltaCount: action === "sync" ? 5 : 0,
    lastErrorMessage: null,
    consecutiveFailures: 0,
  });

  if (!updated) {
    throw new Error("Feed not found");
  }

  return appendSyncRun({
    feedId: id,
    kind: action === "test" ? "test" : "manual",
    status: "success",
    startedAt: timestamp,
    finishedAt: new Date().toISOString(),
    message:
      action === "test"
        ? "Verbindung und Zugangsdaten erfolgreich geprüft"
        : "Manueller Sync abgeschlossen",
    deltaCount: action === "test" ? 0 : 5,
  });
}

export async function searchAdminStations(query: string) {
  if (usingDatabase()) {
    return searchAdminStationsDb(query);
  }

  return DEMO_STATIONS.filter((station) => demoStationMatches(station, query))
    .slice(0, 25)
    .map((station) => demoStationRecord(station));
}

export async function saveStationOverride(
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
) {
  if (!usingDatabase()) {
    throw new Error("Station overrides are available only in APP_DATA_SOURCE=db mode");
  }

  return upsertStationOverrideDb(stationId, patch);
}

export async function removeStationOverride(stationId: string) {
  if (!usingDatabase()) {
    throw new Error("Station overrides are available only in APP_DATA_SOURCE=db mode");
  }

  return deleteStationOverrideDb(stationId);
}
