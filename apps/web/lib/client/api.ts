import {
  adminStationRecordSchema,
  publicLocationSuggestionsResponseSchema,
  publicMapStationsResponseSchema,
  publicCandidatesResponseSchema,
  publicReverseLocationResponseSchema,
  publicRoutePlanResponseSchema,
  stationOverridesResponseSchema,
  stationDetailResponseSchema,
  type AdminStationRecord,
  type CandidateFilters,
  type FeedConfig,
  type LocationSuggestion,
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
    let message = `Request failed with ${response.status}`;

    try {
      const payload = (await response.json()) as { error?: string };
      if (payload.error) {
        message = payload.error;
      }
    } catch {
      // Ignore non-JSON errors and keep the HTTP status message.
    }

    throw new Error(message);
  }

  return (await response.json()) as T;
}

export async function fetchRoutePlan(payload: {
  origin: string;
  destination: string;
  profile?: "auto";
}): Promise<RoutePlan> {
  const response = await requestJson<unknown>("/api/public/routes/plan", {
    method: "POST",
    body: JSON.stringify(payload),
  });

  return publicRoutePlanResponseSchema.parse(response).data;
}

export async function fetchLocationSuggestions(query: string): Promise<LocationSuggestion[]> {
  const params = new URLSearchParams({ query });
  const response = await requestJson<unknown>(`/api/public/locations/suggest?${params.toString()}`);
  return publicLocationSuggestionsResponseSchema.parse(response).data;
}

export async function fetchLocationFocus(query: string): Promise<RoutePlan> {
  const response = await requestJson<unknown>("/api/public/locations/focus", {
    method: "POST",
    body: JSON.stringify({ query }),
  });

  return publicRoutePlanResponseSchema.parse(response).data;
}

export async function fetchReverseLocation(lat: number, lng: number): Promise<LocationSuggestion> {
  const params = new URLSearchParams({
    lat: String(lat),
    lng: String(lng),
  });
  const response = await requestJson<unknown>(`/api/public/locations/reverse?${params.toString()}`);
  return publicReverseLocationResponseSchema.parse(response).data;
}

export async function fetchIpLocation(): Promise<LocationSuggestion> {
  const response = await requestJson<unknown>("/api/public/locations/ip");
  return publicReverseLocationResponseSchema.parse(response).data;
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

export async function fetchMapStations(payload: {
  bounds: { minLat: number; minLng: number; maxLat: number; maxLng: number };
  filters: CandidateFilters;
}) {
  const response = await requestJson<unknown>("/api/public/stations/map", {
    method: "POST",
    body: JSON.stringify(payload),
  });

  return publicMapStationsResponseSchema.parse(response).data;
}

export async function fetchStationDetail(stationId: string): Promise<StationDetail> {
  const response = await requestJson<unknown>(`/api/public/stations/${stationId}`);
  return stationDetailResponseSchema.parse(response).data;
}

export async function fetchAdminFeeds(): Promise<FeedConfig[]> {
  const response = await requestJson<{ data: FeedConfig[] }>("/api/admin/feeds");
  return response.data;
}

export async function createAdminFeed(
  input: Omit<
    FeedConfig,
    | "id"
    | "lastSuccessAt"
    | "lastSnapshotAt"
    | "lastDeltaCount"
    | "errorRate"
    | "cursorState"
    | "lastErrorMessage"
    | "consecutiveFailures"
  >,
) {
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

export async function terminateFeedRun(id: string) {
  const response = await requestJson<{ data: { terminatedPids: number[]; updatedRuns: number } }>(
    `/api/admin/feeds/${id}/terminate`,
    {
      method: "POST",
    },
  );
  return response.data;
}

export async function fetchSyncRuns(): Promise<SyncRun[]> {
  const response = await requestJson<{ data: SyncRun[] }>("/api/admin/sync-runs");
  return response.data;
}

export async function cleanupStuckSyncRuns() {
  return requestJson<{ cleaned: number }>("/api/admin/sync-runs", {
    method: "DELETE",
  });
}

export async function searchAdminStations(query: string): Promise<AdminStationRecord[]> {
  const params = new URLSearchParams({ query });
  const response = await requestJson<unknown>(`/api/admin/stations?${params.toString()}`);
  return stationOverridesResponseSchema.parse(response).data;
}

export async function saveStationOverride(
  stationId: string,
  payload: {
    displayName: string | null;
    addressLine: string | null;
    city: string | null;
    postalCode: string | null;
    maxPowerKw: number | null;
    isHidden: boolean;
    adminNote: string | null;
  },
) {
  const response = await requestJson<unknown>(`/api/admin/stations/${stationId}/override`, {
    method: "PATCH",
    body: JSON.stringify(payload),
  });

  return adminStationRecordSchema.parse((response as { data: unknown }).data);
}

export async function deleteStationOverride(stationId: string) {
  await requestJson(`/api/admin/stations/${stationId}/override`, {
    method: "DELETE",
  });
}

export function priceLabel(candidate: RouteCandidate) {
  return candidate.tariffSummary.pricePerKwh != null
    ? `${candidate.tariffSummary.pricePerKwh.toFixed(2).replace(".", ",")} €/kWh`
    : "Preis offen";
}
