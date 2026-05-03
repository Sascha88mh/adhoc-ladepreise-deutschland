"use client";

import dynamic from "next/dynamic";
import { AnimatePresence, motion } from "framer-motion";
import {
  LoaderCircle,
  PanelRightClose,
  PanelRightOpen,
  Layers,
} from "lucide-react";
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
import {
  readRoutePlannerUrlState,
  writeRoutePlannerUrlState,
  type RoutePlannerUrlState,
  type StoredMapViewport,
} from "@/lib/client/url-state";
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
type MapBounds = {
  minLat: number;
  minLng: number;
  maxLat: number;
  maxLng: number;
};

const MAP_MODE_OPTIONS: Array<{ id: MapMode; label: string }> = [
  { id: "light", label: "Klar" },
  { id: "dark", label: "Dunkel" },
  { id: "color", label: "Farbe" },
  { id: "satellite", label: "Satellit" },
];
const EMPTY_BROWSE_CANDIDATES: RouteCandidate[] = [];

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
  const [initialUrlState, setInitialUrlState] = useState<RoutePlannerUrlState | null>(null);

  function effectiveFilters(source: CandidateFilters, mode: SearchQueryState["mode"]) {
    if (mode === "location") {
      const rest = { ...source };
      delete rest.corridorKm;
      return rest;
    }

    return source;
  }

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
  const [filters, setFilters] = useState<CandidateFilters>({});
  const debouncedFilters = useDebouncedValue(filters, 800);
  const [results, setResults] = useState(initialResults);
  const browseCandidates = EMPTY_BROWSE_CANDIDATES;
  const [selectedStationId, setSelectedStationId] = useState<string | null>(null);
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
  const manualSearchRef = useRef(false);
  const [detailOpen, setDetailOpen] = useState(false);
  const [mapViewport, setMapViewport] = useState<StoredMapViewport | null>(null);
  const [restoringUrlState, setRestoringUrlState] = useState(true);
  const [preserveUrlViewport, setPreserveUrlViewport] = useState(false);
  const [refreshTick, setRefreshTick] = useState(0);
  const mapCandidates = query.mode === "route" ? results.candidates : [];
  const activeStationId = selectedStationId;
  const activeDetail =
    detail?.stationId === activeStationId ? detail : null;
  const showRouteCandidatesUi = query.mode === "route";
  const globalLoading = routeLoading || resultsLoading;

  useEffect(() => {
    let ignore = false;

    window.queueMicrotask(() => {
      if (ignore) {
        return;
      }

      const urlState = readRoutePlannerUrlState();

      if (!urlState) {
        setRestoringUrlState(false);
        return;
      }

      autoLocatedRef.current = true;
      manualSearchRef.current = true;
      setInitialUrlState(urlState);
      setQuery({
        mode: urlState.mode,
        origin: urlState.route?.origin ?? defaultQuery.origin,
        originLabel: urlState.route?.originLabel ?? defaultQuery.origin,
        destination: urlState.route?.destination ?? defaultQuery.destination,
        destinationLabel: urlState.route?.destinationLabel ?? defaultQuery.destination,
        location: urlState.location ? `${urlState.location.lat}, ${urlState.location.lng}` : "",
        locationLabel: urlState.location?.label ?? "",
      });
      setMapMode(urlState.style);
      setFilters(urlState.filters);
      setSelectedStationId(null);
      setDetail(null);
      setDetailOpen(false);
      setMapViewport(urlState.mapViewport);
      setPreserveUrlViewport(Boolean(urlState.mapViewport));
      setPendingCandidateAutoOpen(urlState.mode === "route");
    });

    return () => {
      ignore = true;
    };
  }, [defaultQuery.destination, defaultQuery.origin]);

  useEffect(() => {
    if (!initialUrlState) {
      return;
    }

    let ignore = false;
    const urlState = initialUrlState;

    async function restoreFromUrl() {
      setRouteLoading(true);
      setError(null);
      setCandidatesOpen(false);

      try {
        const nextRoute =
          urlState.mode === "location" && urlState.location
            ? await fetchLocationFocus(
                `${urlState.location.lat}, ${urlState.location.lng}`,
              )
            : urlState.route
              ? await fetchRoutePlan({
                  origin: urlState.route.origin,
                  destination: urlState.route.destination,
                  profile: "auto",
                })
              : null;

        if (ignore || !nextRoute) {
          return;
        }

        setRoute(nextRoute);
        setSelectedStationId(null);
        setDetail(null);
        setDetailOpen(false);
        setPendingCandidateAutoOpen(urlState.mode === "route");
      } catch (caught) {
        if (!ignore) {
          setError(
            caught instanceof Error
              ? caught.message
              : "Gespeicherter Zustand konnte nicht geladen werden.",
          );
          setPreserveUrlViewport(false);
        }
      } finally {
        if (!ignore) {
          setRestoringUrlState(false);
          setRouteLoading(false);
        }
      }
    }

    void restoreFromUrl();

    return () => {
      ignore = true;
    };
  }, [initialUrlState]);

  useEffect(() => {
    if (restoringUrlState) {
      return;
    }

    const timeout = window.setTimeout(() => {
      writeRoutePlannerUrlState({
        mode: query.mode,
        filters: effectiveFilters(filters, query.mode),
        mapViewport,
        style: mapMode,
        stationId: null,
        location: {
          query: query.location,
          label: query.locationLabel,
        },
        route: {
          origin: query.origin,
          originLabel: query.originLabel,
          destination: query.destination,
          destinationLabel: query.destinationLabel,
        },
      });
    }, 350);

    return () => window.clearTimeout(timeout);
  }, [filters, mapMode, mapViewport, query, restoringUrlState]);

  useEffect(() => {
    const interval = window.setInterval(() => {
      if (document.visibilityState !== "visible") {
        return;
      }

      setRefreshTick((current) => current + 1);
    }, 60_000);

    return () => window.clearInterval(interval);
  }, []);

  useEffect(() => {
    if (restoringUrlState) {
      return;
    }

    let ignore = false;

    async function updateCandidates() {
      setResultsLoading(true);
      setError(null);

      try {
        const nextFilters = effectiveFilters(debouncedFilters, query.mode);
        const next = await fetchRouteCandidates({
          routeId: route.routeId,
          polyline: route.geometry,
          filters: nextFilters,
        });

        if (ignore) {
          return;
        }

        setResults(next);
        if (!showRouteCandidatesUi || next.candidates.length === 0) {
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
  }, [route, debouncedFilters, pendingCandidateAutoOpen, query.mode, refreshTick, restoringUrlState, showRouteCandidatesUi]);

  useEffect(() => {
    if (!activeStationId) {
      return;
    }

    let ignore = false;
    const controller = new AbortController();
    const stationId = activeStationId;

    async function loadDetail() {
      setDetailLoading(true);
      setError(null);
      try {
        const next = await fetchStationDetail(stationId, controller.signal);
        if (!ignore) {
          setDetail(next);
        }
      } catch (caught) {
        if (!ignore && !controller.signal.aborted) {
          setDetail(null);
          setError(
            caught instanceof Error
              ? caught.message
              : "Stationsdetails konnten nicht geladen werden.",
          );
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
      controller.abort();
    };
  }, [activeStationId, refreshTick]);

  useEffect(() => {
    if (restoringUrlState || autoLocatedRef.current) {
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

        if (ignore || manualSearchRef.current) {
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
  }, [restoringUrlState]);

  function handleViewportChange(state: {
    bounds: MapBounds;
    viewport: StoredMapViewport;
  }) {
    setMapViewport(state.viewport);
  }

  async function handleRoutePlan() {
    setRouteLoading(true);
    setError(null);
    setCandidatesOpen(false);
    setPendingCandidateAutoOpen(true);
    setPreserveUrlViewport(false);

    try {
      const nextRoute =
        query.mode === "location"
          ? await fetchLocationFocus(query.location)
          : await fetchRoutePlan({
              origin: query.origin,
              destination: query.destination,
              profile: "auto",
            });
      manualSearchRef.current = true;
      setRoute(nextRoute);
      setSelectedStationId(null);
      setDetail(null);
      setDetailOpen(false);
      writeRoutePlannerUrlState({
        mode: query.mode,
        filters: effectiveFilters(filters, query.mode),
        mapViewport,
        style: mapMode,
        stationId: null,
        location: {
          query: query.location,
          label: query.locationLabel,
        },
        route: {
          origin: query.origin,
          originLabel: query.originLabel,
          destination: query.destination,
          destinationLabel: query.destinationLabel,
        },
      });
    } catch (caught) {
      setError(caught instanceof Error ? caught.message : "Route konnte nicht geplant werden.");
      setPendingCandidateAutoOpen(false);
    } finally {
      setRouteLoading(false);
    }
  }

  function handleSelectStation(stationId: string | null) {
    setSelectedStationId(stationId);
    setDetailOpen(Boolean(stationId));
    if (!stationId) {
      setHoveredStationId(null);
    }
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
          candidates={mapCandidates}
          browseCandidates={browseCandidates}
          filters={effectiveFilters(debouncedFilters, query.mode)}
          selectedStationId={activeStationId}
          hoveredStationId={hoveredStationId}
          onSelect={handleSelectStation}
          onViewportChange={handleViewportChange}
          mapMode={mapMode}
          initialViewport={initialUrlState?.mapViewport ?? null}
          preserveViewport={preserveUrlViewport}
          candidatesOpen={showRouteCandidatesUi && candidatesOpen}
        />
      </div>

      {/* Top Left Floating Controls (Search & Filters) */}
      <div className="pointer-events-none absolute left-4 top-4 bottom-4 z-30 flex flex-col items-start gap-4 justify-between sm:justify-start w-[calc(100vw-2rem)] sm:w-[24rem]">
        <div className="pointer-events-auto w-full shrink-0 shadow-[0_8px_30px_rgb(0,0,0,0.12)] rounded-[30px] glass-panel-strong">
          <RouteSearchBar
            query={query}
            onChange={setQuery}
            onSubmit={handleRoutePlan}
            pending={routeLoading}
          />
        </div>

        <motion.div 
          layout
          initial={false}
          animate={{ borderRadius: filtersOpen ? 32 : 40 }}
          transition={{ type: "spring", bounce: 0, duration: 0.35 }}
          className={`pointer-events-auto min-h-0 flex flex-col overflow-hidden shadow-[0_8px_30px_rgb(0,0,0,0.12)] glass-panel-strong ${filtersOpen ? 'w-full' : 'self-start w-auto sm:self-auto sm:w-full'}`}
        >
          <FilterRail
            filters={filters}
            onChange={setFilters}
            hitCount={results.candidates.length}
            priceBand={results.priceBand}
            cpos={initialCpos}
            expanded={filtersOpen}
            onToggle={() => setFiltersOpen((current) => !current)}
            showCorridorFilter={query.mode === "route"}
          />
        </motion.div>
      </div>

      {/* Right Floating Candidate List */}
      <AnimatePresence>
        {showRouteCandidatesUi && candidatesOpen && (
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
      <div className="pointer-events-none absolute bottom-[4.5rem] left-4 sm:left-auto sm:top-3 sm:bottom-auto sm:right-4 z-20 flex sm:justify-end">
        <div className="group pointer-events-auto flex items-center rounded-full p-1 shadow-2xl glass-panel-strong transition-colors hover:bg-white/95">
          <button
            type="button"
            className="order-1 sm:order-2 flex h-9 w-9 shrink-0 items-center justify-center rounded-full bg-[var(--accent)] text-[var(--accent-fg)] shadow-[0_4px_10px_rgba(21,111,99,0.2)] transition-transform group-hover:scale-105"
            aria-label="Kartenstil auswählen"
          >
            <Layers size={16} />
          </button>
          <div className="order-2 sm:order-1 flex max-w-0 items-center gap-1.5 overflow-hidden whitespace-nowrap pl-0 pr-0 opacity-0 transition-all duration-300 ease-in-out group-hover:max-w-[20rem] group-hover:pl-2 group-hover:pr-1 sm:group-hover:pl-1 sm:group-hover:pr-2 group-hover:opacity-100">
            {MAP_MODE_OPTIONS.map((option) => (
              <button
                key={option.id}
                type="button"
                onClick={() => setMapMode(option.id)}
                className={`rounded-full px-3 py-1.5 text-xs font-medium transition ${
                  mapMode === option.id
                    ? "bg-[var(--accent)] text-[var(--accent-fg)] shadow-[0_4px_10px_rgba(21,111,99,0.22)]"
                    : "border border-[var(--line)] bg-white/70 text-[var(--foreground)] hover:bg-white"
                }`}
              >
                {option.label}
              </button>
            ))}
          </div>
        </div>
      </div>

      {/* Floating Action Button for Results */}
      {showRouteCandidatesUi && results.candidates.length > 0 ? (
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

      {(globalLoading || error) && (
        <div className="glass-panel-strong absolute bottom-24 left-1/2 z-50 flex w-max max-w-[calc(100vw-2.5rem)] -translate-x-1/2 items-center justify-center gap-3 rounded-full px-5 py-3 text-sm text-[var(--foreground)] shadow-2xl sm:bottom-8 sm:left-1/2">
          {globalLoading && (
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
          {error && <span className="text-[#9c4110]">{error}</span>}
        </div>
      )}

      <StationDrawer
        detail={activeDetail}
        loading={detailLoading}
        open={detailOpen && Boolean(activeStationId)}
        onClose={() => {
          setDetailOpen(false);
          setSelectedStationId(null);
          setHoveredStationId(null);
        }}
      />
    </div>
  );
}
