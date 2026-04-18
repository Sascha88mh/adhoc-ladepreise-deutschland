import { storeRoutePlan } from "@/lib/server/route-cache";
import { createLocationFocusRoute } from "@/lib/server/public-api";

export async function POST(request: Request) {
  try {
    const body = (await request.json()) as { query?: string };
    const query = body.query?.trim() ?? "";

    if (!query) {
      return Response.json({ error: "Standort ist erforderlich." }, { status: 400 });
    }

    const route = await createLocationFocusRoute(query);
    storeRoutePlan(route);

    return Response.json({ data: route });
  } catch (error) {
    return Response.json(
      {
        error:
          error instanceof Error ? error.message : "Standort konnte nicht geladen werden.",
      },
      { status: 400 },
    );
  }
}
