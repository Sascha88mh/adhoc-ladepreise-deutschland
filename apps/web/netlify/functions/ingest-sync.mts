import type { Config } from "@netlify/functions";

const handler = async (request: Request) => {
  const startedAt = Date.now();
  const body = (await request.json().catch(() => ({}))) as { next_run?: string };
  const target = new URL("/api/internal/ingest-sync", request.url);

  const response = await fetch(target, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ next_run: body.next_run ?? null }),
  });

  const responseBody = await response.text();
  return new Response(responseBody, {
    status: response.status,
    headers: {
      "content-type": response.headers.get("content-type") ?? "application/json",
      "x-proxy-duration-ms": String(Date.now() - startedAt),
    },
  });
};

export default handler;

export const config: Config = {
  schedule: "* * * * *",
};
