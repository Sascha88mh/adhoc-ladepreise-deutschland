import { routePlanRequestSchema, planRoute } from "@adhoc/shared";
import { storeRoutePlan } from "@/lib/server/route-cache";

export async function POST(request: Request) {
  const body = routePlanRequestSchema.parse(await request.json());
  const route = await planRoute(body.origin, body.destination, body.profile);
  storeRoutePlan(route);
  return Response.json({ data: route });
}
