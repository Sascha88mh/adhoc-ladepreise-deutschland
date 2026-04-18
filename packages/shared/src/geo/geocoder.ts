import type { LocationSuggestion, RouteLocation } from "../domain/types";
import { DEMO_LOCATIONS } from "../fixtures/locations";

type NominatimResult = {
  place_id?: string | number;
  lat: string;
  lon: string;
  name?: string;
  display_name?: string;
  address?: {
    city?: string;
    town?: string;
    village?: string;
    municipality?: string;
    county?: string;
  };
};

type NominatimReverseResult = NominatimResult;

const NOMINATIM_URL =
  process.env.NOMINATIM_URL ?? "https://nominatim.openstreetmap.org";
const NOMINATIM_USER_AGENT =
  process.env.OSM_GEOCODER_USER_AGENT ?? "AdhocPlattform/0.1";

function normalize(input: string) {
  return input
    .trim()
    .toLowerCase()
    .normalize("NFD")
    .replace(/\p{Diacritic}/gu, "");
}

function fromCoordinateInput(input: string): RouteLocation | null {
  const match = input.match(
    /^\s*(-?\d+(?:\.\d+)?)\s*,\s*(-?\d+(?:\.\d+)?)\s*$/,
  );

  if (!match) {
    return null;
  }

  return {
    label: input.trim(),
    coordinates: {
      lat: Number(match[1]),
      lng: Number(match[2]),
    },
  };
}

function fromFixtureExact(input: string) {
  const normalized = normalize(input);
  return (
    DEMO_LOCATIONS.find((location) => normalize(location.label) === normalized) ??
    null
  );
}

function fromFixturePartial(input: string) {
  const normalized = normalize(input);
  return (
    DEMO_LOCATIONS.find(
      (location) =>
        normalize(location.label).includes(normalized) ||
        normalize(location.city ?? "").includes(normalized),
    ) ?? null
  );
}

function toRouteLocation(input: string, result: NominatimResult): RouteLocation {
  const label =
    result.name?.trim() ||
    result.display_name?.split(",")[0]?.trim() ||
    input.trim();

  return {
    label,
    city:
      result.address?.city ??
      result.address?.town ??
      result.address?.village ??
      result.address?.municipality ??
      result.address?.county,
    coordinates: {
      lat: Number(result.lat),
      lng: Number(result.lon),
    },
  };
}

function toLocationSuggestion(result: NominatimResult, index: number): LocationSuggestion {
  const displayName = result.display_name?.trim() ?? result.name?.trim() ?? "Ort";
  const [primary, ...rest] = displayName
    .split(",")
    .map((part) => part.trim())
    .filter(Boolean);

  return {
    id: `nominatim-${result.place_id ?? index}-${result.lat}-${result.lon}`,
    label: result.name?.trim() || primary || displayName,
    secondaryLabel: rest.length ? rest.join(", ") : null,
    inputLabel: displayName,
    query: displayName,
    coordinates: {
      lat: Number(result.lat),
      lng: Number(result.lon),
    },
  };
}

function fixtureSuggestion(location: RouteLocation, index: number): LocationSuggestion {
  return {
    id: `fixture-${index}-${normalize(location.label)}`,
    label: location.label,
    secondaryLabel: location.city ?? null,
    inputLabel: [location.label, location.city].filter(Boolean).join(", "),
    query: [location.label, location.city].filter(Boolean).join(", "),
    coordinates: location.coordinates,
  };
}

function fixtureSuggestions(input: string, limit: number): LocationSuggestion[] {
  const normalized = normalize(input);

  return DEMO_LOCATIONS.filter(
    (location) =>
      normalize(location.label).includes(normalized) ||
      normalize(location.city ?? "").includes(normalized),
  )
    .slice(0, limit)
    .map((location, index) => fixtureSuggestion(location, index));
}

