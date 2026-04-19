import { cleanupStuckSyncRunsDb, isRetryableDbError, resetPool, usingDatabase } from "@adhoc/shared/db";
import { listAdminSyncRuns } from "@/lib/server/admin-data";

export async function GET() {
  try {
    return Response.json({ data: await listAdminSyncRuns() });
  } catch (error) {
    if (isRetryableDbError(error)) {
      await resetPool();
      return Response.json({ data: await listAdminSyncRuns() });
    }

    const message = error instanceof Error ? error.message : "Sync runs could not be loaded";
    return Response.json({ error: message }, { status: 500 });
  }
}

export async function DELETE() {
  if (!usingDatabase()) {
    return Response.json({ error: "Only available in db mode" }, { status: 400 });
  }

  const count = await cleanupStuckSyncRunsDb();
  return Response.json({ cleaned: count });
}
