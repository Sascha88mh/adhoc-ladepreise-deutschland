import { RoutePlanningError, routePlanRequestSchema, planRoute } from "@adhoc/shared";
import { storeRoutePlan } from "@/lib/server/route-cache";

export async function POST(request: Request) {
  try {
    const body = routePlanRequestSchema.parse(await request.json());
    const route = await planRoute(body.origin, body.destination, body.profile);
    storeRoutePlan(route);
    return Response.json({ data: route });
  } catch (error) {
    if (error instanceof RoutePlanningError) {
      return Response.json(
        { error: error.message },
        { status: error.statusCode },
      );
    }

    const message =
      error instanceof Error ? error.message : "Route konnte nicht geplant werden.";
    return Response.json({ error: message }, { status: 500 });
  }
}
