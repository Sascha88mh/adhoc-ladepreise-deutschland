import type { Context } from "@netlify/functions";
import { processFeedWebhook } from "@adhoc/shared/ingest";
import { gunzipSync } from "zlib";

function sanitizePayload(raw: string): string {
  return raw
    .replace(/\u0000/g, "")
    .replace(/\\u0000/gi, "")
    .replace(/\\u\{([0-9a-fA-F]+)\}/g, (_, hex) => {
      const cp = Number.parseInt(hex, 16);
      if (Number.isNaN(cp) || cp > 0x10ffff) return "";
      return String.fromCodePoint(cp);
    })
    .replace(/\\u(?![0-9a-fA-F]{4})/gi, "\\uFFFD")
    .replace(/\\uD[89AB][0-9A-F]{2}(?!\\uD[CDEF][0-9A-F]{2})/gi, "\\uFFFD")
    .replace(/(^|[^\\])(\\uD[CDEF][0-9A-F]{2})/gi, (_, prefix) => `${prefix}\\uFFFD`);
}

function extractFeedId(url: string): string | null {
  const match = url.match(/\/mobilithek\/webhook\/([^/?#]+)/);
  return match ? decodeURIComponent(match[1]) : null;
}

export default async (request: Request, _context: Context) => {
  if (request.method !== "POST") {
    return Response.json({ error: "Method not allowed" }, { status: 405 });
  }

  const feedId = extractFeedId(request.url);
  if (!feedId) {
    return Response.json({ error: "Missing feedId in path" }, { status: 400 });
  }

  const diag: Record<string, unknown> = {};
  try {
    const buffer = Buffer.from(await request.arrayBuffer());
    diag.bodyLen = buffer.length;
    diag.first8Hex = buffer.slice(0, 8).toString("hex");
    diag.contentEncoding = request.headers.get("content-encoding");
    diag.contentType = request.headers.get("content-type");
    diag.runtime = "netlify-function";

    const looksGzip = buffer.length >= 2 && buffer[0] === 0x1f && buffer[1] === 0x8b;
    diag.looksGzip = looksGzip;

    let raw: string;
    if (looksGzip || request.headers.get("content-encoding")?.toLowerCase() === "gzip") {
      try {
        raw = gunzipSync(buffer).toString("utf-8");
        diag.gunzipped = true;
      } catch (err) {
        diag.gunzipError = err instanceof Error ? err.message : String(err);
        return Response.json({ error: "gunzip failed", diag }, { status: 500 });
      }
    } else {
      raw = buffer.toString("utf-8");
      diag.decodedAsUtf8 = true;
    }

    const payload = sanitizePayload(raw);
    await processFeedWebhook(feedId, payload, request.headers.get("x-webhook-secret"));
    return Response.json({ ok: true });
  } catch (error) {
    const message = error instanceof Error ? error.message : "Webhook processing failed";
    return Response.json(
      { error: message, diag },
      { status: message === "Feed not found" ? 404 : 500 },
    );
  }
};
