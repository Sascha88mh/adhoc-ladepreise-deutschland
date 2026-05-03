import { runDueFeedCycle } from "../../../../packages/shared/src/ingest/index";

export const handler = async () => {
  const startedAt = Date.now();
  let processed = 0;
  let errorMessage: string | null = null;

  try {
    processed = await runDueFeedCycle();
  } catch (error) {
    errorMessage = error instanceof Error ? error.message : String(error);
    console.error("[ingest-sync-background] runDueFeedCycle failed:", errorMessage);
  }

  return {
    statusCode: 200,
    headers: {
      "content-type": "application/json",
    },
    body: JSON.stringify({
      ok: true,
      processed,
      durationMs: Date.now() - startedAt,
      error: errorMessage,
    }),
  };
};
