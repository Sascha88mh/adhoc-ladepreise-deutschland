import { routeCandidatesRequestSchema } from "@adhoc/shared";
import { buildCandidateResponse, createRouteFromPolyline } from "@/lib/server/public-api";
import { getRoutePlan, storeRoutePlan } from "@/lib/server/route-cache";

export async function POST(request: Request) {
  const body = routeCandidatesRequestSchema.parse(await request.json());
  const route =
    (body.routeId ? getRoutePlan(body.routeId) : null) ??
    (body.polyline ? createRouteFromPolyline(body.polyline, body.routeId) : null);

  if (!route) {
    return Response.json({ error: "Route not found" }, { status: 404 });
  }

  storeRoutePlan(route);

  return Response.json({
    data: buildCandidateResponse(route, body.filters ?? {}),
  });
}
