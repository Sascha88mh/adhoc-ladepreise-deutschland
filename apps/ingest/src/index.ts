import {
  parseDynamicMobilithekPayload,
  parseStaticMobilithekPayload,
} from "@adhoc/shared";
import { appendSyncRun, listFeedConfigs, updateFeedConfig } from "@adhoc/shared/store";
import { existsSync, readFileSync } from "node:fs";
import { dirname, join } from "node:path";

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

function fixturePath(filename: string) {
  return join(workspaceRoot(), "db", "fixtures", filename);
}

async function runDemo() {
  const staticFixture = readFileSync(fixturePath("mobilithek-static.sample.json"), "utf8");
  const dynamicFixture = readFileSync(fixturePath("mobilithek-dynamic.sample.json"), "utf8");
  const staticResult = parseStaticMobilithekPayload(staticFixture);
  const dynamicResult = parseDynamicMobilithekPayload(dynamicFixture);

  console.log(
    JSON.stringify(
      {
        stationsParsed: staticResult.stations.length,
        updatesParsed: dynamicResult.updates.length,
        firstStation: staticResult.stations[0]?.name,
        firstUpdate: dynamicResult.updates[0],
      },
      null,
      2,
    ),
  );
}

async function runSync() {
  const feeds = listFeedConfigs().filter((feed) => feed.isActive);

  for (const feed of feeds) {
    const startedAt = new Date().toISOString();
    appendSyncRun({
      feedId: feed.id,
      kind: "manual",
      status: "running",
      startedAt,
      finishedAt: null,
      message: "Sync gestartet",
      deltaCount: 0,
    });

    updateFeedConfig(feed.id, {
      lastSuccessAt: new Date().toISOString(),
      lastDeltaCount: feed.type === "dynamic" ? 4 : 1,
    });

    appendSyncRun({
      feedId: feed.id,
      kind: "manual",
      status: "success",
      startedAt,
      finishedAt: new Date().toISOString(),
      message: `Sync für ${feed.name} simuliert`,
      deltaCount: feed.type === "dynamic" ? 4 : 1,
    });
  }

  console.log(`Synced ${feeds.length} feed(s).`);
}

const command = process.argv[2] ?? "demo";

if (command === "sync") {
  await runSync();
} else {
  await runDemo();
}
