import { reverseGeocodeLocation } from "@adhoc/shared";

export async function GET(request: Request) {
  const { searchParams } = new URL(request.url);
  const lat = Number(searchParams.get("lat"));
  const lng = Number(searchParams.get("lng"));

  if (!Number.isFinite(lat) || !Number.isFinite(lng)) {
    return Response.json({ error: "lat und lng sind erforderlich." }, { status: 400 });
  }

  const suggestion = await reverseGeocodeLocation(lat, lng);

  if (!suggestion) {
    return Response.json(
      { error: "Aktuelle Position konnte nicht aufgeloest werden." },
      { status: 502 },
    );
  }

  return Response.json({ data: suggestion });
}
