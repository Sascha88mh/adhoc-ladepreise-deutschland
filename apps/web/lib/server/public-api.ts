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
import {
  listStationRecordsDb,
  listStationRecordsInBoundsDb,
  loadChargePointRowsDb,
  usingDatabase,
} from "@adhoc/shared/db";

function requirePublicDatabase() {
  if (!usingDatabase()) {
    throw new Error("Die öffentliche App benötigt APP_DATA_SOURCE=db und eine erreichbare Datenbank.");
  }
}

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
  requirePublicDatabase();
  return listStationRecordsDb();
}

function expandedRouteBounds(route: RoutePlan) {
  const latPadding = route.corridorKm / 111;
  const midLat = (route.bounds.minLat + route.bounds.maxLat) / 2;
  const lngKm = Math.max(20, 111 * Math.cos((Math.abs(midLat) * Math.PI) / 180));
  const lngPadding = route.corridorKm / lngKm;

  return {
    minLat: route.bounds.minLat - latPadding,
    minLng: route.bounds.minLng - lngPadding,
    maxLat: route.bounds.maxLat + latPadding,
    maxLng: route.bounds.maxLng + lngPadding,
  };
}

export async function buildCandidateResponse(route: RoutePlan, filters: CandidateFilters) {
  requirePublicDatabase();
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
    await listStationRecordsInBoundsDb(expandedRouteBounds(effectiveRoute)),
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
  return getCpoList(await stationRecords());
}

export async function loadStationDetail(stationId: string) {
  requirePublicDatabase();
  const [stations, cpRows] = await Promise.all([
    listStationRecordsDb(stationId),
    loadChargePointRowsDb(stationId),
  ]);

  const chargePoints = cpRows.map((row) => ({
    code: row.charge_point_code,
    currentType: row.current_type as "AC" | "DC",
    maxPowerKw: row.max_power_kw,
    status: row.last_status_canonical as
      | "AVAILABLE"
      | "CHARGING"
      | "RESERVED"
      | "BLOCKED"
      | "OUT_OF_SERVICE"
      | "MAINTENANCE"
      | "UNKNOWN",
    connectors: (row.connector_types ?? []).map((type, i) => ({
      type,
      maxPowerKw: (row.connector_powers ?? [])[i] ?? null,
    })),
  }));

  return getStationDetail(stationId, stations, chargePoints);
}

export async function listMapStations(
  bounds: { minLat: number; minLng: number; maxLat: number; maxLng: number },
  filters: CandidateFilters,
) {
  requirePublicDatabase();
  return findStationsInView(bounds, filters, await listStationRecordsInBoundsDb(bounds));
}
