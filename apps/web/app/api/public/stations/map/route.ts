import { candidateFiltersSchema } from "@adhoc/shared";
import { z } from "zod";
import { listMapStations } from "@/lib/server/public-api";

const requestSchema = z.object({
  bounds: z.object({
    minLat: z.number(),
    minLng: z.number(),
    maxLat: z.number(),
    maxLng: z.number(),
  }),
  filters: candidateFiltersSchema.default({}),
});

const MAP_CACHE_CONTROL = "public, max-age=15, s-maxage=45, stale-while-revalidate=120";

function mapResponse(data: Awaited<ReturnType<typeof listMapStations>>) {
  return Response.json(
    { data },
    {
      headers: {
        "cache-control": MAP_CACHE_CONTROL,
      },
    },
  );
}

function parseFilters(value: string | null) {
  if (!value) {
    return {};
  }

  return JSON.parse(value) as unknown;
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

  return mapResponse(await listMapStations(body.bounds, body.filters ?? {}));
}

export async function POST(request: Request) {
  const body = requestSchema.parse(await request.json());

  return mapResponse(await listMapStations(body.bounds, body.filters ?? {}));
}
