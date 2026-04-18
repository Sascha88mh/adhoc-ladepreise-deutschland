import { searchAdminStations } from "@/lib/server/admin-data";

export async function GET(request: Request) {
  const { searchParams } = new URL(request.url);
  const query = searchParams.get("query") ?? "";

  return Response.json({ data: await searchAdminStations(query) });
}
