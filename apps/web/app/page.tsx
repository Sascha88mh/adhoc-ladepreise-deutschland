import { RoutePlannerShell } from "@/components/layout/route-planner-shell";
import type { CandidateFilters, RoutePlan } from "@adhoc/shared";

const initialRoute: RoutePlan = {
  routeId: "initial-germany-shell",
  profile: "auto",
  corridorKm: 0.5,
  origin: {
    label: "Deutschland",
    city: "Deutschland",
    coordinates: { lat: 51.1657, lng: 10.4515 },
  },
  destination: {
    label: "Umgebung",
    city: "Deutschland",
    coordinates: { lat: 51.1657, lng: 10.4515 },
  },
  geometry: [
    { lat: 51.1657, lng: 10.4515 - 0.008 },
    { lat: 51.1657, lng: 10.4515 + 0.008 },
  ],
  distanceKm: 1,
  durationMinutes: 1,
  bounds: {
    minLat: 51.1657,
    minLng: 10.4515 - 0.008,
    maxLat: 51.1657,
    maxLng: 10.4515 + 0.008,
  },
  alternatives: [],
};

const emptyInitialResults: {
  route: RoutePlan;
  filters: CandidateFilters;
  candidates: [];
  providerList: [];
  priceBand: { min: null; max: null };
  totalCandidateCount: 0;
} = {
  route: initialRoute,
  filters: {},
  candidates: [],
  providerList: [],
  priceBand: { min: null, max: null },
  totalCandidateCount: 0,
};

export default function Home() {
  return (
    <main className="h-[100dvh] w-[100vw] overflow-hidden">
      <RoutePlannerShell
        initialRoute={initialRoute}
        initialResults={emptyInitialResults}
        initialCpos={[]}
        defaultQuery={{ origin: "", destination: "" }}
      />
    </main>
  );
}
