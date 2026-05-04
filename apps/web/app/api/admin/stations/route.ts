import { searchAdminStations } from "@/lib/server/admin-data";

const ADMIN_STATIONS_TIMEOUT_MS = Math.max(
  500,
  Number(process.env.ADMIN_STATIONS_TIMEOUT_MS ?? 4000),
);

function emptyStationsAfter(ms: number) {
  return new Promise<Response>((resolve) => {
    setTimeout(() => {
      resolve(
        Response.json(
          { error: "Stationen konnten gerade nicht geladen werden." },
          { status: 503 },
        ),
      );
    }, ms);
  });
}

export async function GET(request: Request) {
  const { searchParams } = new URL(request.url);
  const query = searchParams.get("query") ?? "";

  const stationsPromise = searchAdminStations(query)
    .then((data) => Response.json({ data }))
    .catch((error) => {
      const message = error instanceof Error ? error.message : "Stationen konnten nicht geladen werden.";
      console.error("[admin/stations] station list load failed:", message);
      return Response.json({ error: message }, { status: 503 });
    });

  return Promise.race([
    stationsPromise,
    emptyStationsAfter(ADMIN_STATIONS_TIMEOUT_MS),
  ]);
}
