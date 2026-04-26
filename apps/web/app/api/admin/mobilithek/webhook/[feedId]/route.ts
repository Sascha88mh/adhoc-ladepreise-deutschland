import { decodeMobilithekWebhookPayload, processFeedWebhook } from "@adhoc/shared/ingest";
import { usingDatabase } from "@adhoc/shared/db";

export async function GET() {
  return Response.json({ ok: true });
}

export async function HEAD() {
  return new Response(null, { status: 204 });
}

export async function POST(
  request: Request,
  { params }: { params: Promise<{ feedId: string }> },
) {
  if (!usingDatabase()) {
    return Response.json(
      { error: "Mobilithek webhooks require APP_DATA_SOURCE=db" },
      { status: 503 },
    );
  }

  const { feedId } = await params;

  try {
    const { payload } = decodeMobilithekWebhookPayload(
      await request.arrayBuffer(),
      request.headers.get("content-encoding"),
    );
    await processFeedWebhook(feedId, payload, request.headers.get("x-webhook-secret"));
    return Response.json({ ok: true, feedId });
  } catch (error) {
    const message = error instanceof Error ? error.message : "Webhook processing failed";
    return Response.json(
      { error: message },
      { status: message === "Feed not found" ? 404 : 500 },
    );
  }
}
