import {
  loadStationMapTileDb,
  usingDatabase,
} from "@adhoc/shared/db";

const TILE_CACHE_CONTROL =
  "public, max-age=120, s-maxage=300, stale-while-revalidate=600";
const MVT_CONTENT_TYPE = "application/vnd.mapbox-vector-tile";
const MAX_TILE_ZOOM = 16;
const MAX_TILE_DB_IN_FLIGHT = Math.max(
  1,
  Number(process.env.MAP_TILE_DB_CONCURRENCY ?? 8),
);

declare global {
  var __adhocTileDbInFlight: number | undefined;
}

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

function tileResponse(tile: ArrayBuffer | ArrayBufferView) {
  return new Response(new Uint8Array(tile as ArrayBuffer), {
    headers: {
      "content-type": MVT_CONTENT_TYPE,
      "cache-control": TILE_CACHE_CONTROL,
    },
  });
}

function tileBusyResponse() {
  return new Response(null, {
    status: 503,
    headers: {
      "cache-control": "no-store",
      "retry-after": "1",
    },
  });
}

function tryAcquireTileDbSlot() {
  const current = globalThis.__adhocTileDbInFlight ?? 0;
  if (current >= MAX_TILE_DB_IN_FLIGHT) {
    return false;
  }

  globalThis.__adhocTileDbInFlight = current + 1;
  return true;
}

function releaseTileDbSlot() {
  globalThis.__adhocTileDbInFlight = Math.max(
    0,
    (globalThis.__adhocTileDbInFlight ?? 1) - 1,
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

  if (!tryAcquireTileDbSlot()) {
    return tileBusyResponse();
  }

  try {
    const tile = await loadStationMapTileDb({ z, x, y });
    return tileResponse(tile);
  } catch (error) {
    console.warn("[stations/tiles] tile request failed", { z, x, y, error });
    return new Response(null, {
      status: 503,
      headers: { "cache-control": "no-store" },
    });
  } finally {
    releaseTileDbSlot();
  }
}
