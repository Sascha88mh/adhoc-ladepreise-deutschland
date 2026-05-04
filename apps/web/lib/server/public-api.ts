import {
  findCandidatesForRoute,
  findStationsInView,
  summarizeStationStats,
  resolveLocation,
  getStationDetail,
  routePlanSchema,
  routeProfileSchema,
  routeBounds,
  routeDistanceKm,
  type CandidateFilters,
  type RouteCandidate,
  type RoutePlan,
} from "@adhoc/shared";
import {
  listStationRecordsDb,
  listStationRecordsInBoundsDb,
  listStationRecordsNearRouteDb,
  listCpoSummariesDb,
  loadChargePointRowsDb,
  usingDatabase,
} from "@adhoc/shared/db";

const MAX_ROUTE_CANDIDATES = 80;
const MAX_ROUTE_CANDIDATES_FOR_ROUTING = 160;
const ROUTING_CONCURRENCY = 6;
const CPO_CACHE_TTL_MS = 5 * 60_000;
const ROUTE_CANDIDATE_CACHE_TTL_MS = 60_000;
const ROUTE_CANDIDATE_CACHE_MAX = 50;
let cpoCache:
  | {
      expiresAt: number;
      data: Array<{ id: string; name: string; stations: number }>;
    }
  | null = null;
const routeCandidateCache = new Map<
  string,
  {
    expiresAt: number;
    data: Awaited<ReturnType<typeof buildCandidateResponseUncached>>;
  }
>();
const OSRM_URL = process.env.OSRM_URL ?? "https://router.project-osrm.org";

type OsrmViaRouteResponse = {
  routes?: Array<{
    distance?: number;
    duration?: number;
    legs?: Array<{
      distance?: number;
      duration?: number;
    }>;
  }>;
};

function requirePublicDatabase() {
  if (!usingDatabase()) {
    throw new Error("Die öffentliche App benötigt APP_DATA_SOURCE=db und eine erreichbare Datenbank.");
  }
}

