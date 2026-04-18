import {
  publicCandidatesResponseSchema,
  publicRoutePlanResponseSchema,
  stationDetailResponseSchema,
  type CandidateFilters,
  type FeedConfig,
  type RouteCandidate,
  type RoutePlan,
  type StationDetail,
  type SyncRun,
} from "@adhoc/shared";

async function requestJson<T>(input: RequestInfo, init?: RequestInit) {
  const response = await fetch(input, {
    ...init,
    headers: {
      "content-type": "application/json",
      ...(init?.headers ?? {}),
    },
  });

  if (!response.ok) {
    throw new Error(`Request failed with ${response.status}`);
  }

  return (await response.json()) as T;
}

export async function fetchRoutePlan(payload: {
  origin: string;
  destination: string;
  profile: "auto" | "truck";
}): Promise<RoutePlan> {
  const response = await requestJson<unknown>("/api/public/routes/plan", {
    method: "POST",
    body: JSON.stringify(payload),
  });

  return publicRoutePlanResponseSchema.parse(response).data;
}

export async function fetchRouteCandidates(payload: {
  routeId: string;
  polyline: RoutePlan["geometry"];
  filters: CandidateFilters;
}) {
  const response = await requestJson<unknown>("/api/public/routes/candidates", {
    method: "POST",
    body: JSON.stringify(payload),
  });

  return publicCandidatesResponseSchema.parse(response).data;
}

export async function fetchStationDetail(stationId: string): Promise<StationDetail> {
  const response = await requestJson<unknown>(`/api/public/stations/${stationId}`);
  return stationDetailResponseSchema.parse(response).data;
}

export async function fetchAdminFeeds(): Promise<FeedConfig[]> {
  const response = await requestJson<{ data: FeedConfig[] }>("/api/admin/feeds");
  return response.data;
}

export async function createAdminFeed(input: Omit<FeedConfig, "id" | "lastSuccessAt" | "lastSnapshotAt" | "lastDeltaCount" | "errorRate">) {
  const response = await requestJson<{ data: FeedConfig }>("/api/admin/feeds", {
    method: "POST",
    body: JSON.stringify(input),
  });
  return response.data;
}

export async function updateAdminFeed(id: string, patch: Partial<FeedConfig>) {
  const response = await requestJson<{ data: FeedConfig }>(`/api/admin/feeds/${id}`, {
    method: "PATCH",
    body: JSON.stringify(patch),
  });
  return response.data;
}

export async function deleteAdminFeed(id: string) {
  await requestJson(`/api/admin/feeds/${id}`, {
    method: "DELETE",
  });
}

export async function triggerFeedAction(id: string, action: "test" | "sync") {
  const response = await requestJson<{ data: SyncRun }>(`/api/admin/feeds/${id}/${action}`, {
    method: "POST",
  });
  return response.data;
}

export async function fetchSyncRuns(): Promise<SyncRun[]> {
  const response = await requestJson<{ data: SyncRun[] }>("/api/admin/sync-runs");
  return response.data;
}

export function priceLabel(candidate: RouteCandidate) {
  return candidate.tariffSummary.pricePerKwh != null
    ? `${candidate.tariffSummary.pricePerKwh.toFixed(2).replace(".", ",")} €/kWh`
    : "Preis offen";
}
