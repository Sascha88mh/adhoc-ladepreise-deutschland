type Env = {
  UPSTREAM_WEBHOOK_URL: string;
  MAP_STATIONS_UPSTREAM_URL?: string;
  MOBILITHEK_FORWARD_SECRET?: string;
};

type CloudflareCacheStorage = CacheStorage & {
  default: Cache;
};

const ALLOWED_ORIGINS = new Set([
  "https://adhoc-plattform.netlify.app",
  "https://main--adhoc-plattform.netlify.app",
]);

function json(body: unknown, status = 200) {
  return new Response(JSON.stringify(body), {
    status,
    headers: {
      "content-type": "application/json",
      "cache-control": "no-store",
    },
  });
}

function corsHeaders(request: Request) {
  const origin = request.headers.get("origin");
  const allowOrigin = origin && ALLOWED_ORIGINS.has(origin) ? origin : "*";

  return {
    "access-control-allow-origin": allowOrigin,
    "access-control-allow-methods": "GET, HEAD, OPTIONS",
    "access-control-allow-headers": "content-type",
    "access-control-max-age": "86400",
  };
}

function withCors(response: Response, request: Request) {
  const headers = new Headers(response.headers);
  for (const [key, value] of Object.entries(corsHeaders(request))) {
    headers.set(key, value);
  }

  return new Response(response.body, {
    status: response.status,
    statusText: response.statusText,
    headers,
  });
}

function mapStationsTarget(request: Request, upstreamBase: string) {
  const url = new URL(request.url);
  const target = new URL(upstreamBase);
  target.search = url.search;
  return target;
}

async function handleMapStations(request: Request, env: Env, context: ExecutionContext) {
  if (!env.MAP_STATIONS_UPSTREAM_URL) {
    return withCors(json({ error: "MAP_STATIONS_UPSTREAM_URL is not configured" }, 500), request);
  }

  if (request.method === "OPTIONS") {
    return new Response(null, { status: 204, headers: corsHeaders(request) });
  }

  if (request.method !== "GET" && request.method !== "HEAD") {
    return withCors(json({ error: "Method not allowed" }, 405), request);
  }

  const cache = (caches as CloudflareCacheStorage).default;
  const target = mapStationsTarget(request, env.MAP_STATIONS_UPSTREAM_URL);
  const cacheKey = new Request(target.toString(), { method: "GET" });
  const cached = await cache.match(cacheKey);

  if (cached) {
    const response = new Response(request.method === "HEAD" ? null : cached.body, cached);
    response.headers.set("x-adhoc-cache", "hit");
    return withCors(response, request);
  }

  const upstream = await fetch(target, {
    headers: {
      accept: "application/json",
    },
  });
  const headers = new Headers(upstream.headers);
  headers.set("cache-control", "public, max-age=20, s-maxage=60, stale-while-revalidate=120");
  headers.set("x-adhoc-cache", "miss");

  const response = new Response(request.method === "HEAD" ? null : upstream.body, {
    status: upstream.status,
    statusText: upstream.statusText,
    headers,
  });

  if (upstream.ok && request.method === "GET") {
    context.waitUntil(cache.put(cacheKey, response.clone()));
  }

  return withCors(response, request);
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
  async fetch(request: Request, env: Env, context: ExecutionContext) {
    const url = new URL(request.url);

    if (url.pathname === "/map-stations") {
      return handleMapStations(request, env, context);
    }

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
