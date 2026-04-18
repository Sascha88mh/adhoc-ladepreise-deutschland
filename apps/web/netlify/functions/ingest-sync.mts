import type { Config } from "@netlify/functions";
import { runDueFeedCycle } from "@adhoc/shared/ingest";

export default async (req: Request) => {
  const { next_run } = await req.json();
  console.log(`[ingest-sync] triggered, next_run=${next_run}`);

  const processed = await runDueFeedCycle();
  console.log(`[ingest-sync] processed ${processed} feed(s)`);
};

export const config: Config = {
  schedule: "* * * * *",
};
