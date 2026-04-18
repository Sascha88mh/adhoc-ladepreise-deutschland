import type { Coordinate, RouteLocation, RoutePlan, RouteProfile } from "./types";
import { routePlanSchema } from "./types";
import { resolveLocation } from "../geo/geocoder";
import { routeBounds } from "../geo/route-corridor";
import { routeDistanceKm } from "../geo/haversine";

function createId(parts: string[]) {
  const input = parts.join("|");
  let hash = 0;

  for (let index = 0; index < input.length; index += 1) {
    hash = (hash << 5) - hash + input.charCodeAt(index);
    hash |= 0;
  }

  return `route-${Math.abs(hash).toString(36)}`;
}

function lerp(from: number, to: number, ratio: number) {
  return from + (to - from) * ratio;
}

function buildDemoGeometry(origin: Coordinate, destination: Coordinate): Coordinate[] {
  const points: Coordinate[] = [];

  for (let index = 0; index < 18; index += 1) {
    const ratio = index / 17;
    points.push({
      lat: lerp(origin.lat, destination.lat, ratio) + Math.sin(ratio * Math.PI) * 0.02,
      lng: lerp(origin.lng, destination.lng, ratio),
    });
  }

  points[0] = origin;
  points[points.length - 1] = destination;
  return points;
}

async function callValhalla(
  origin: RouteLocation,
  destination: RouteLocation,
  profile: RouteProfile,
): Promise<RoutePlan | null> {
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

    const payload = (await response.json()) as {
      trip?: {
        summary?: { length?: number; time?: number };
        legs?: Array<{ shape?: { coordinates?: Array<[number, number]> } }>;
      };
    };

    const coordinates =
      payload.trip?.legs?.flatMap((leg) =>
        (leg.shape?.coordinates ?? []).map(([lng, lat]) => ({ lat, lng })),
      ) ?? [];

    if (coordinates.length < 2) {
      return null;
    }

    return routePlanSchema.parse({
      routeId: createId([origin.label, destination.label, profile, "valhalla"]),
      profile,
      corridorKm: 5,
      origin,
      destination,
      geometry: coordinates,
      distanceKm: payload.trip?.summary?.length ?? routeDistanceKm(coordinates),
      durationMinutes: Math.max(
        1,
        Math.round(((payload.trip?.summary?.time ?? 0) / 60) || routeDistanceKm(coordinates) * 0.8),
      ),
      bounds: routeBounds(coordinates),
      alternatives: [],
    });
  } catch {
    return null;
  }
}

export async function planRoute(
  originInput: string,
  destinationInput: string,
  profile: RouteProfile = "auto",
) {
  const origin = resolveLocation(originInput);
  const destination = resolveLocation(destinationInput);

  if (!origin || !destination) {
    throw new Error("Origin or destination could not be resolved. Use a major German city or lat,lng.");
  }

  const viaValhalla = await callValhalla(origin, destination, profile);

  if (viaValhalla) {
    return viaValhalla;
  }

  const geometry = buildDemoGeometry(origin.coordinates, destination.coordinates);
  const distanceKm = routeDistanceKm(geometry);

  return routePlanSchema.parse({
    routeId: createId([origin.label, destination.label, profile]),
    profile,
    corridorKm: 5,
    origin,
    destination,
    geometry,
    distanceKm,
    durationMinutes: Math.max(1, Math.round(distanceKm / (profile === "truck" ? 68 : 86) * 60)),
    bounds: routeBounds(geometry),
    alternatives: [
      {
        id: createId([origin.label, destination.label, "balanced"]),
        label: "Balanced",
        distanceKm,
        durationMinutes: Math.max(1, Math.round(distanceKm / 84 * 60)),
      },
    ],
  });
}
