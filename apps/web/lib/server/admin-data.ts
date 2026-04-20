import type { FeedConfig } from "@adhoc/shared";
import {
  createFeedConfigDb,
  deleteFeedConfigDb,
  listFeedConfigsDb,
  listSyncRunsDb,
  searchAdminStationsDb,
  terminateFeedRunDb,
  updateFeedConfigDb,
  upsertStationOverrideDb,
  deleteStationOverrideDb,
  usingDatabase,
} from "@adhoc/shared/db";
import { runFeedAction } from "@adhoc/shared/ingest";

function requireAdminDatabase() {
  if (!usingDatabase()) {
    throw new Error("Die Admin-Oberfläche benötigt APP_DATA_SOURCE=db und eine erreichbare Datenbank.");
  }
}

export async function listAdminFeeds() {
  requireAdminDatabase();
  return listFeedConfigsDb();
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
  requireAdminDatabase();
  return createFeedConfigDb(input);
}

export async function updateAdminFeedConfig(id: string, patch: Partial<FeedConfig>) {
  requireAdminDatabase();
  return updateFeedConfigDb(id, patch);
}

export async function deleteAdminFeedConfig(id: string) {
  requireAdminDatabase();
  return deleteFeedConfigDb(id);
}

export async function listAdminSyncRuns() {
  requireAdminDatabase();
  return listSyncRunsDb();
}

export async function terminateAdminFeedRun(id: string) {
  requireAdminDatabase();
  return terminateFeedRunDb(id);
}

export async function triggerAdminFeedAction(id: string, action: "test" | "sync") {
  requireAdminDatabase();
  const run = await runFeedAction(id, action === "test" ? "test" : "manual", {
    dryRun: action === "test",
  });

  if (!run) {
    throw new Error("Sync run could not be created");
  }

  return run;
}

export async function searchAdminStations(query: string) {
  requireAdminDatabase();
  return searchAdminStationsDb(query);
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
  requireAdminDatabase();
  return upsertStationOverrideDb(stationId, patch);
}

export async function removeStationOverride(stationId: string) {
  requireAdminDatabase();
  return deleteStationOverrideDb(stationId);
}
