import type { Coordinate, RouteLocation, RoutePlan, RouteProfile } from "./types";
import { routePlanSchema } from "./types";
import { resolveLocation } from "../geo/geocoder";
import { routeBounds } from "../geo/route-corridor";
import { routeDistanceKm } from "../geo/haversine";

type RoutingSummary = {
  distanceKm: number;
  durationMinutes: number;
  geometry: Coordinate[];
};

type ValhallaResponse = {
  trip?: {
    summary?: { length?: number; time?: number };
    legs?: Array<{ shape?: { coordinates?: Array<[number, number]> } }>;
  };
};

type OsrmResponse = {
  routes?: Array<{
    distance?: number;
    duration?: number;
    geometry?: { coordinates?: Array<[number, number]> };
  }>;
};

const OSRM_URL =
  process.env.OSRM_URL ?? "https://router.project-osrm.org";

export class RoutePlanningError extends Error {
  statusCode: number;

  constructor(message: string, statusCode = 400) {
    super(message);
    this.name = "RoutePlanningError";
    this.statusCode = statusCode;
  }
}

function createId(parts: string[]) {
  const input = parts.join("|");
  let hash = 0;

  for (let index = 0; index < input.length; index += 1) {
    hash = (hash << 5) - hash + input.charCodeAt(index);
    hash |= 0;
  }

  return `route-${Math.abs(hash).toString(36)}`;
}

function toRoutePlan(
  origin: RouteLocation,
  destination: RouteLocation,
  profile: RouteProfile,
  source: string,
  summary: RoutingSummary,
): RoutePlan {
  return routePlanSchema.parse({
    routeId: createId([origin.label, destination.label, profile, source]),
    profile,
    corridorKm: 5,
    origin,
    destination,
    geometry: summary.geometry,
    distanceKm: summary.distanceKm,
    durationMinutes: summary.durationMinutes,
    bounds: routeBounds(summary.geometry),
    alternatives: [],
  });
}

async function callValhalla(
  origin: RouteLocation,
  destination: RouteLocation,
  profile: RouteProfile,
): Promise<RoutingSummary | null> {
  const baseUrl = process.env.VALHALLA_URL;

  if (!baseUrl) {
    return null;
  }

  try {
    const response = await fetch(`${baseUrl.replace(/\/$/, "")}/route`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        costing: profile === "truck" ? "truck" : "auto",
        shape_format: "geojson",
        locations: [
          { lat: origin.coordinates.lat, lon: origin.coordinates.lng },
          { lat: destination.coordinates.lat, lon: destination.coordinates.lng },
        ],
      }),
      cache: "no-store",
    });

    if (!response.ok) {
      return null;
    }

    const payload = (await response.json()) as ValhallaResponse;

    const coordinates =
      payload.trip?.legs?.flatMap((leg) =>
        (leg.shape?.coordinates ?? []).map(([lng, lat]) => ({ lat, lng })),
      ) ?? [];

    if (coordinates.length < 2) {
      return null;
    }

    return {
      geometry: coordinates,
      distanceKm: payload.trip?.summary?.length ?? routeDistanceKm(coordinates),
      durationMinutes: Math.max(
        1,
        Math.round(((payload.trip?.summary?.time ?? 0) / 60) || routeDistanceKm(coordinates) * 0.8),
      ),
    };
  } catch {
    return null;
  }
}

async function callOsrm(
  origin: RouteLocation,
  destination: RouteLocation,
  profile: RouteProfile,
): Promise<RoutingSummary | null> {
  if (profile !== "auto") {
    return null;
  }

  try {
    const coordinates = `${origin.coordinates.lng},${origin.coordinates.lat};${destination.coordinates.lng},${destination.coordinates.lat}`;
    const url = new URL(`/route/v1/driving/${coordinates}`, OSRM_URL);
    url.searchParams.set("overview", "full");
    url.searchParams.set("geometries", "geojson");
    url.searchParams.set("alternatives", "false");
    url.searchParams.set("steps", "false");

    const response = await fetch(url, {
      headers: {
        accept: "application/json",
      },
      cache: "no-store",
    });

    if (!response.ok) {
      return null;
    }

    const payload = (await response.json()) as OsrmResponse;
    const route = payload.routes?.[0];
    const geometry = route?.geometry?.coordinates?.map(([lng, lat]) => ({ lat, lng })) ?? [];

    if (geometry.length < 2) {
      return null;
    }

    return {
      geometry,
      distanceKm: Number(((route?.distance ?? routeDistanceKm(geometry) * 1000) / 1000).toFixed(1)),
      durationMinutes: Math.max(1, Math.round((route?.duration ?? 0) / 60)),
    };
  } catch {
    return null;
  }
}

export async function planRoute(
  originInput: string,
  destinationInput: string,
  profile: RouteProfile = "auto",
) {
  const [origin, destination] = await Promise.all([
    resolveLocation(originInput),
    resolveLocation(destinationInput),
  ]);

  if (!origin || !destination) {
    throw new RoutePlanningError(
      "Start oder Ziel konnten nicht aufgeloest werden. Nutze einen Ort in Deutschland oder lat,lng.",
      400,
    );
  }

  const viaValhalla = await callValhalla(origin, destination, profile);

  if (viaValhalla) {
    return toRoutePlan(origin, destination, profile, "valhalla", viaValhalla);
  }

  const viaOsrm = await callOsrm(origin, destination, profile);

  if (viaOsrm) {
    return toRoutePlan(origin, destination, profile, "osrm", viaOsrm);
  }

  if (profile === "truck") {
    throw new RoutePlanningError(
      "LKW-Routing ist aktuell nicht konfiguriert. Setze VALHALLA_URL fuer echte Truck-Routen.",
      503,
    );
  }

  throw new RoutePlanningError(
    "Die Route konnte ueber keinen Routing-Dienst berechnet werden.",
    503,
  );
}
