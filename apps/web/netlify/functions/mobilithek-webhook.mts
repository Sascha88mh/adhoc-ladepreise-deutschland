import { decodeMobilithekWebhookPayload, processFeedWebhook } from "@adhoc/shared/ingest";
import { listFeedConfigsDb } from "@adhoc/shared/db";

async function resolveFeedId(requestUrl: string): Promise<string | null> {
  const url = new URL(requestUrl);
  const pathMatch = url.pathname.match(/\/(?:mobilithek\/webhook|mobilithek-webhook)\/([^/?#]+)/);
  if (pathMatch) {
    return decodeURIComponent(pathMatch[1]!);
  }

  const subscriptionId =
    url.searchParams.get("subscriptionId") ?? url.searchParams.get("subscriptionID");
  if (!subscriptionId) {
    return null;
  }

  const feeds = await listFeedConfigsDb();
  return feeds.find((feed) => feed.subscriptionId === subscriptionId)?.id ?? null;
}

const handler = async (request: Request) => {
  if (request.method === "HEAD") {
    return new Response(null, { status: 204 });
  }

  if (request.method === "GET") {
    return Response.json({ ok: true });
  }

  if (request.method !== "POST") {
    return Response.json({ error: "Method not allowed" }, { status: 405 });
  }

  const feedId = await resolveFeedId(request.url);
  if (!feedId) {
    return Response.json({ error: "Missing feedId path or subscriptionId query" }, { status: 400 });
  }

  const diag: Record<string, unknown> = {};
  try {
    const decoded = decodeMobilithekWebhookPayload(
      await request.arrayBuffer(),
      request.headers.get("content-encoding"),
    );
    Object.assign(diag, decoded.diagnostics);
    diag.contentType = request.headers.get("content-type");
    diag.runtime = "netlify-function";

    await processFeedWebhook(feedId, decoded.payload, request.headers.get("x-webhook-secret"));
    return Response.json({ ok: true });
  } catch (error) {
    const message = error instanceof Error ? error.message : "Webhook processing failed";
    return Response.json(
      { error: message, diag },
      { status: message === "Feed not found" ? 404 : 500 },
    );
  }
};

export default handler;
