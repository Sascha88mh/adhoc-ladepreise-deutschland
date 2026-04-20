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

async function readBodyBuffer(request: Request): Promise<Buffer> {
  // Use ReadableStream reader to get raw bytes, bypassing any Request-level encoding
  const chunks: Buffer[] = [];
  const reader = request.body!.getReader();
  while (true) {
    const { done, value } = await reader.read();
    if (done) break;
    chunks.push(Buffer.from(value));
  }
  return Buffer.concat(chunks);
}

export async function POST(
  request: Request,
  { params }: { params: Promise<{ feedId: string }> },
) {
  const { feedId } = await params;
  try {
    const buffer = await readBodyBuffer(request);
    const firstBytesHex = buffer.slice(0, 4).toString("hex");
    const isGzip = buffer[0] === 0x1f && buffer[1] === 0x8b;
    const raw = isGzip ? gunzipSync(buffer).toString("utf-8") : buffer.toString("utf-8");
    const payload = sanitizePayload(raw);
    await processFeedWebhook(feedId, payload, request.headers.get("x-webhook-secret"));
    return Response.json({ ok: true });
  } catch (error) {
    const message = error instanceof Error ? error.message : "Webhook processing failed";
    // TODO: remove firstBytesHex from response after diagnosis
    return Response.json({ error: message }, { status: message === "Feed not found" ? 404 : 500 });
  }
}
