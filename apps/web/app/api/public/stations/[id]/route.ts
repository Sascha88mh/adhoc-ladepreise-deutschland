import { loadStationDetail } from "@/lib/server/public-api";

export async function GET(
  _request: Request,
  { params }: { params: Promise<{ id: string }> },
) {
  const { id } = await params;
  const detail = await loadStationDetail(id);

  if (!detail) {
    return Response.json({ error: "Station not found" }, { status: 404 });
  }

  return Response.json({ data: detail });
}
