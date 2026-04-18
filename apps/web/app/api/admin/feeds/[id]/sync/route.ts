import { appendSyncRun, updateFeedConfig } from "@adhoc/shared/store";

export async function POST(
  _request: Request,
  { params }: { params: Promise<{ id: string }> },
) {
  const { id } = await params;
  const startedAt = new Date().toISOString();
  const updated = updateFeedConfig(id, {
    lastSuccessAt: startedAt,
    lastSnapshotAt: startedAt,
    lastDeltaCount: 5,
  });

  if (!updated) {
    return Response.json({ error: "Feed not found" }, { status: 404 });
  }

  const run = appendSyncRun({
    feedId: id,
    kind: "manual",
    status: "success",
    startedAt,
    finishedAt: new Date().toISOString(),
    message: "Manueller Sync abgeschlossen",
    deltaCount: 5,
  });

  return Response.json({ data: run });
}
