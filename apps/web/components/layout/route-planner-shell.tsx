"use client";

import dynamic from "next/dynamic";
import { motion } from "framer-motion";
import { ChartColumnIncreasing, LoaderCircle, Router } from "lucide-react";
import { useDeferredValue, useEffect, useState } from "react";
import type {
  CandidateFilters,
  RouteCandidate,
  RoutePlan,
  StationDetail,
} from "@adhoc/shared";
import { fetchRouteCandidates, fetchRoutePlan, fetchStationDetail } from "@/lib/client/api";
import { FilterRail } from "@/components/filters/filter-rail";
import { CandidateList } from "@/components/results/candidate-list";
import { StationDrawer } from "@/components/results/station-drawer";
import { RouteSearchBar } from "@/components/search/route-search-bar";

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
    profile: "auto" | "truck";
  };
};

export function RoutePlannerShell({
  initialRoute,
  initialResults,
  initialCpos,
  defaultQuery,
}: Props) {
  const [query, setQuery] = useState(defaultQuery);
  const [route, setRoute] = useState(initialRoute);
  const [filters, setFilters] = useState<CandidateFilters>({ maxPriceKwh: 0.6 });
  const deferredFilters = useDeferredValue(filters);
  const [results, setResults] = useState(initialResults);
  const [selectedStationId, setSelectedStationId] = useState<string | null>(
    initialResults.candidates[0]?.stationId ?? null,
  );
  const [hoveredStationId, setHoveredStationId] = useState<string | null>(null);
  const [detail, setDetail] = useState<StationDetail | null>(null);
  const [routeLoading, setRouteLoading] = useState(false);
  const [resultsLoading, setResultsLoading] = useState(false);
  const [detailLoading, setDetailLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
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
          filters: deferredFilters,
        });

        if (ignore) {
          return;
        }

        setResults(next);
      } catch (caught) {
        if (!ignore) {
          setError(caught instanceof Error ? caught.message : "Kandidaten konnten nicht geladen werden.");
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
  }, [route, deferredFilters]);

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

  async function handleRoutePlan() {
    setRouteLoading(true);
    setError(null);

    try {
      const nextRoute = await fetchRoutePlan(query);
      setRoute(nextRoute);
    } catch (caught) {
      setError(caught instanceof Error ? caught.message : "Route konnte nicht geplant werden.");
    } finally {
      setRouteLoading(false);
    }
  }

  function handleSelectStation(stationId: string) {
    setSelectedStationId(stationId);
    setDetailOpen(true);
  }

  return (
    <div className="mx-auto flex min-h-[calc(100vh-2rem)] max-w-[1800px] flex-col gap-4">
      <RouteSearchBar
        query={query}
        onChange={setQuery}
        onSubmit={handleRoutePlan}
        pending={routeLoading}
      />

      <section className="grid flex-1 gap-4 lg:grid-cols-[19rem,minmax(0,1fr),25rem]">
        <FilterRail
          filters={filters}
          onChange={setFilters}
          hitCount={results.candidates.length}
          priceBand={results.priceBand}
          cpos={initialCpos}
        />

        <div className="glass-panel-strong order-1 relative min-h-[34rem] overflow-hidden rounded-[34px] lg:order-2">
          <div className="absolute inset-0">
            <RouteMap
              route={route}
              candidates={results.candidates}
              selectedStationId={activeStationId}
              hoveredStationId={hoveredStationId}
              onSelect={handleSelectStation}
            />
          </div>

          <div className="pointer-events-none absolute inset-x-4 top-4 z-10 flex flex-wrap gap-3">
            <motion.div
              initial={{ opacity: 0, y: 16 }}
              animate={{ opacity: 1, y: 0 }}
              className="glass-panel rounded-full px-4 py-2 text-sm"
            >
              <p className="metric-label mb-1">Route</p>
              <strong>
                {route.origin.label} → {route.destination.label}
              </strong>
            </motion.div>
            <motion.div
              initial={{ opacity: 0, y: 20 }}
              animate={{ opacity: 1, y: 0 }}
              transition={{ delay: 0.04 }}
              className="glass-panel rounded-full px-4 py-2 text-sm"
            >
              <p className="metric-label mb-1">Fahrzeit</p>
              <strong>{route.durationMinutes} Min.</strong>
            </motion.div>
            <motion.div
              initial={{ opacity: 0, y: 24 }}
              animate={{ opacity: 1, y: 0 }}
              transition={{ delay: 0.08 }}
              className="glass-panel rounded-full px-4 py-2 text-sm"
            >
              <p className="metric-label mb-1">Korridor</p>
              <strong>{route.corridorKm} km</strong>
            </motion.div>
          </div>

          <div className="absolute bottom-4 left-4 right-4 z-10 flex flex-col gap-3 sm:flex-row sm:items-end sm:justify-between">
            <div className="glass-panel max-w-xl rounded-[28px] px-4 py-3">
              <p className="metric-label mb-1 flex items-center gap-2">
                <Router className="h-3.5 w-3.5" />
                Route Summary
              </p>
              <p className="text-sm text-[var(--muted)]">
                Kandidaten werden innerhalb eines 5-km-Korridors entlang der geplanten Route bewertet und standardmäßig nach Preis, Detour und Leistung sortiert.
              </p>
            </div>
            <div className="glass-panel flex items-center gap-3 rounded-full px-4 py-3 text-sm">
              <ChartColumnIncreasing className="h-4 w-4 text-[var(--accent)]" />
              <span>{results.providerList.length} Anbieter im aktuellen Korridor</span>
            </div>
          </div>
        </div>

        <CandidateList
          candidates={results.candidates}
          selectedStationId={activeStationId}
          hoveredStationId={hoveredStationId}
          onSelect={handleSelectStation}
          onHover={setHoveredStationId}
          loading={resultsLoading}
        />
      </section>

      {(routeLoading || resultsLoading || detailLoading || error) && (
        <div className="glass-panel-strong flex items-center gap-3 rounded-[24px] px-4 py-3 text-sm text-[var(--muted)]">
          {(routeLoading || resultsLoading || detailLoading) && (
            <LoaderCircle className="h-4 w-4 animate-spin text-[var(--accent)]" />
          )}
          {routeLoading && <span>Plane Route neu...</span>}
          {!routeLoading && resultsLoading && <span>Berechne Kandidaten entlang der Route...</span>}
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
