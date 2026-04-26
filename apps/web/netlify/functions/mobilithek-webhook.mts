import { gunzipSync } from "node:zlib";

function decodeWebhookBody(rawBody: ArrayBuffer, contentEncoding?: string | null) {
  const buffer = Buffer.from(rawBody);
  const normalizedEncoding = contentEncoding?.toLowerCase() ?? "";
  const looksGzip = buffer.length >= 2 && buffer[0] === 0x1f && buffer[1] === 0x8b;

  if (looksGzip) {
    return {
      payload: gunzipSync(buffer).toString("utf-8"),
      diagnostics: { bodyLen: buffer.length, looksGzip, gunzipped: true },
    };
  }

  return {
    payload: buffer.toString("utf-8"),
    diagnostics: {
      bodyLen: buffer.length,
      contentEncoding: contentEncoding ?? null,
      looksGzip,
      decodedAsUtf8: true,
      upstreamAlreadyDecoded: normalizedEncoding.includes("gzip"),
    },
  };
}

function resolveWebhookTarget(requestUrl: string) {
  const url = new URL(requestUrl);
  const target = new URL("/api/internal/mobilithek/webhook", url.origin);
  const pathMatch = url.pathname.match(/\/(?:mobilithek\/webhook|mobilithek-webhook)\/([^/?#]+)/);

  if (pathMatch) {
    target.searchParams.set("feedId", decodeURIComponent(pathMatch[1]!));
    return target;
  }

  const subscriptionId =
    url.searchParams.get("subscriptionId") ?? url.searchParams.get("subscriptionID");
  if (subscriptionId) {
    target.searchParams.set("subscriptionId", subscriptionId);
    return target;
  }

  return null;
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

  const target = resolveWebhookTarget(request.url);
  if (!target) {
    return Response.json({ error: "Missing feedId path or subscriptionId query" }, { status: 400 });
  }

  const diag: Record<string, unknown> = {};
  try {
    const decoded = decodeWebhookBody(
      await request.arrayBuffer(),
      request.headers.get("content-encoding"),
    );
    Object.assign(diag, decoded.diagnostics);
    diag.contentType = request.headers.get("content-type");
    diag.runtime = "netlify-function-proxy";

    const response = await fetch(target, {
      method: "POST",
      headers: {
        "content-type": "application/json",
        ...(request.headers.get("x-webhook-secret")
          ? { "x-webhook-secret": request.headers.get("x-webhook-secret")! }
          : {}),
      },
      body: decoded.payload,
    });

    const body = await response.text();
    return new Response(body, {
      status: response.status,
      headers: {
        "content-type": response.headers.get("content-type") ?? "application/json",
      },
    });
  } catch (error) {
    const message = error instanceof Error ? error.message : "Webhook processing failed";
    return Response.json({ error: message, diag }, { status: 500 });
  }
};

export default handler;
