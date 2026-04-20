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
  const chunks: Buffer[] = [];
  const reader = request.body!.getReader();
  while (true) {
    const { done, value } = await reader.read();
    if (done) break;
    chunks.push(Buffer.from(value));
  }
  return Buffer.concat(chunks);
}

function tryGunzip(buffer: Buffer): { ok: true; text: string } | { ok: false; error: string } {
  try {
    return { ok: true, text: gunzipSync(buffer).toString("utf-8") };
  } catch (err) {
    return { ok: false, error: err instanceof Error ? err.message : String(err) };
  }
}

export async function POST(
  request: Request,
  { params }: { params: Promise<{ feedId: string }> },
) {
  const { feedId } = await params;
  const diag: Record<string, unknown> = {};
  try {
    const buffer = await readBodyBuffer(request);
    diag.bodyLen = buffer.length;
    diag.first8Hex = buffer.slice(0, 8).toString("hex");
    diag.contentEncoding = request.headers.get("content-encoding");
    diag.contentType = request.headers.get("content-type");

    const looksGzip = buffer.length >= 2 && buffer[0] === 0x1f && buffer[1] === 0x8b;
    diag.looksGzip = looksGzip;

    let raw: string;
    if (looksGzip) {
      const result = tryGunzip(buffer);
      if (!result.ok) {
        diag.gunzipError = result.error;
        return Response.json({ error: "gunzip failed", diag }, { status: 500 });
      }
      raw = result.text;
      diag.gunzipped = true;
    } else {
      // Try gunzip anyway as fallback — some runtimes may wrap/shift bytes
      const result = tryGunzip(buffer);
      if (result.ok) {
        raw = result.text;
        diag.gunzippedWithoutMagic = true;
      } else {
        raw = buffer.toString("utf-8");
        diag.decodedAsUtf8 = true;
      }
    }

    const payload = sanitizePayload(raw);
    await processFeedWebhook(feedId, payload, request.headers.get("x-webhook-secret"));
    return Response.json({ ok: true });
  } catch (error) {
    const message = error instanceof Error ? error.message : "Webhook processing failed";
    return Response.json({ error: message, diag }, { status: message === "Feed not found" ? 404 : 500 });
  }
}
