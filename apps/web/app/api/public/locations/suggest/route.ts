import { searchLocations } from "@adhoc/shared";

export async function GET(request: Request) {
  const { searchParams } = new URL(request.url);
  const query = searchParams.get("query")?.trim() ?? "";

  if (query.length < 2) {
    return Response.json({ data: [] });
  }

  const suggestions = await searchLocations(query, 6);
  return Response.json({ data: suggestions });
}
