import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { feedConfigSchema, syncRunSchema, webhookDeliverySchema, type FeedConfig, type SyncRun, type WebhookDelivery } from "../domain/types";
import { DEMO_FEEDS, DEMO_SYNC_RUNS } from "../fixtures/demo-feeds";

type StoreShape = {
  feeds: FeedConfig[];
  syncRuns: SyncRun[];
  webhookDeliveries: WebhookDelivery[];
};

function workspaceRoot() {
  let current = process.cwd();

  while (current !== dirname(current)) {
    if (existsSync(join(current, "pnpm-workspace.yaml"))) {
      return current;
    }
    current = dirname(current);
  }

  return process.cwd();
}

function storePath() {
  return join(workspaceRoot(), "data", "admin-store.json");
}

function defaultStore(): StoreShape {
  return {
    feeds: DEMO_FEEDS,
    syncRuns: DEMO_SYNC_RUNS,
    webhookDeliveries: [],
  };
}

function ensureStore() {
  const target = storePath();
  mkdirSync(dirname(target), { recursive: true });

  if (!existsSync(target)) {
    writeFileSync(target, JSON.stringify(defaultStore(), null, 2));
  }
}

function readStore(): StoreShape {
  ensureStore();
  const parsed = JSON.parse(readFileSync(storePath(), "utf8")) as StoreShape;
  return {
    feeds: parsed.feeds.map((item) =>
      feedConfigSchema.parse({
        ...item,
        source: item.source ?? "mobilithek",
        cpoId: item.cpoId ?? null,
        ingestCatalog: item.ingestCatalog ?? item.type === "static",
        ingestPrices: item.ingestPrices ?? true,
        ingestStatus: item.ingestStatus ?? item.type === "dynamic",
        credentialRef: item.credentialRef ?? null,
        webhookSecretRef: item.webhookSecretRef ?? null,
        cursorState: item.cursorState ?? null,
        lastErrorMessage: item.lastErrorMessage ?? null,
        consecutiveFailures: item.consecutiveFailures ?? 0,
      }),
    ),
    syncRuns: parsed.syncRuns.map((item) => syncRunSchema.parse(item)),
    webhookDeliveries: parsed.webhookDeliveries.map((item) => webhookDeliverySchema.parse(item)),
  };
}

function writeStore(store: StoreShape) {
  writeFileSync(storePath(), JSON.stringify(store, null, 2));
}

export function listFeedConfigs() {
  return readStore().feeds;
}

export function listSyncRuns() {
  return readStore().syncRuns.sort((left, right) => right.startedAt.localeCompare(left.startedAt));
}

export function createFeedConfig(
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
  const store = readStore();
  const next = feedConfigSchema.parse({
    ...input,
    id: `${input.name.toLowerCase().replace(/[^a-z0-9]+/g, "-")}-${Date.now()}`,
    lastSuccessAt: null,
    lastSnapshotAt: null,
    lastDeltaCount: 0,
    errorRate: 0,
    cursorState: null,
    lastErrorMessage: null,
    consecutiveFailures: 0,
  });
  store.feeds.unshift(next);
  writeStore(store);
  return next;
}

export function updateFeedConfig(id: string, patch: Partial<FeedConfig>) {
  const store = readStore();
  const index = store.feeds.findIndex((feed) => feed.id === id);

  if (index === -1) {
    return null;
  }

  const normalizedPatch = Object.fromEntries(
    Object.entries(patch).filter(([, value]) => value !== undefined),
  );

  const updated = feedConfigSchema.parse({
    ...store.feeds[index],
    ...normalizedPatch,
    id,
  });
  store.feeds[index] = updated;
  writeStore(store);
  return updated;
}

export function deleteFeedConfig(id: string) {
  const store = readStore();
  const nextFeeds = store.feeds.filter((feed) => feed.id !== id);

  if (nextFeeds.length === store.feeds.length) {
    return false;
  }

  writeStore({
    ...store,
    feeds: nextFeeds,
  });
  return true;
}

export function appendSyncRun(input: Omit<SyncRun, "id">) {
  const store = readStore();
  const syncRun = syncRunSchema.parse({
    ...input,
    id: `${input.feedId}-${Date.now()}`,
  });
  store.syncRuns.unshift(syncRun);
  writeStore(store);
  return syncRun;
}

export function recordWebhookDelivery(input: Omit<WebhookDelivery, "id">) {
  const store = readStore();
  const delivery = webhookDeliverySchema.parse({
    ...input,
    id: `${input.feedId}-${Date.now()}`,
  });
  store.webhookDeliveries.unshift(delivery);
  writeStore(store);
  return delivery;
}
