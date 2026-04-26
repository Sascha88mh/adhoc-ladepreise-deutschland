type Env = {
  UPSTREAM_WEBHOOK_URL: string;
  MOBILITHEK_FORWARD_SECRET?: string;
};

function json(body: unknown, status = 200) {
  return new Response(JSON.stringify(body), {
    status,
    headers: {
      "content-type": "application/json",
      "cache-control": "no-store",
    },
  });
}

function targetFromRequest(request: Request, upstreamBase: string) {
  const url = new URL(request.url);
  const target = new URL(upstreamBase);
  const pathMatch = url.pathname.match(/\/(?:mobilithek\/webhook|mobilithek-webhook|webhook)\/([^/?#]+)/);
  const subscriptionId = url.searchParams.get("subscriptionId") ?? url.searchParams.get("subscriptionID");

  if (pathMatch?.[1]) {
    target.searchParams.set("feedId", decodeURIComponent(pathMatch[1]));
    return target;
  }

  if (subscriptionId) {
    target.searchParams.set("subscriptionId", subscriptionId);
    return target;
  }

  return null;
}

async function inflateGzip(buffer: ArrayBuffer) {
  const decompressionStream = new DecompressionStream("gzip");
  const stream = new Blob([buffer]).stream().pipeThrough(decompressionStream);
  return new Response(stream).text();
}

async function decodeBody(request: Request) {
  const buffer = await request.arrayBuffer();
  const bytes = new Uint8Array(buffer);
  const contentEncoding = request.headers.get("content-encoding")?.toLowerCase() ?? "";
  const looksGzip = bytes.length >= 2 && bytes[0] === 0x1f && bytes[1] === 0x8b;

  if (looksGzip || contentEncoding.includes("gzip")) {
    try {
      return {
        payload: await inflateGzip(buffer),
        diagnostics: {
          bodyLen: bytes.byteLength,
          contentEncoding,
          looksGzip,
          gunzipped: true,
        },
      };
    } catch (error) {
      if (looksGzip) throw error;
    }
  }

  return {
    payload: new TextDecoder().decode(buffer),
    diagnostics: {
      bodyLen: bytes.byteLength,
      contentEncoding,
      looksGzip,
      decodedAsUtf8: true,
    },
  };
}

export default {
  async fetch(request: Request, env: Env) {
    if (request.method === "HEAD") {
      return new Response(null, { status: 204 });
    }

    if (request.method === "GET") {
      return json({ ok: true, service: "mobilithek-gateway" });
    }

    if (request.method !== "POST") {
      return json({ error: "Method not allowed" }, 405);
    }

    if (!env.UPSTREAM_WEBHOOK_URL) {
      return json({ error: "UPSTREAM_WEBHOOK_URL is not configured" }, 500);
    }

    const target = targetFromRequest(request, env.UPSTREAM_WEBHOOK_URL);
    if (!target) {
      return json({ error: "Missing feedId path or subscriptionId query" }, 400);
    }

    const diagnostics: Record<string, unknown> = {};
    try {
      const decoded = await decodeBody(request);
      Object.assign(diagnostics, decoded.diagnostics);

      const normalizedPayload = JSON.stringify(JSON.parse(decoded.payload));
      const headers: Record<string, string> = {
        "content-type": "application/json",
      };
      const incomingWebhookSecret = request.headers.get("x-webhook-secret");

      if (env.MOBILITHEK_FORWARD_SECRET) {
        headers["x-mobilithek-forward-secret"] = env.MOBILITHEK_FORWARD_SECRET;
      }

      if (incomingWebhookSecret) {
        headers["x-webhook-secret"] = incomingWebhookSecret;
      }

      const response = await fetch(target, {
        method: "POST",
        headers,
        body: normalizedPayload,
      });

      return new Response(await response.text(), {
        status: response.status,
        headers: {
          "content-type": response.headers.get("content-type") ?? "application/json",
          "cache-control": "no-store",
        },
      });
    } catch (error) {
      return json(
        {
          error: error instanceof Error ? error.message : "Webhook processing failed",
          diag: diagnostics,
        },
        500,
      );
    }
  },
};
