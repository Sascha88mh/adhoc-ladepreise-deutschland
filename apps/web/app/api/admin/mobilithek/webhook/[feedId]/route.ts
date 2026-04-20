import { processFeedWebhook } from "@adhoc/shared/ingest";
// cache-bust: force rebuild after sanitizer fix

export async function POST(
  request: Request,
  { params }: { params: Promise<{ feedId: string }> },
) {
  const payload = await request.text();
  const { feedId } = await params;
  try {
    await processFeedWebhook(feedId, payload, request.headers.get("x-webhook-secret"));
    return Response.json({ ok: true });
  } catch (error) {
    const message = error instanceof Error ? error.message : "Webhook processing failed";
    return Response.json({ error: message }, { status: message === "Feed not found" ? 404 : 500 });
  }
}
