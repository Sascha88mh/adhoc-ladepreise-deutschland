import type { Config } from "@netlify/functions";

const handler = async (request: Request) => {
  const startedAt = Date.now();
  const body = (await request.json().catch(() => ({}))) as { next_run?: string };
  const target = new URL("/.netlify/functions/ingest-sync-background", request.url);

  const response = await fetch(target, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ next_run: body.next_run ?? null }),
  });

  return new Response(JSON.stringify({
    ok: true,
    accepted: response.ok,
    nextRun: body.next_run ?? null,
    durationMs: Date.now() - startedAt,
    status: response.status,
  }), {
    status: response.ok ? 202 : 500,
    headers: {
      "content-type": "application/json",
    },
  });
};

export default handler;

export const config: Config = {
  schedule: "* * * * *",
};
