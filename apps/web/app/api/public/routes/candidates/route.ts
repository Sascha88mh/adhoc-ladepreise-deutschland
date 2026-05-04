import { routeCandidatesRequestSchema, type CandidateFilters, type RoutePlan } from "@adhoc/shared";
import { isRetryableDbError, resetPool } from "@adhoc/shared/db";
import { buildCandidateResponse, createRouteFromPolyline } from "@/lib/server/public-api";
import { getRoutePlan, storeRoutePlan } from "@/lib/server/route-cache";

const CANDIDATE_DB_TIMEOUT_MS = Number(process.env.ROUTE_CANDIDATE_DB_TIMEOUT_MS ?? 6000);

function emptyCandidateResponse(
  route: RoutePlan,
  filters: CandidateFilters,
) {
  return {
    route,
    filters,
    candidates: [],
    totalCandidateCount: 0,
    providerList: [],
    priceBand: { min: null, max: null },
  };
}

function timeoutAfter(ms: number) {
  let timer: ReturnType<typeof setTimeout>;
  const promise = new Promise<never>((_, reject) => {
    timer = setTimeout(() => {
      reject(new Error(`Route candidate database query timed out after ${ms}ms`));
    }, ms);
  });

  return {
    promise,
    clear: () => clearTimeout(timer),
  };
}

export async function POST(request: Request) {
  const body = routeCandidatesRequestSchema.parse(await request.json());
  const route =
    (body.routeId ? getRoutePlan(body.routeId) : null) ??
    (body.polyline ? createRouteFromPolyline(body.polyline, body.routeId) : null);

  if (!route) {
    return Response.json({ error: "Route not found" }, { status: 404 });
  }

  storeRoutePlan(route);

  const candidatesPromise = buildCandidateResponse(route, body.filters ?? {});
  const timeout = timeoutAfter(CANDIDATE_DB_TIMEOUT_MS);

  try {
    return Response.json({
      data: await Promise.race([candidatesPromise, timeout.promise]),
    });
  } catch (error) {
    candidatesPromise.catch(() => undefined);

    if (isRetryableDbError(error)) {
      void resetPool();
    }

    console.warn("[routes/candidates] returning empty results after database error", {
      routeId: route.routeId,
      error,
    });

    return Response.json({
      data: emptyCandidateResponse(route, body.filters ?? {}),
    });
  } finally {
    timeout.clear();
  }
}
