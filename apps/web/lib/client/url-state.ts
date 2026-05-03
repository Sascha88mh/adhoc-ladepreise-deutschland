import { candidateFiltersSchema, type CandidateFilters } from "@adhoc/shared";

export type StoredMapViewport = {
  lat: number;
  lng: number;
  zoom: number;
  bearing: number;
  pitch: number;
};

export type StoredMapMode = "light" | "dark" | "color" | "satellite";

export type RoutePlannerUrlState = {
  mode: "location" | "route";
  filters: CandidateFilters;
  mapViewport: StoredMapViewport | null;
  style: StoredMapMode;
  stationId: string | null;
  location:
    | {
        lat: number;
        lng: number;
        label: string;
      }
    | null;
  route:
    | {
        origin: string;
        originLabel: string;
        destination: string;
        destinationLabel: string;
      }
    | null;
};

export type RoutePlannerUrlWriteState = {
  mode: "location" | "route";
  filters: CandidateFilters;
  mapViewport: StoredMapViewport | null;
  style: StoredMapMode;
  stationId: string | null;
  location: {
    query: string;
    label: string;
  };
  route: {
    origin: string;
    originLabel: string;
    destination: string;
    destinationLabel: string;
  };
};

const MAP_MODES = new Set<StoredMapMode>(["light", "dark", "color", "satellite"]);

function finiteNumber(value: string | null) {
  if (value == null || value.trim() === "") {
    return null;
  }

  const parsed = Number(value);
  return Number.isFinite(parsed) ? parsed : null;
}

function bounded(value: number, min: number, max: number) {
  return Math.min(max, Math.max(min, value));
}

function parseCoordinatePair(value: string) {
  const match = value.match(/^\s*(-?\d+(?:\.\d+)?)\s*,\s*(-?\d+(?:\.\d+)?)\s*$/);
  if (!match) {
    return null;
  }

  const lat = Number(match[1]);
  const lng = Number(match[2]);
  if (!Number.isFinite(lat) || !Number.isFinite(lng)) {
    return null;
  }

  if (lat < -90 || lat > 90 || lng < -180 || lng > 180) {
    return null;
  }

  return { lat, lng };
}

function parseMapViewport(value: string | null): StoredMapViewport | null {
  if (!value) {
    return null;
  }

  const parts = value.split(",").map((part) => Number(part));
  if (parts.length !== 5 || parts.some((part) => !Number.isFinite(part))) {
    return null;
  }

  const [lat, lng, zoom, bearing, pitch] = parts;
  if (lat < -90 || lat > 90 || lng < -180 || lng > 180) {
    return null;
  }

  return {
    lat,
    lng,
    zoom: bounded(zoom, 0, 22),
    bearing,
    pitch: bounded(pitch, 0, 85),
  };
}

function parseFilters(value: string | null): CandidateFilters {
  if (!value) {
    return {};
  }

  try {
    const parsed = candidateFiltersSchema.safeParse(JSON.parse(value));
    return parsed.success ? compactFilters(parsed.data) : {};
  } catch {
    return {};
  }
}

function compactFilters(filters: CandidateFilters): CandidateFilters {
  return Object.fromEntries(
    Object.entries(filters).filter(([, value]) => {
      if (value == null) {
        return false;
      }

      if (Array.isArray(value)) {
        return value.length > 0;
      }

      return true;
    }),
  ) as CandidateFilters;
}

function formatNumber(value: number, decimals: number) {
  return Number(value.toFixed(decimals)).toString();
}

function formatMapViewport(viewport: StoredMapViewport) {
  return [
    formatNumber(viewport.lat, 6),
    formatNumber(viewport.lng, 6),
    formatNumber(viewport.zoom, 3),
    formatNumber(viewport.bearing, 2),
    formatNumber(viewport.pitch, 2),
  ].join(",");
}

export function readRoutePlannerUrlState(): RoutePlannerUrlState | null {
  if (typeof window === "undefined") {
    return null;
  }

  const params = new URLSearchParams(window.location.search);
  const modeParam = params.get("mode");
  if (modeParam !== "location" && modeParam !== "route") {
    return null;
  }
  const mode: "location" | "route" = modeParam;

  const styleParam = params.get("style");
  const style: StoredMapMode =
    styleParam && MAP_MODES.has(styleParam as StoredMapMode)
      ? (styleParam as StoredMapMode)
      : "light";

  const base = {
    mode,
    filters: parseFilters(params.get("filters")),
    mapViewport: parseMapViewport(params.get("map")),
    style,
    stationId: params.get("station")?.trim() || null,
  };

  if (mode === "location") {
    const lat = finiteNumber(params.get("lat"));
    const lng = finiteNumber(params.get("lng"));
    if (lat == null || lng == null || lat < -90 || lat > 90 || lng < -180 || lng > 180) {
      return null;
    }

    return {
      ...base,
      location: {
        lat,
        lng,
        label: params.get("label")?.trim() || `${formatNumber(lat, 5)}, ${formatNumber(lng, 5)}`,
      },
      route: null,
    };
  }

  const origin = params.get("origin")?.trim() ?? "";
  const destination = params.get("destination")?.trim() ?? "";
  if (!origin || !destination) {
    return null;
  }

  return {
    ...base,
    location: null,
    route: {
      origin,
      originLabel: params.get("originLabel")?.trim() || origin,
      destination,
      destinationLabel: params.get("destinationLabel")?.trim() || destination,
    },
  };
}

export function writeRoutePlannerUrlState(state: RoutePlannerUrlWriteState) {
  if (typeof window === "undefined") {
    return;
  }

  const params = new URLSearchParams();
  params.set("mode", state.mode);

  if (state.mode === "location") {
    const coordinates = parseCoordinatePair(state.location.query);
    if (!coordinates) {
      return;
    }

    params.set("lat", formatNumber(coordinates.lat, 6));
    params.set("lng", formatNumber(coordinates.lng, 6));
    if (state.location.label.trim()) {
      params.set("label", state.location.label.trim());
    }
  } else {
    if (!state.route.origin.trim() || !state.route.destination.trim()) {
      return;
    }

    params.set("origin", state.route.origin.trim());
    params.set("destination", state.route.destination.trim());
    if (state.route.originLabel.trim() && state.route.originLabel.trim() !== state.route.origin.trim()) {
      params.set("originLabel", state.route.originLabel.trim());
    }
    if (
      state.route.destinationLabel.trim() &&
      state.route.destinationLabel.trim() !== state.route.destination.trim()
    ) {
      params.set("destinationLabel", state.route.destinationLabel.trim());
    }
  }

  const filters = compactFilters(state.filters);
  if (Object.keys(filters).length > 0) {
    params.set("filters", JSON.stringify(filters));
  }

  if (state.mapViewport) {
    params.set("map", formatMapViewport(state.mapViewport));
  }

  if (state.style !== "light") {
    params.set("style", state.style);
  }

  if (state.stationId) {
    params.set("station", state.stationId);
  }

  const nextUrl = `${window.location.pathname}?${params.toString()}${window.location.hash}`;
  const currentUrl = `${window.location.pathname}${window.location.search}${window.location.hash}`;
  if (nextUrl !== currentUrl) {
    window.history.replaceState(window.history.state, "", nextUrl);
  }
}
