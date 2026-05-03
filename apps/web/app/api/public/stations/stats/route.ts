import { candidateFiltersSchema } from "@adhoc/shared";
import { z } from "zod";
import { loadMapStationStats } from "@/lib/server/public-api";

const requestSchema = z.object({
  bounds: z.object({
    minLat: z.number(),
    minLng: z.number(),
    maxLat: z.number(),
    maxLng: z.number(),
  }),
  filters: candidateFiltersSchema.default({}),
});

const STATS_CACHE_CONTROL = "public, max-age=15, s-maxage=45, stale-while-revalidate=120";

function parseFilters(value: string | null) {
  if (!value) {
    return {};
  }

  return JSON.parse(value) as unknown;
}

function statsResponse(data: Awaited<ReturnType<typeof loadMapStationStats>>) {
  return Response.json(
    { data },
    {
      headers: {
        "cache-control": STATS_CACHE_CONTROL,
      },
    },
  );
}

export async function GET(request: Request) {
  const url = new URL(request.url);
  const body = requestSchema.parse({
    bounds: {
      minLat: Number(url.searchParams.get("minLat")),
      minLng: Number(url.searchParams.get("minLng")),
      maxLat: Number(url.searchParams.get("maxLat")),
      maxLng: Number(url.searchParams.get("maxLng")),
    },
    filters: parseFilters(url.searchParams.get("filters")),
  });

  return statsResponse(await loadMapStationStats(body.bounds, body.filters ?? {}));
}

export async function POST(request: Request) {
  const body = requestSchema.parse(await request.json());

  return statsResponse(await loadMapStationStats(body.bounds, body.filters ?? {}));
}
