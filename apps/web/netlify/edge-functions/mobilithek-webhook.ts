import type { Config, Context } from "@netlify/edge-functions";

function json(body: unknown, status = 200) {
  return new Response(JSON.stringify(body), {
    status,
    headers: {
      "content-type": "application/json",
      "cache-control": "no-store",
    },
  });
}

function targetFromRequest(request: Request) {
  const url = new URL(request.url);
  const target = new URL("/api/internal/mobilithek/webhook", url.origin);
  const pathMatch = url.pathname.match(/\/api\/admin\/mobilithek\/webhook\/([^/?#]+)/);
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

async function gunzip(buffer: ArrayBuffer) {
  const stream = new Blob([buffer]).stream().pipeThrough(new DecompressionStream("gzip"));
  return new Response(stream).text();
}

async function decodeBody(request: Request) {
  const buffer = await request.arrayBuffer();
  const bytes = new Uint8Array(buffer);
  const contentEncoding = request.headers.get("content-encoding")?.toLowerCase() ?? "";
  const looksGzip = bytes.length >= 2 && bytes[0] === 0x1f && bytes[1] === 0x8b;

  if (looksGzip || contentEncoding.includes("gzip")) {
    return {
      payload: await gunzip(buffer),
      diagnostics: {
        runtime: "netlify-edge-function",
        bodyLen: bytes.byteLength,
        contentEncoding,
        looksGzip,
        gunzipped: true,
      },
    };
  }

  return {
    payload: new TextDecoder().decode(buffer),
    diagnostics: {
      runtime: "netlify-edge-function",
      bodyLen: bytes.byteLength,
      contentEncoding,
      looksGzip,
      decodedAsUtf8: true,
    },
  };
}

export default async (request: Request, _context: Context) => {
  if (request.method === "HEAD") {
    return new Response(null, { status: 204 });
  }

  if (request.method === "GET") {
    return json({ ok: true, runtime: "netlify-edge-function" });
  }

  if (request.method !== "POST") {
    return json({ error: "Method not allowed" }, 405);
  }

  const target = targetFromRequest(request);
  if (!target) {
    return json({ error: "Missing feedId path or subscriptionId query" }, 400);
  }

  const diagnostics: Record<string, unknown> = {};
  try {
    const decoded = await decodeBody(request);
    Object.assign(diagnostics, decoded.diagnostics);

    const payload = JSON.stringify(JSON.parse(decoded.payload));
    const headers: Record<string, string> = {
      "content-type": "application/json",
    };
    const forwardSecret = Netlify.env.get("MOBILITHEK_FORWARD_SECRET");
    const webhookSecret = request.headers.get("x-webhook-secret");

    if (forwardSecret) {
      headers["x-mobilithek-forward-secret"] = forwardSecret;
    }

    if (webhookSecret) {
      headers["x-webhook-secret"] = webhookSecret;
    }

    const response = await fetch(target, {
      method: "POST",
      headers,
      body: payload,
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
};

export const config: Config = {
  path: ["/api/admin/mobilithek/webhook/*", "/api/mobilithek/webhook"],
};
