import type { Handler } from "@netlify/functions";
import { gunzipSync } from "node:zlib";

function decodeWebhookBody(body: string | null, isBase64Encoded: boolean, contentEncoding?: string) {
  const buffer = isBase64Encoded
    ? Buffer.from(body ?? "", "base64")
    : Buffer.from(body ?? "", "utf-8");
  const normalizedEncoding = contentEncoding?.toLowerCase() ?? "";
  const looksGzip = buffer.length >= 2 && buffer[0] === 0x1f && buffer[1] === 0x8b;

  if (looksGzip) {
    return {
      payload: gunzipSync(buffer).toString("utf-8"),
      diagnostics: { bodyLen: buffer.length, contentEncoding: contentEncoding ?? null, looksGzip, gunzipped: true },
    };
  }

  return {
    payload: buffer.toString("utf-8"),
    diagnostics: {
      bodyLen: buffer.length,
      contentEncoding: contentEncoding ?? null,
      isBase64Encoded,
      looksGzip,
      decodedAsUtf8: true,
      upstreamAlreadyDecoded: normalizedEncoding.includes("gzip"),
    },
  };
}

function targetFromEvent(rawUrl: string, path: string, query: Record<string, string | undefined>) {
  const url = new URL(rawUrl);
  const target = new URL("/api/internal/mobilithek/webhook", url.origin);
  const pathMatch = path.match(/\/(?:mobilithek\/webhook|mobilithek-webhook)\/([^/?#]+)/);

  if (pathMatch) {
    target.searchParams.set("feedId", decodeURIComponent(pathMatch[1]!));
    return target;
  }

  const subscriptionId = query.subscriptionId ?? query.subscriptionID;
  if (subscriptionId) {
    target.searchParams.set("subscriptionId", subscriptionId);
    return target;
  }

  return null;
}

export const handler: Handler = async (event) => {
  if (event.httpMethod === "HEAD") {
    return { statusCode: 204, body: "" };
  }

  if (event.httpMethod === "GET") {
    return {
      statusCode: 200,
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ ok: true }),
    };
  }

  if (event.httpMethod !== "POST") {
    return {
      statusCode: 405,
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ error: "Method not allowed" }),
    };
  }

  const rawUrl =
    event.rawUrl ??
    `${event.headers["x-forwarded-proto"] ?? "https"}://${event.headers.host}${event.rawQuery ? `${event.path}?${event.rawQuery}` : event.path}`;
  const target = targetFromEvent(rawUrl, event.path, event.queryStringParameters ?? {});
  if (!target) {
    return {
      statusCode: 400,
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ error: "Missing feedId path or subscriptionId query" }),
    };
  }

  const diag: Record<string, unknown> = {};
  try {
    const decoded = decodeWebhookBody(
      event.body,
      Boolean(event.isBase64Encoded),
      event.headers["content-encoding"],
    );
    Object.assign(diag, decoded.diagnostics);
    diag.contentType = event.headers["content-type"] ?? null;
    diag.runtime = "netlify-legacy-function-proxy";
    const payload = JSON.stringify(JSON.parse(decoded.payload));

    const response = await fetch(target, {
      method: "POST",
      headers: {
        "content-type": "application/json",
        ...(event.headers["x-webhook-secret"]
          ? { "x-webhook-secret": event.headers["x-webhook-secret"] }
          : {}),
      },
      body: payload,
    });

    return {
      statusCode: response.status,
      headers: { "content-type": response.headers.get("content-type") ?? "application/json" },
      body: await response.text(),
    };
  } catch (error) {
    const message = error instanceof Error ? error.message : "Webhook processing failed";
    return {
      statusCode: 500,
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ error: message, diag }),
    };
  }
};
