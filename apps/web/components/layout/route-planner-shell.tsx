"use client";

import dynamic from "next/dynamic";
import { AnimatePresence, motion } from "framer-motion";
import { LoaderCircle, PanelRightClose, PanelRightOpen } from "lucide-react";
import { useEffect, useRef, useState, type CSSProperties } from "react";
import type {
  CandidateFilters,
  RouteCandidate,
  RoutePlan,
  StationDetail,
} from "@adhoc/shared";
import {
  fetchLocationFocus,
  fetchIpLocation,
  fetchReverseLocation,
  fetchRouteCandidates,
  fetchRoutePlan,
  fetchStationDetail,
} from "@/lib/client/api";
import { FilterRail } from "@/components/filters/filter-rail";
import { CandidateList } from "@/components/results/candidate-list";
import { StationDrawer } from "@/components/results/station-drawer";
import { RouteSearchBar, type SearchQueryState } from "@/components/search/route-search-bar";

const RouteMap = dynamic(
  () => import("@/components/map/route-map").then((module) => module.RouteMap),
  {
    ssr: false,
    loading: () => (
      <div className="flex h-full items-center justify-center text-sm text-[var(--muted)]">
        Karte wird geladen...
      </div>
    ),
  },
);

type MapMode = "light" | "dark" | "color" | "satellite";

const MAP_MODE_OPTIONS: Array<{ id: MapMode; label: string }> = [
  { id: "light", label: "Klar" },
  { id: "dark", label: "Dunkel" },
  { id: "color", label: "Farbe" },
  { id: "satellite", label: "Satellit" },
];

function mapTheme(): CSSProperties {
  return {
    "--accent-fg": "#ffffff",
    "--glass-border": "var(--line)",
  } as CSSProperties;
}

type Props = {
  initialRoute: RoutePlan;
  initialResults: {
    route: RoutePlan;
    filters: CandidateFilters;
    candidates: RouteCandidate[];
    providerList: Array<{ cpoId: string; cpoName: string; stations: number }>;
    priceBand: { min: number | null; max: number | null };
  };
  initialCpos: Array<{ id: string; name: string; stations: number }>;
  defaultQuery: {
    origin: string;
    destination: string;
  };
};

function useDebouncedValue<T>(value: T, delayMs: number) {
  const [debouncedValue, setDebouncedValue] = useState(value);

  useEffect(() => {
    const timeout = window.setTimeout(() => {
      setDebouncedValue(value);
    }, delayMs);

    return () => {
      window.clearTimeout(timeout);
    };
  }, [value, delayMs]);

  return debouncedValue;
}

