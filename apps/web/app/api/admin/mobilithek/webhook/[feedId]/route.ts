import {
  appendSyncRun,
  recordWebhookDelivery,
  updateFeedConfig,
} from "@adhoc/shared/store";

export async function POST(
  request: Request,
  { params }: { params: Promise<{ feedId: string }> },
) {
  const payload = await request.text();
  const { feedId } = await params;
  const timestamp = new Date().toISOString();

  recordWebhookDelivery({
    feedId,
    receivedAt: timestamp,
    status: "accepted",
    payloadSize: payload.length,
  });

  updateFeedConfig(feedId, {
    lastSuccessAt: timestamp,
    lastDeltaCount: 1,
  });

  appendSyncRun({
    feedId,
    kind: "webhook",
    status: "success",
    startedAt: timestamp,
    finishedAt: new Date().toISOString(),
    message: `Webhook akzeptiert (${payload.length} bytes)`,
    deltaCount: 1,
  });

  return Response.json({ ok: true });
}
