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

export async function POST(request: Request) {
  const body = requestSchema.parse(await request.json());

  return Response.json({
    data: await listMapStations(body.bounds, body.filters ?? {}),
  });
}
