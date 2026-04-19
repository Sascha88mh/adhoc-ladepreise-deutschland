import {
  findCandidatesForRoute,
  findStationsInView,
  getCpoList,
  resolveLocation,
  getStationDetail,
  routePlanSchema,
  routeProfileSchema,
  routeBounds,
  routeDistanceKm,
  type CandidateFilters,
  type RoutePlan,
} from "@adhoc/shared";
import { listStationRecordsDb, usingDatabase } from "@adhoc/shared/db";

export function createRouteFromPolyline(polyline: RoutePlan["geometry"], routeId?: string) {
  return routePlanSchema.parse({
    routeId: routeId ?? `polyline-${Date.now()}`,
    profile: routeProfileSchema.parse("auto"),
    corridorKm: 5,
    origin: {
      label: "Custom origin",
      coordinates: polyline[0],
    },
    destination: {
      label: "Custom destination",
      coordinates: polyline[polyline.length - 1],
    },
    geometry: polyline,
    distanceKm: routeDistanceKm(polyline),
    durationMinutes: Math.max(1, Math.round(routeDistanceKm(polyline) / 84 * 60)),
    bounds: routeBounds(polyline),
    alternatives: [],
  });
}

export async function createLocationFocusRoute(query: string) {
  const location = await resolveLocation(query);

  if (!location) {
    throw new Error("Standort konnte nicht aufgeloest werden.");
  }

  const geometry = [
    {
      lat: location.coordinates.lat,
      lng: location.coordinates.lng - 0.008,
    },
    {
      lat: location.coordinates.lat,
      lng: location.coordinates.lng + 0.008,
    },
  ];

  return routePlanSchema.parse({
    routeId: `focus-${Date.now()}`,
    profile: routeProfileSchema.parse("auto"),
    corridorKm: 5,
    origin: location,
    destination: {
      label: "Umgebung",
      city: location.city,
      coordinates: location.coordinates,
    },
    geometry,
    distanceKm: Math.max(0.1, routeDistanceKm(geometry)),
    durationMinutes: 1,
    bounds: routeBounds(geometry),
    alternatives: [],
  });
}

async function stationRecords() {
  if (!usingDatabase()) {
    return undefined;
  }

  return listStationRecordsDb();
}

export async function buildCandidateResponse(route: RoutePlan, filters: CandidateFilters) {
  const effectiveRoute =
    filters.corridorKm && filters.corridorKm !== route.corridorKm
      ? routePlanSchema.parse({
          ...route,
          corridorKm: filters.corridorKm,
        })
      : route;
  const results = findCandidatesForRoute(
    effectiveRoute,
    filters,
    (await stationRecords()) ?? undefined,
  );

  return {
    route: effectiveRoute,
    filters,
    candidates: results.candidates,
    providerList: results.providerList,
    priceBand: results.priceBand,
  };
}

export async function listCpos() {
  return getCpoList((await stationRecords()) ?? undefined);
}

export async function loadStationDetail(stationId: string) {
  return getStationDetail(stationId, (await stationRecords()) ?? undefined);
}

export async function listMapStations(
  bounds: { minLat: number; minLng: number; maxLat: number; maxLng: number },
  filters: CandidateFilters,
) {
  return findStationsInView(bounds, filters, (await stationRecords()) ?? undefined);
}
