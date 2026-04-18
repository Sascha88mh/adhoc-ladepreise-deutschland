import { listAdminSyncRuns } from "@/lib/server/admin-data";

export async function GET() {
  return Response.json({ data: await listAdminSyncRuns() });
}
