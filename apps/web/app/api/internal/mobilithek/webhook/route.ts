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

  const expectedForwardSecret = process.env.MOBILITHEK_FORWARD_SECRET;
  if (
    expectedForwardSecret &&
    request.headers.get("x-mobilithek-forward-secret") !== expectedForwardSecret
  ) {
    return Response.json({ error: "Invalid forward secret" }, { status: 401 });
  }

  const url = new URL(request.url);
  let feedId = url.searchParams.get("feedId");
  const subscriptionId = url.searchParams.get("subscriptionId");

  if (!feedId && subscriptionId) {
    const feed = await findAdminFeedBySubscriptionId(subscriptionId);
    feedId = feed?.id ?? null;
  }

  if (!feedId) {
    return Response.json({ error: "Feed not found" }, { status: 404 });
  }

  try {
    await processFeedWebhook(feedId, await request.text(), request.headers.get("x-webhook-secret"));
    return Response.json({ ok: true, feedId });
  } catch (error) {
    const message = error instanceof Error ? error.message : "Webhook processing failed";
    return Response.json(
      { error: message },
      { status: message === "Feed not found" ? 404 : 500 },
    );
  }
}
