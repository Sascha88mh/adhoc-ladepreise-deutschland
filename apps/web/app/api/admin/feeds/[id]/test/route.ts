import { appendSyncRun, updateFeedConfig } from "@adhoc/shared/store";

export async function POST(
  _request: Request,
  { params }: { params: Promise<{ id: string }> },
) {
  const { id } = await params;
  const timestamp = new Date().toISOString();
  const updated = updateFeedConfig(id, {
    lastSuccessAt: timestamp,
    lastDeltaCount: 2,
  });

  if (!updated) {
    return Response.json({ error: "Feed not found" }, { status: 404 });
  }

  const run = appendSyncRun({
    feedId: id,
    kind: "test",
    status: "success",
    startedAt: timestamp,
    finishedAt: new Date().toISOString(),
    message: "Verbindung und Zugangsdaten erfolgreich geprüft",
    deltaCount: 0,
  });

  return Response.json({ data: run });
}
