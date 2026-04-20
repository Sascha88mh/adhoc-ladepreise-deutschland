import { runDueFeedCycle } from "@adhoc/shared/ingest";

async function runSync() {
  const processed = await runDueFeedCycle();
  console.log(`Processed ${processed} due feed(s).`);
}

const command = process.argv[2] ?? "sync";

if (command === "sync") {
  await runSync();
} else {
  throw new Error(`Unknown ingest command: ${command}`);
}
