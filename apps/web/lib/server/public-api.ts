import {
  findCandidatesForRoute,
  getCpoList,
  getStationDetail,
  routePlanSchema,
  routeProfileSchema,
  routeBounds,
  routeDistanceKm,
  type CandidateFilters,
  type RoutePlan,
} from "@adhoc/shared";

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

export function buildCandidateResponse(route: RoutePlan, filters: CandidateFilters) {
  const results = findCandidatesForRoute(route, filters);

  return {
    route,
    filters,
    candidates: results.candidates,
    providerList: results.providerList,
    priceBand: results.priceBand,
  };
}

export function listCpos() {
  return getCpoList();
}

export function loadStationDetail(stationId: string) {
  return getStationDetail(stationId);
}
