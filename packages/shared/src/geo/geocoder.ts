import type { RouteLocation } from "../domain/types";
import { DEMO_LOCATIONS } from "../fixtures/locations";

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

export function resolveLocation(input: string): RouteLocation | null {
  const coordinates = fromCoordinateInput(input);

  if (coordinates) {
    return coordinates;
  }

  const normalized = normalize(input);
  const exact = DEMO_LOCATIONS.find((location) => normalize(location.label) === normalized);

  if (exact) {
    return exact;
  }

  return (
    DEMO_LOCATIONS.find(
      (location) =>
        normalize(location.label).includes(normalized) ||
        normalize(location.city ?? "").includes(normalized),
    ) ?? null
  );
}