async function geocodeWithNominatim(input: string): Promise<RouteLocation | null> {
  try {
    const url = new URL("/search", NOMINATIM_URL);
    url.searchParams.set("q", input.trim());
    url.searchParams.set("format", "jsonv2");
    url.searchParams.set("limit", "1");
    url.searchParams.set("addressdetails", "1");
    url.searchParams.set("countrycodes", "de");

    const response = await fetch(url, {
      headers: {
        accept: "application/json",
        "accept-language": "de-DE,de;q=0.9,en;q=0.8",
        "user-agent": NOMINATIM_USER_AGENT,
      },
      cache: "no-store",
    });

    if (!response.ok) {
      return null;
    }

    const payload = (await response.json()) as NominatimResult[];
    const match = payload[0];

    if (!match) {
      return null;
    }

    return toRouteLocation(input, match);
  } catch {
    return null;
  }
}

async function searchWithNominatim(input: string, limit: number): Promise<LocationSuggestion[]> {
  try {
    const url = new URL("/search", NOMINATIM_URL);
    url.searchParams.set("q", input.trim());
    url.searchParams.set("format", "jsonv2");
    url.searchParams.set("limit", String(limit));
    url.searchParams.set("addressdetails", "1");
    url.searchParams.set("countrycodes", "de");

    const response = await fetch(url, {
      headers: {
        accept: "application/json",
        "accept-language": "de-DE,de;q=0.9,en;q=0.8",
        "user-agent": NOMINATIM_USER_AGENT,
      },
      cache: "no-store",
    });

    if (!response.ok) {
      return [];
    }

    const payload = (await response.json()) as NominatimResult[];
    return payload.map((item, index) => toLocationSuggestion(item, index));
  } catch {
    return [];
  }
}

function dedupeSuggestions(items: LocationSuggestion[]) {
  const seen = new Set<string>();
  const suggestions: LocationSuggestion[] = [];

  for (const item of items) {
    const key = normalize(item.inputLabel);
    if (seen.has(key)) {
      continue;
    }

    seen.add(key);
    suggestions.push(item);
  }

  return suggestions;
}

export async function searchLocations(
  input: string,
  limit = 5,
): Promise<LocationSuggestion[]> {
  const trimmed = input.trim();

  if (trimmed.length < 2) {
    return [];
  }

  const coordinates = fromCoordinateInput(trimmed);

  if (coordinates) {
    return [
      {
        id: `coordinate-${coordinates.coordinates.lat}-${coordinates.coordinates.lng}`,
        label: coordinates.label,
        secondaryLabel: coordinates.city ?? null,
        inputLabel: coordinates.label,
        query: coordinates.label,
        coordinates: coordinates.coordinates,
      },
    ];
  }

  const [remote, local] = await Promise.all([
    searchWithNominatim(trimmed, limit),
    Promise.resolve(fixtureSuggestions(trimmed, limit)),
  ]);

  return dedupeSuggestions([...remote, ...local]).slice(0, limit);
}

export async function reverseGeocodeLocation(
  lat: number,
  lng: number,
): Promise<LocationSuggestion | null> {
  try {
    const url = new URL("/reverse", NOMINATIM_URL);
    url.searchParams.set("lat", String(lat));
    url.searchParams.set("lon", String(lng));
    url.searchParams.set("format", "jsonv2");
    url.searchParams.set("addressdetails", "1");
    url.searchParams.set("zoom", "18");

    const response = await fetch(url, {
      headers: {
        accept: "application/json",
        "accept-language": "de-DE,de;q=0.9,en;q=0.8",
        "user-agent": NOMINATIM_USER_AGENT,
      },
      cache: "no-store",
    });

    if (!response.ok) {
      return null;
    }

    const payload = (await response.json()) as NominatimReverseResult;
    return toLocationSuggestion(payload, 0);
  } catch {
    return null;
  }
}

export async function resolveLocation(input: string): Promise<RouteLocation | null> {
  const coordinates = fromCoordinateInput(input);

  if (coordinates) {
    return coordinates;
  }

  const exact = fromFixtureExact(input);

  if (exact) {
    return exact;
  }

  const remote = await geocodeWithNominatim(input);

  if (remote) {
    return remote;
  }

  return fromFixturePartial(input);
}
