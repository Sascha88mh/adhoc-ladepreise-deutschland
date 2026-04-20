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

async function readBody(request: Request): Promise<string> {
  const buffer = Buffer.from(await request.arrayBuffer());
  const encoding = request.headers.get("content-encoding") ?? "";
  const bytes = encoding.includes("gzip") ? gunzipSync(buffer) : buffer;
  return bytes.toString("utf-8");
}

export async function POST(
  request: Request,
  { params }: { params: Promise<{ feedId: string }> },
) {
  const payload = sanitizePayload(await readBody(request));
  const { feedId } = await params;
  try {
    await processFeedWebhook(feedId, payload, request.headers.get("x-webhook-secret"));
    return Response.json({ ok: true });
  } catch (error) {
    const message = error instanceof Error ? error.message : "Webhook processing failed";
    return Response.json({ error: message }, { status: message === "Feed not found" ? 404 : 500 });
  }
}
