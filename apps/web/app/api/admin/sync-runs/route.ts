import { cleanupStuckSyncRunsDb, usingDatabase } from "@adhoc/shared/db";
import { listAdminSyncRuns } from "@/lib/server/admin-data";

export async function GET() {
  return Response.json({ data: await listAdminSyncRuns() });
}

export async function DELETE() {
  if (!usingDatabase()) {
    return Response.json({ error: "Only available in db mode" }, { status: 400 });
  }

  const count = await cleanupStuckSyncRunsDb();
  return Response.json({ cleaned: count });
}