export function RoutePlannerShell({
  initialRoute,
  initialResults,
  initialCpos,
  defaultQuery,
}: Props) {
  const [query, setQuery] = useState<SearchQueryState>({
    mode: "location",
    origin: defaultQuery.origin,
    originLabel: defaultQuery.origin,
    destination: defaultQuery.destination,
    destinationLabel: defaultQuery.destination,
    location: "",
    locationLabel: "",
  });
  const [route, setRoute] = useState(initialRoute);
  const [mapMode, setMapMode] = useState<MapMode>("light");
  const [filters, setFilters] = useState<CandidateFilters>({
    corridorKm: initialRoute.corridorKm,
    maxPriceKwh: 0.6,
  });
  const debouncedFilters = useDebouncedValue(filters, 800);
  const [results, setResults] = useState(initialResults);
  const [selectedStationId, setSelectedStationId] = useState<string | null>(
    initialResults.candidates[0]?.stationId ?? null,
  );
  const [hoveredStationId, setHoveredStationId] = useState<string | null>(null);
  const [detail, setDetail] = useState<StationDetail | null>(null);
  
  const [filtersOpen, setFiltersOpen] = useState(false);
  const [candidatesOpen, setCandidatesOpen] = useState(false);
  const [pendingCandidateAutoOpen, setPendingCandidateAutoOpen] = useState(false);
  
  const [routeLoading, setRouteLoading] = useState(false);
  const [resultsLoading, setResultsLoading] = useState(false);
  const [detailLoading, setDetailLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const autoLocatedRef = useRef(false);
  const [detailOpen, setDetailOpen] = useState(
    Boolean(initialResults.candidates[0]?.stationId),
  );
  const activeStationId =
    (selectedStationId &&
      results.candidates.some((candidate) => candidate.stationId === selectedStationId)
      ? selectedStationId
      : null) ?? results.candidates[0]?.stationId ?? null;
  const activeDetail =
    detail?.stationId === activeStationId ? detail : null;

  useEffect(() => {
    let ignore = false;

    async function updateCandidates() {
      setResultsLoading(true);
      setError(null);

      try {
        const next = await fetchRouteCandidates({
          routeId: route.routeId,
          polyline: route.geometry,
          filters: debouncedFilters,
        });

        if (ignore) {
          return;
        }

        setResults(next);
        if (next.candidates.length === 0) {
          setCandidatesOpen(false);
        } else if (pendingCandidateAutoOpen) {
          setCandidatesOpen(true);
        }
        setPendingCandidateAutoOpen(false);
      } catch (caught) {
        if (!ignore) {
          setError(caught instanceof Error ? caught.message : "Kandidaten konnten nicht geladen werden.");
          setPendingCandidateAutoOpen(false);
        }
      } finally {
        if (!ignore) {
          setResultsLoading(false);
        }
      }
    }

    updateCandidates();

    return () => {
      ignore = true;
    };
  }, [route, debouncedFilters, pendingCandidateAutoOpen]);

  useEffect(() => {
    if (!activeStationId) {
      return;
    }

    let ignore = false;

    async function loadDetail() {
      setDetailLoading(true);
      try {
        const next = await fetchStationDetail(activeStationId);
        if (!ignore) {
          setDetail(next);
        }
      } finally {
        if (!ignore) {
          setDetailLoading(false);
        }
      }
    }

    loadDetail();

    return () => {
      ignore = true;
    };
  }, [activeStationId]);

  useEffect(() => {
    if (autoLocatedRef.current) {
      return;
    }

    autoLocatedRef.current = true;
    let ignore = false;

    function requestCurrentPosition(enableHighAccuracy: boolean) {
      return new Promise<GeolocationPosition>((resolve, reject) => {
        navigator.geolocation.getCurrentPosition(resolve, reject, {
          enableHighAccuracy,
          timeout: enableHighAccuracy ? 8000 : 6000,
          maximumAge: enableHighAccuracy ? 60_000 : 300_000,
        });
      });
    }

    async function focusCurrentLocation() {
      setRouteLoading(true);
      setError(null);
      setCandidatesOpen(false);
      setPendingCandidateAutoOpen(true);

      try {
        let lat: number | null = null;
        let lng: number | null = null;
        let label = "";

        if ("geolocation" in navigator && window.isSecureContext) {
          try {
            let position: GeolocationPosition;

            try {
              position = await requestCurrentPosition(true);
            } catch (error) {
              const geoError = error as GeolocationPositionError;
              if (geoError.code === geoError.TIMEOUT) {
                position = await requestCurrentPosition(false);
              } else {
                throw geoError;
              }
            }

            lat = position.coords.latitude;
            lng = position.coords.longitude;

            try {
              const suggestion = await fetchReverseLocation(lat, lng);
              label = suggestion.inputLabel;
            } catch {
              label = `${lat.toFixed(5)}, ${lng.toFixed(5)}`;
            }
          } catch {
            // Fall through to IP fallback below.
          }
        }

        if (lat == null || lng == null) {
          const suggestion = await fetchIpLocation();
          lat = suggestion.coordinates.lat;
          lng = suggestion.coordinates.lng;
          label = suggestion.inputLabel;
        }

        if (ignore) {
          return;
        }

        setQuery((current) => ({
          ...current,
          mode: "location",
          location: `${lat!.toFixed(5)}, ${lng!.toFixed(5)}`,
          locationLabel: label,
        }));

        const nextRoute = await fetchLocationFocus(`${lat}, ${lng}`);

        if (ignore) {
          return;
        }

        setRoute(nextRoute);
        setSelectedStationId(null);
        setDetail(null);
        setDetailOpen(false);
      } catch (caught) {
        if (!ignore) {
          setError(
            caught instanceof Error
              ? caught.message
              : "Standort konnte nicht automatisch geladen werden.",
          );
          setPendingCandidateAutoOpen(false);
        }
      } finally {
        if (!ignore) {
          setRouteLoading(false);
        }
      }
    }

    void focusCurrentLocation();

    return () => {
      ignore = true;
    };
  }, []);

  async function handleRoutePlan() {
    setRouteLoading(true);
    setError(null);
    setCandidatesOpen(false);
    setPendingCandidateAutoOpen(true);

    try {
      const nextRoute =
        query.mode === "location"
          ? await fetchLocationFocus(query.location)
          : await fetchRoutePlan({
              origin: query.origin,
              destination: query.destination,
              profile: "auto",
            });
      setRoute(nextRoute);
      setSelectedStationId(null);
      setDetail(null);
      setDetailOpen(false);
    } catch (caught) {
      setError(caught instanceof Error ? caught.message : "Route konnte nicht geplant werden.");
      setPendingCandidateAutoOpen(false);
    } finally {
      setRouteLoading(false);
    }
  }

  function handleSelectStation(stationId: string) {
    setSelectedStationId(stationId);
    setDetailOpen(true);
  }

  return (
    <div
      className="relative h-full w-full overflow-hidden bg-[var(--background)]"
      style={mapTheme()}
    >
      {/* Background Map layer */}
      <div className="absolute inset-0 z-0">
        <RouteMap
          route={route}
          candidates={results.candidates}
          selectedStationId={activeStationId}
          hoveredStationId={hoveredStationId}
          onSelect={handleSelectStation}
          mapMode={mapMode}
        />
      </div>

      {/* Top Left Floating Search Bar */}
      <div className="pointer-events-none absolute left-4 top-4 z-20 w-[min(22rem,calc(100vw-2rem))]">
        <div className="pointer-events-auto shadow-2xl rounded-[30px] glass-panel-strong">
          <RouteSearchBar
            query={query}
            onChange={setQuery}
            onSubmit={handleRoutePlan}
            pending={routeLoading}
          />
        </div>
      </div>

      {/* Bottom Filter Sheet */}
      <div className="pointer-events-none absolute bottom-4 left-4 z-20 w-[min(25rem,calc(100vw-2rem))]">
        <div className="pointer-events-auto overflow-hidden rounded-[30px] shadow-2xl glass-panel-strong">
          <FilterRail
            filters={filters}
            onChange={setFilters}
            hitCount={results.candidates.length}
            priceBand={results.priceBand}
            cpos={initialCpos}
            expanded={filtersOpen}
            onToggle={() => setFiltersOpen((current) => !current)}
          />
        </div>
      </div>

      {/* Right Floating Candidate List */}
      <AnimatePresence>
        {candidatesOpen && (
          <motion.div
            initial={{ x: 500, opacity: 0 }}
            animate={{ x: 0, opacity: 1 }}
            exit={{ x: 500, opacity: 0 }}
            className="pointer-events-auto absolute bottom-20 right-4 top-32 z-20 flex w-[min(25rem,calc(100vw-2rem))] flex-col overflow-hidden lg:bottom-24"
          >
            <div className="flex-1 overflow-hidden relative shadow-2xl rounded-[34px] glass-panel-strong flex flex-col">
              <CandidateList
                candidates={results.candidates}
                selectedStationId={activeStationId}
                hoveredStationId={hoveredStationId}
                onSelect={handleSelectStation}
                onHover={setHoveredStationId}
                loading={resultsLoading}
              />
            </div>
          </motion.div>
        )}
      </AnimatePresence>

      {/* Map Style Switcher */}
      <div className="pointer-events-none absolute right-[4.8rem] top-3 z-20">
        <div className="pointer-events-auto flex items-center gap-2 rounded-[22px] p-2 shadow-2xl glass-panel-strong">
          {MAP_MODE_OPTIONS.map((option) => (
            <button
              key={option.id}
              type="button"
              onClick={() => setMapMode(option.id)}
              className={`rounded-full px-3 py-2 text-xs font-medium transition ${
                mapMode === option.id
                  ? "bg-[var(--accent)] text-[var(--accent-fg)] shadow-[0_10px_18px_rgba(21,111,99,0.22)]"
                  : "border border-[var(--line)] bg-white/78 text-[var(--foreground)] hover:bg-white"
              }`}
            >
              {option.label}
            </button>
          ))}
        </div>
      </div>

      {/* Floating Action Button for Results */}
      {results.candidates.length > 0 ? (
        <div className="pointer-events-none absolute bottom-28 right-6 z-20 sm:bottom-6">
          <button
            onClick={() => setCandidatesOpen((current) => !current)}
            className="glass-panel pointer-events-auto flex h-12 w-12 items-center justify-center rounded-full text-[var(--foreground)] shadow-xl transition hover:bg-white/80"
            title="Ergebnisse umschalten"
          >
            {candidatesOpen ? (
              <PanelRightClose size={20} className="text-[var(--accent)]" />
            ) : (
              <PanelRightOpen size={20} className="text-[var(--muted)]" />
            )}
          </button>
        </div>
      ) : null}

      {(routeLoading || resultsLoading || detailLoading || error) && (
        <div className="glass-panel-strong absolute left-1/2 top-40 z-30 flex -translate-x-1/2 items-center gap-3 rounded-full px-5 py-3 text-sm text-[var(--foreground)] shadow-2xl">
          {(routeLoading || resultsLoading || detailLoading) && (
            <LoaderCircle className="h-4 w-4 animate-spin text-[var(--accent)]" />
          )}
          {routeLoading && (
            <span>
              {query.mode === "location"
                ? "Fokussiere Standort..."
                : "Plane Route neu..."}
            </span>
          )}
          {!routeLoading && resultsLoading && (
            <span>
              {query.mode === "location"
                ? "Suche Ladesaeulen in deiner Umgebung..."
                : "Berechne Kandidaten entlang der Route..."}
            </span>
          )}
          {!routeLoading && !resultsLoading && detailLoading && <span>Lade Stationsdetails...</span>}
          {error && <span className="text-[#9c4110]">{error}</span>}
        </div>
      )}

      <StationDrawer
        detail={activeDetail}
        open={detailOpen && Boolean(activeStationId)}
        onClose={() => setDetailOpen(false)}
      />
    </div>
  );
}
