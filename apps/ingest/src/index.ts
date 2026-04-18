import {
  parseDynamicMobilithekPayload,
  parseStaticMobilithekPayload,
} from "@adhoc/shared";
import { runDueFeedCycle } from "@adhoc/shared/ingest";
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
        stationsParsed: staticResult.catalog.length,
        updatesParsed: dynamicResult.updates.length,
        firstStation: staticResult.catalog[0]?.name,
        firstUpdate: dynamicResult.updates[0],
      },
      null,
      2,
    ),
  );
}

async function runSync() {
  const processed = await runDueFeedCycle();
  console.log(`Processed ${processed} due feed(s).`);
}

const command = process.argv[2] ?? "demo";

if (command === "sync") {
  await runSync();
} else {
  await runDemo();
}
