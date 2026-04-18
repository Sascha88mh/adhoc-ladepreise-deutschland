import { listSyncRuns } from "@adhoc/shared/store";

export async function GET() {
  return Response.json({ data: listSyncRuns() });
}
