import { timingSafeEqual } from "node:crypto";
import { processFeedWebhook } from "@adhoc/shared/ingest";
import { usingDatabase } from "@adhoc/shared/db";
import { findAdminFeedBySubscriptionId } from "@/lib/server/admin-data";

function timingSafeEqualStrings(a: string, b: string): boolean {
  const aBuf = Buffer.from(a, "utf8");
  const bBuf = Buffer.from(b, "utf8");
  if (aBuf.length !== bBuf.length) return false;
  return timingSafeEqual(aBuf, bBuf);
}

export async function POST(request: Request) {
  if (!usingDatabase()) {
    return Response.json(
      { error: "Mobilithek webhooks require APP_DATA_SOURCE=db" },
      { status: 503 },
    );
  }

  const expectedForwardSecret = process.env.MOBILITHEK_FORWARD_SECRET;
  if (!expectedForwardSecret) {
    console.error("[webhook] MOBILITHEK_FORWARD_SECRET is not configured — refusing request");
    return Response.json({ error: "Webhook endpoint not configured" }, { status: 503 });
  }
  const incomingForwardSecret = request.headers.get("x-mobilithek-forward-secret");
  if (
    !incomingForwardSecret ||
    !timingSafeEqualStrings(incomingForwardSecret, expectedForwardSecret)
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
