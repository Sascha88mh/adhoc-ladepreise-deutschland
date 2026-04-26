import { gzipSync } from "node:zlib";
import { describe, expect, it } from "vitest";
import { decodeMobilithekWebhookPayload } from "../src/ingest/index";

describe("Mobilithek webhook payload decoding", () => {
  it("decodes gzip-compressed webhook bodies before parsing", () => {
    const payload = JSON.stringify({ messageContainer: { payload: [] } });
    const decoded = decodeMobilithekWebhookPayload(gzipSync(payload), "gzip");

    expect(decoded.payload).toBe(payload);
    expect(decoded.diagnostics.gunzipped).toBe(true);
    expect(decoded.diagnostics.looksGzip).toBe(true);
  });

  it("keeps plain JSON webhook bodies unchanged", () => {
    const payload = JSON.stringify({ messageContainer: { payload: [] } });
    const decoded = decodeMobilithekWebhookPayload(Buffer.from(payload), null);

    expect(decoded.payload).toBe(payload);
    expect(decoded.diagnostics.decodedAsUtf8).toBe(true);
    expect(decoded.diagnostics.looksGzip).toBe(false);
  });
});
