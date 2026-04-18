import { processFeedWebhook } from "@adhoc/shared/ingest";
import { usingDatabase } from "@adhoc/shared/db";
import { findAdminFeedBySubscriptionId } from "@/lib/server/admin-data";

export async function POST(request: Request) {
  if (!usingDatabase()) {
    return Response.json(
      { error: "Mobilithek webhooks require APP_DATA_SOURCE=db" },
      { status: 503 },
    );
  }

  const url = new URL(request.url);
  const subscriptionId = url.searchParams.get("subscriptionId");

  if (!subscriptionId) {
    return Response.json({ error: "subscriptionId is required" }, { status: 400 });
  }

  const feed = await findAdminFeedBySubscriptionId(subscriptionId);
  if (!feed) {
    return Response.json({ error: "Feed not found" }, { status: 404 });
  }

  const payload = await request.text();

  try {
    await processFeedWebhook(feed.id, payload, request.headers.get("x-webhook-secret"));
    return Response.json({ ok: true, feedId: feed.id });
  } catch (error) {
    const message = error instanceof Error ? error.message : "Webhook processing failed";
    return Response.json({ error: message }, { status: 500 });
  }
}
