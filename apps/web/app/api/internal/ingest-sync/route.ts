import { runDueFeedCycle } from "@adhoc/shared/ingest";

export async function POST(request: Request) {
  const startedAt = Date.now();
  const body = (await request.json().catch(() => ({}))) as { next_run?: string | null };
  let processed = 0;
  let errorMessage: string | null = null;

  try {
    processed = await runDueFeedCycle();
  } catch (error) {
    errorMessage = error instanceof Error ? error.message : String(error);
    console.error("[ingest-sync] runDueFeedCycle failed:", errorMessage);
  }

  return Response.json({
    ok: true,
    processed,
    nextRun: body.next_run ?? null,
    durationMs: Date.now() - startedAt,
    error: errorMessage,
  });
}