export function createRouteFromPolyline(polyline: RoutePlan["geometry"], routeId?: string) {
  return routePlanSchema.parse({
    routeId: routeId ?? `polyline-${Date.now()}`,
    profile: routeProfileSchema.parse("auto"),
    corridorKm: 0.5,
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
    corridorKm: 0.5,
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

function simplifyRouteForDbPrefilter(points: RoutePlan["geometry"]) {
  const maxPoints = 160;
  if (points.length <= maxPoints) {
    return points;
  }

  const step = Math.ceil(points.length / maxPoints);
  const simplified = points.filter((_, index) => index % step === 0);
  const last = points[points.length - 1];

  if (simplified[simplified.length - 1] !== last) {
    simplified.push(last);
  }

  return simplified;
}

function stableCachePart(value: unknown): string {
  if (Array.isArray(value)) {
    return `[${value.map(stableCachePart).join(",")}]`;
  }

  if (value && typeof value === "object") {
    return `{${Object.entries(value)
      .sort(([left], [right]) => left.localeCompare(right))
      .map(([key, entry]) => `${JSON.stringify(key)}:${stableCachePart(entry)}`)
      .join(",")}}`;
  }

  return JSON.stringify(value);
}

function routeCandidateCacheKey(route: RoutePlan, filters: CandidateFilters) {
  return [
    "route-candidates:v2",
    route.routeId,
    route.corridorKm,
    route.geometry.length,
    stableCachePart(filters),
  ].join(":");
}

async function mapWithConcurrency<TInput, TOutput>(
  items: TInput[],
  concurrency: number,
  mapper: (item: TInput) => Promise<TOutput>,
) {
  const results = new Array<TOutput>(items.length);
  let nextIndex = 0;

  async function worker() {
    while (nextIndex < items.length) {
      const index = nextIndex;
      nextIndex += 1;
      results[index] = await mapper(items[index]);
    }
  }

  await Promise.all(
    Array.from({ length: Math.min(concurrency, items.length) }, () => worker()),
  );

  return results;
}

async function addRoadMetrics(route: RoutePlan, candidate: RouteCandidate): Promise<RouteCandidate> {
  if (route.profile !== "auto") {
    return candidate;
  }

  try {
    const origin = route.origin.coordinates;
    const destination = route.destination.coordinates;
    const coordinates = [
      `${origin.lng},${origin.lat}`,
      `${candidate.lng},${candidate.lat}`,
      `${destination.lng},${destination.lat}`,
    ].join(";");
    const url = new URL(`/route/v1/driving/${coordinates}`, OSRM_URL);
    url.searchParams.set("overview", "false");
    url.searchParams.set("alternatives", "false");
    url.searchParams.set("steps", "false");

    const response = await fetch(url, {
      headers: { accept: "application/json" },
      cache: "no-store",
    });

    if (!response.ok) {
      return candidate;
    }

    const payload = (await response.json()) as OsrmViaRouteResponse;
    const viaRoute = payload.routes?.[0];
    if (!viaRoute?.distance || !viaRoute.duration) {
      return candidate;
    }

    const viaDistanceKm = viaRoute.distance / 1000;
    const viaDurationMinutes = viaRoute.duration / 60;
    const distanceFromStartKm = (viaRoute.legs?.[0]?.distance ?? 0) / 1000;
    const detourDistanceKm = Math.max(0, viaDistanceKm - route.distanceKm);
    const distanceFromRouteKm = detourDistanceKm / 2;
    const detourMinutes = Math.max(0, Math.round(viaDurationMinutes - route.durationMinutes));

    return {
      ...candidate,
      distanceFromRouteKm: Number(distanceFromRouteKm.toFixed(2)),
      distanceFromStartKm: Number(
        (distanceFromStartKm || candidate.distanceFromStartKm).toFixed(1),
      ),
      detourMinutes,
    };
  } catch {
    return candidate;
  }
}

function summarizeRouteCandidates(candidates: RouteCandidate[]) {
  const providerMap = new Map<string, { cpoId: string; cpoName: string; stations: number }>();
  const pricePoints: number[] = [];

  for (const candidate of candidates) {
    const provider = providerMap.get(candidate.cpoId);
    if (provider) {
      provider.stations += 1;
    } else {
      providerMap.set(candidate.cpoId, {
        cpoId: candidate.cpoId,
        cpoName: candidate.cpoName,
        stations: 1,
      });
    }

    if (candidate.tariffSummary.pricePerKwh != null) {
      pricePoints.push(candidate.tariffSummary.pricePerKwh);
    }
  }

  return {
    providerList: [...providerMap.values()].sort((left, right) => right.stations - left.stations),
    priceBand: {
      min: pricePoints.length ? Math.min(...pricePoints) : null,
      max: pricePoints.length ? Math.max(...pricePoints) : null,
    },
  };
}

async function buildCandidateResponseUncached(route: RoutePlan, filters: CandidateFilters) {
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
    { ...filters, sort: "route" },
    await listStationRecordsNearRouteDb(
      expandedRouteBounds(effectiveRoute),
      {
        points: simplifyRouteForDbPrefilter(effectiveRoute.geometry),
        corridorKm: effectiveRoute.corridorKm + 1,
        rowLimit: 500,
      },
    ),
  );
  const routedCandidates = await mapWithConcurrency(
    results.candidates.slice(0, MAX_ROUTE_CANDIDATES_FOR_ROUTING),
    ROUTING_CONCURRENCY,
    (candidate) => addRoadMetrics(effectiveRoute, candidate),
  );
  const sortedCandidates = routedCandidates
    .filter((candidate) => candidate.distanceFromRouteKm <= effectiveRoute.corridorKm)
    .sort(
      (left, right) =>
        left.distanceFromStartKm - right.distanceFromStartKm ||
        left.detourMinutes - right.detourMinutes ||
        (left.tariffSummary.pricePerKwh ?? Number.POSITIVE_INFINITY) -
          (right.tariffSummary.pricePerKwh ?? Number.POSITIVE_INFINITY),
    );
  const limitedCandidates = sortedCandidates.slice(0, MAX_ROUTE_CANDIDATES);
  const summary = summarizeRouteCandidates(sortedCandidates);

  return {
    route: effectiveRoute,
    filters,
    candidates: limitedCandidates,
    totalCandidateCount: sortedCandidates.length,
    providerList: summary.providerList,
    priceBand: summary.priceBand,
  };
}

export async function buildCandidateResponse(route: RoutePlan, filters: CandidateFilters) {
  const key = routeCandidateCacheKey(route, filters);
  const now = Date.now();
  const cached = routeCandidateCache.get(key);

  if (cached && cached.expiresAt > now) {
    return cached.data;
  }

  const data = await buildCandidateResponseUncached(route, filters);
  routeCandidateCache.set(key, {
    data,
    expiresAt: now + ROUTE_CANDIDATE_CACHE_TTL_MS,
  });

  if (routeCandidateCache.size > ROUTE_CANDIDATE_CACHE_MAX) {
    const oldestKey = routeCandidateCache.keys().next().value;
    if (oldestKey) {
      routeCandidateCache.delete(oldestKey);
    }
  }

  return data;
}

export async function listCpos() {
  requirePublicDatabase();
  const now = Date.now();
  if (cpoCache && cpoCache.expiresAt > now) {
    return cpoCache.data;
  }

  const data = await listCpoSummariesDb();
  cpoCache = {
    data,
    expiresAt: now + CPO_CACHE_TTL_MS,
  };
  return data;
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

export async function loadMapStationStats(
  bounds: { minLat: number; minLng: number; maxLat: number; maxLng: number },
  filters: CandidateFilters,
) {
  return summarizeStationStats(await listMapStations(bounds, filters));
}
