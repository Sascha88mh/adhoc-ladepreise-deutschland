import type { Config } from "@netlify/functions";
import { runDueFeedCycle } from "@adhoc/shared/ingest";

const handler = async (req: Request) => {
  const startedAt = Date.now();
  let nextRun: string | undefined;
  let processed = 0;
  let errorMessage: string | undefined;
  try {
    const body = (await req.json().catch(() => ({}))) as { next_run?: string };
    nextRun = body.next_run;
  } catch {
    nextRun = undefined;
  }

  console.log(`[ingest-sync] triggered, next_run=${nextRun ?? "n/a"}`);

  try {
    processed = await runDueFeedCycle();
    console.log(
      `[ingest-sync] processed ${processed} feed(s) in ${Date.now() - startedAt}ms`,
    );
  } catch (error) {
    errorMessage = error instanceof Error ? error.message : String(error);
    // Never propagate — Netlify would mark the invocation failed and we'd lose
    // the next tick. We've already logged per-feed errors inside the cycle.
    console.error(
      `[ingest-sync] runDueFeedCycle threw after ${Date.now() - startedAt}ms:`,
      errorMessage,
    );
  }

  return Response.json({
    ok: true,
    processed,
    nextRun: nextRun ?? null,
    durationMs: Date.now() - startedAt,
    error: errorMessage ?? null,
  });
};

export default handler;

export const config: Config = {
  schedule: "* * * * *",
};
