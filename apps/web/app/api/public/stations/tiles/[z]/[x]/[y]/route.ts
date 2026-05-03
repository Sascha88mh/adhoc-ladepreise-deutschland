import { loadStationMapTileDb, usingDatabase } from "@adhoc/shared/db";

const TILE_CACHE_CONTROL =
  "public, max-age=60, s-maxage=120, stale-while-revalidate=300";
const MVT_CONTENT_TYPE = "application/vnd.mapbox-vector-tile";
const MAX_TILE_ZOOM = 16;

function parseTileParam(value: string | undefined) {
  if (!value || !/^\d+$/.test(value)) {
    return null;
  }

  return Number(value);
}

function validateTile(z: number, x: number, y: number) {
  if (!Number.isInteger(z) || z < 0 || z > MAX_TILE_ZOOM) {
    return false;
  }

  const maxCoordinate = 2 ** z;
  return (
    Number.isInteger(x) &&
    Number.isInteger(y) &&
    x >= 0 &&
    y >= 0 &&
    x < maxCoordinate &&
    y < maxCoordinate
  );
}

export async function GET(
  _request: Request,
  context: { params: Promise<{ z: string; x: string; y: string }> },
) {
  const params = await context.params;
  const z = parseTileParam(params.z);
  const x = parseTileParam(params.x);
  const y = parseTileParam(params.y);

  if (z == null || x == null || y == null || !validateTile(z, x, y)) {
    return Response.json(
      { error: "Invalid tile coordinate." },
      { status: 400 },
    );
  }

  if (!usingDatabase()) {
    return Response.json(
      { error: "Die Karten-Tiles benoetigen APP_DATA_SOURCE=db." },
      { status: 503 },
    );
  }

  const tile = await loadStationMapTileDb({ z, x, y });

  return new Response(new Uint8Array(tile), {
    headers: {
      "content-type": MVT_CONTENT_TYPE,
      "cache-control": TILE_CACHE_CONTROL,
    },
  });
}
