import { cleanupStuckSyncRunsDb, usingDatabase } from "@adhoc/shared/db";
import { listAdminSyncRuns } from "@/lib/server/admin-data";
import { adminGuardResponse, requireAdmin } from "@/lib/supabase/require-admin";

const ADMIN_SYNC_RUNS_TIMEOUT_MS = Math.max(
  500,
  Number(process.env.ADMIN_SYNC_RUNS_TIMEOUT_MS ?? 4000),
);

export async function GET() {
  const guard = await requireAdmin();
  if (!guard.ok) return adminGuardResponse(guard);

  const runsPromise = listAdminSyncRuns()
    .then((data) => Response.json({ data }))
    .catch((error) => {
      const message = error instanceof Error ? error.message : "Sync runs could not be loaded";
      console.error("[admin/sync-runs] run list load failed:", message);
      return Response.json({ error: message }, { status: 503 });
    });

  const timeout = new Promise<Response>((resolve) => {
    setTimeout(() => {
      resolve(
        Response.json(
          { error: "Sync runs could not be loaded" },
          { status: 503 },
        ),
      );
    }, ADMIN_SYNC_RUNS_TIMEOUT_MS);
  });

  return Promise.race([runsPromise, timeout]);
}

export async function DELETE() {
  const guard = await requireAdmin();
  if (!guard.ok) return adminGuardResponse(guard);

  if (!usingDatabase()) {
    return Response.json({ error: "Only available in db mode" }, { status: 400 });
  }

  const count = await cleanupStuckSyncRunsDb();
  return Response.json({ cleaned: count });
}
