"use client";

import { useEffect, useRef, useState } from "react";
import maplibregl, {
  type GeoJSONSource,
  type Map as MaplibreMap,
  type StyleSpecification,
} from "maplibre-gl";
import type { RouteCandidate, RoutePlan } from "@adhoc/shared";
import { StationMarker } from "./station-marker";
import { Compass } from "lucide-react";

const MAP_STYLES = {
  light:
    process.env.NEXT_PUBLIC_MAP_STYLE_LIGHT ??
    process.env.NEXT_PUBLIC_MAP_STYLE ??
    "https://basemaps.cartocdn.com/gl/positron-gl-style/style.json",
  dark:
    process.env.NEXT_PUBLIC_MAP_STYLE_DARK ??
    "https://basemaps.cartocdn.com/gl/dark-matter-gl-style/style.json",
  color:
    process.env.NEXT_PUBLIC_MAP_STYLE_COLOR ??
    "https://basemaps.cartocdn.com/gl/voyager-gl-style/style.json",
} as const;

const SATELLITE_STYLE: StyleSpecification = {
  version: 8,
  sources: {
    satellite: {
      type: "raster",
      tiles: [
        "https://services.arcgisonline.com/ArcGIS/rest/services/World_Imagery/MapServer/tile/{z}/{y}/{x}",
      ],
      tileSize: 256,
      attribution: "Esri, Maxar, Earthstar Geographics, and the GIS User Community",
    },
  },
  layers: [
    {
      id: "satellite",
      type: "raster",
      source: "satellite",
    },
  ],
};

export type MapMode = "light" | "dark" | "color" | "satellite";

type Props = {
  route: RoutePlan;
  candidates: RouteCandidate[];
  browseCandidates: RouteCandidate[];
  selectedStationId: string | null;
  hoveredStationId: string | null;
  onSelect: (stationId: string | null) => void;
  onViewportChange?: (bounds: {
    minLat: number;
    minLng: number;
    maxLat: number;
    maxLng: number;
  }) => void;
  mapMode: MapMode;
  candidatesOpen?: boolean;
};

function CustomCompass({ map, candidatesOpen }: { map: MaplibreMap; candidatesOpen?: boolean }) {
  const [bearing, setBearing] = useState(0);

  useEffect(() => {
    if (!map) return;
    const update = () => setBearing(map.getBearing());
    map.on('rotate', update);
    map.on('pitch', update);
    return () => {
      map.off('rotate', update);
      map.off('pitch', update);
    };
  }, [map]);

  if (bearing === 0 && map.getPitch() === 0) return null;

  return (
    <button
      onClick={() => map.flyTo({ bearing: 0, pitch: 0 })}
      className={`absolute z-40 flex h-10 w-10 items-center justify-center rounded-full bg-white/80 shadow-sm transition-all duration-500 hover:bg-white bottom-4 right-4 sm:bottom-6 ${
        candidatesOpen ? "sm:right-[26rem]" : "sm:right-4"
      }`}
      aria-label="Nordausrichtung"
    >
      <Compass 
        className="h-5 w-5 text-[var(--foreground)] transition-transform duration-75" 
        style={{ transform: `rotate(${-bearing}deg)` }} 
      />
    </button>
  );
}

function isLocationFocusRoute(route: RoutePlan) {
  return route.destination.label === "Umgebung";
}

function mapStyleForMode(mode: MapMode) {
  if (mode === "satellite") {
    return SATELLITE_STYLE;
  }

  return MAP_STYLES[mode];
}

function emptyCollection() {
  return {
    type: "FeatureCollection" as const,
    features: [],
  };
}

function focusCollection(route: RoutePlan) {
  return {
    type: "FeatureCollection" as const,
    features: isLocationFocusRoute(route)
      ? [
          {
            type: "Feature" as const,
            geometry: {
              type: "Point" as const,
              coordinates: [route.origin.coordinates.lng, route.origin.coordinates.lat],
            },
            properties: {
              id: route.routeId,
            },
          },
        ]
      : [],
  };
}

function candidateCollection(candidates: RouteCandidate[]) {
  return {
    type: "FeatureCollection" as const,
    features: candidates.map((candidate) => ({
      type: "Feature" as const,
      geometry: {
        type: "Point" as const,
        coordinates: [candidate.lng, candidate.lat],
      },
      properties: {
        id: candidate.stationId,
        available: candidate.availabilitySummary.available,
        power: candidate.maxPowerKw,
        price: candidate.tariffSummary.pricePerKwh ?? 9,
      },
    })),
  };
}

function browseCollection(
  browseCandidates: RouteCandidate[],
  highlightedIds: Set<string>,
) {
  return {
    type: "FeatureCollection" as const,
    features: browseCandidates
      .filter((candidate) => !highlightedIds.has(candidate.stationId))
      .map((candidate) => ({
        type: "Feature" as const,
        geometry: {
          type: "Point" as const,
          coordinates: [candidate.lng, candidate.lat],
        },
        properties: {
          id: candidate.stationId,
          available: candidate.availabilitySummary.available,
          power: candidate.maxPowerKw,
        },
      })),
  };
}

function routeCollection(route: RoutePlan) {
  return {
    type: "FeatureCollection" as const,
    features: [
      {
        type: "Feature" as const,
        geometry: {
          type: "LineString" as const,
          coordinates: route.geometry.map((point) => [point.lng, point.lat]),
        },
        properties: {
          id: route.routeId,
        },
      },
    ],
  };
}

function selectedCollection(
  candidates: RouteCandidate[],
  browseCandidates: RouteCandidate[],
  selectedStationId: string | null,
  hoveredStationId: string | null,
) {
  const highlighted = [...candidates, ...browseCandidates].find(
    (candidate) =>
      candidate.stationId === selectedStationId ||
      candidate.stationId === hoveredStationId,
  );

  return {
    type: "FeatureCollection" as const,
    features: highlighted
      ? [
          {
            type: "Feature" as const,
            geometry: {
              type: "Point" as const,
              coordinates: [highlighted.lng, highlighted.lat],
            },
            properties: {
              id: highlighted.stationId,
            },
          },
        ]
      : [],
  };
}

function updateSource(
  map: MaplibreMap,
  sourceId: string,
  data: Parameters<GeoJSONSource["setData"]>[0],
) {
  const source = map.getSource(sourceId) as GeoJSONSource | undefined;
  source?.setData(data);
}

function routeFitPadding() {
  if (typeof window === "undefined") {
    return 140;
  }

  if (window.innerWidth < 640) {
    return {
      top: 148,
      right: 28,
      bottom: 214,
      left: 28,
    };
  }

  return {
    top: 132,
    right: 180,
    bottom: 132,
    left: 240,
  };
}

function routePalette(mode: MapMode) {
  if (mode === "dark") {
    return {
      line: "#6ee7d8",
      glow: "rgba(110,231,216,0.28)",
      selectedFill: "#091915",
      selectedStroke: "#6ee7d8",
      candidateStroke: "#081410",
      focusHalo: "rgba(110,231,216,0.18)",
      focusCore: "#6ee7d8",
    };
  }

  if (mode === "satellite") {
    return {
      line: "#f7ff78",
      glow: "rgba(247,255,120,0.36)",
      selectedFill: "#ffffff",
      selectedStroke: "#f7ff78",
      candidateStroke: "#0f172a",
      focusHalo: "rgba(247,255,120,0.22)",
      focusCore: "#f7ff78",
    };
  }

  if (mode === "color") {
    return {
      line: "#156f63",
      glow: "rgba(21,111,99,0.24)",
      selectedFill: "#ffffff",
      selectedStroke: "#156f63",
      candidateStroke: "#ffffff",
      focusHalo: "rgba(21,111,99,0.18)",
      focusCore: "#156f63",
    };
  }

  return {
    line: "#156f63",
    glow: "rgba(21,111,99,0.2)",
    selectedFill: "#ffffff",
    selectedStroke: "#156f63",
    candidateStroke: "#ffffff",
    focusHalo: "rgba(21,111,99,0.18)",
    focusCore: "#156f63",
  };
}

function ensureOperationalLayers(map: MaplibreMap, mapMode: MapMode) {
  const palette = routePalette(mapMode);

  if (!map.getSource("route")) {
    map.addSource("route", {
      type: "geojson",
      data: emptyCollection(),
    });
  }

  if (!map.getSource("candidates")) {
    map.addSource("candidates", {
      type: "geojson",
      data: emptyCollection(),
    });
  }

  if (!map.getSource("browse")) {
    map.addSource("browse", {
      type: "geojson",
      data: emptyCollection(),
    });
  }

  if (!map.getSource("selected")) {
    map.addSource("selected", {
      type: "geojson",
      data: emptyCollection(),
    });
  }

  if (!map.getSource("focus")) {
    map.addSource("focus", {
      type: "geojson",
      data: emptyCollection(),
    });
  }

  if (!map.getLayer("route-glow")) {
    map.addLayer({
      id: "route-glow",
      type: "line",
      source: "route",
      paint: {
        "line-color": palette.glow,
        "line-width": 18,
        "line-blur": 12,
      },
    });
  }

  if (!map.getLayer("route-line")) {
    map.addLayer({
      id: "route-line",
      type: "line",
      source: "route",
      paint: {
        "line-color": palette.line,
        "line-width": 5,
      },
    });
  }
  if (!map.getLayer("focus-halo")) {
    map.addLayer({
      id: "focus-halo",
      type: "circle",
      source: "focus",
      paint: {
        "circle-color": palette.focusHalo,
        "circle-radius": 18,
        "circle-opacity": 0.75,
        "circle-stroke-width": 1.5,
        "circle-stroke-color": palette.focusCore,
        "circle-stroke-opacity": 0.75,
      },
    });
  }

  if (!map.getLayer("focus-core")) {
    map.addLayer({
      id: "focus-core",
      type: "circle",
      source: "focus",
      paint: {
        "circle-color": palette.focusCore,
        "circle-radius": 8,
        "circle-stroke-width": 3,
        "circle-stroke-color": "#ffffff",
      },
    });
  }
  map.setPaintProperty("route-glow", "line-color", palette.glow);
  map.setPaintProperty("route-line", "line-color", palette.line);
  map.setPaintProperty("focus-halo", "circle-color", palette.focusHalo);
  map.setPaintProperty("focus-halo", "circle-stroke-color", palette.focusCore);
  map.setPaintProperty("focus-core", "circle-color", palette.focusCore);
}

function syncMapData(
  map: MaplibreMap,
  route: RoutePlan,
  candidates: RouteCandidate[],
  browseCandidates: RouteCandidate[],
  selectedStationId: string | null,
  hoveredStationId: string | null,
) {
  updateSource(
    map,
    "route",
    isLocationFocusRoute(route) ? emptyCollection() : routeCollection(route),
  );
  updateSource(map, "candidates", candidateCollection(candidates));
  updateSource(
    map,
    "browse",
    browseCollection(
      browseCandidates,
      new Set(candidates.map((candidate) => candidate.stationId)),
    ),
  );
  updateSource(
    map,
    "selected",
    selectedCollection(
      candidates,
      browseCandidates,
      selectedStationId,
      hoveredStationId,
    ),
  );
  updateSource(map, "focus", focusCollection(route));
}

function fitMapToContent(map: MaplibreMap, route: RoutePlan, candidates: RouteCandidate[]) {
  if (isLocationFocusRoute(route)) {
    if (candidates.length > 0) {
      const bounds = new maplibregl.LngLatBounds();
      bounds.extend([route.origin.coordinates.lng, route.origin.coordinates.lat]);
      candidates.forEach((candidate) => bounds.extend([candidate.lng, candidate.lat]));
      map.fitBounds(bounds, {
        padding: routeFitPadding(),
        duration: 700,
        maxZoom: 13.2,
      });
      return;
    }

    map.easeTo({
      center: [route.origin.coordinates.lng, route.origin.coordinates.lat],
      zoom: 14,
      duration: 700,
    });
    return;
  }

  const bounds = new maplibregl.LngLatBounds();
  route.geometry.forEach((point) => bounds.extend([point.lng, point.lat]));
  map.fitBounds(bounds, {
    padding: routeFitPadding(),
    duration: 700,
    maxZoom: 9.6,
  });
}

export function RouteMap({
  route,
  candidates,
  browseCandidates,
  selectedStationId,
  hoveredStationId,
  onSelect,
  onViewportChange,
  mapMode,
  candidatesOpen,
}: Props) {
  const [mapInstance, setMapInstance] = useState<MaplibreMap | null>(null);
  const [isZoomedIn, setIsZoomedIn] = useState(false);
  const [isZoomedOut, setIsZoomedOut] = useState(false);
  const containerRef = useRef<HTMLDivElement | null>(null);
  const mapRef = useRef<MaplibreMap | null>(null);
  const onSelectRef = useRef(onSelect);
  const routeRef = useRef(route);
  const candidatesRef = useRef(candidates);
  const browseCandidatesRef = useRef(browseCandidates);
  const selectedStationIdRef = useRef(selectedStationId);
  const hoveredStationIdRef = useRef(hoveredStationId);
  const mapModeRef = useRef(mapMode);
  const onViewportChangeRef = useRef(onViewportChange);

  useEffect(() => {
    onSelectRef.current = onSelect;
  }, [onSelect]);

  useEffect(() => {
    onViewportChangeRef.current = onViewportChange;
  }, [onViewportChange]);

  useEffect(() => {
    routeRef.current = route;
    candidatesRef.current = candidates;
    browseCandidatesRef.current = browseCandidates;
    selectedStationIdRef.current = selectedStationId;
    hoveredStationIdRef.current = hoveredStationId;
    mapModeRef.current = mapMode;
  }, [route, candidates, browseCandidates, selectedStationId, hoveredStationId, mapMode]);

  useEffect(() => {
    if (!containerRef.current || mapRef.current) {
      return;
    }

    const map = new maplibregl.Map({
      container: containerRef.current,
      style: mapStyleForMode(mapModeRef.current),
      center: [
        routeRef.current.origin.coordinates.lng,
        routeRef.current.origin.coordinates.lat,
      ],
      zoom: isLocationFocusRoute(routeRef.current) ? 14 : 6,
      pitch: 20,
      maxZoom: 16,
      attributionControl: false,
    });

    mapRef.current = map;
    setMapInstance(map); // Store map purely to trigger React re-render of child markers
    setIsZoomedIn(map.getZoom() > 11.5);
    setIsZoomedOut(map.getZoom() < 10.0);

    const renderCurrentState = () => {
      const currentRoute = routeRef.current;
      const currentCandidates = candidatesRef.current;

      ensureOperationalLayers(map, mapModeRef.current);
      syncMapData(
        map,
        currentRoute,
        currentCandidates,
        browseCandidatesRef.current,
        selectedStationIdRef.current,
        hoveredStationIdRef.current,
      );

      fitMapToContent(map, currentRoute, currentCandidates);
    };

    map.on("load", renderCurrentState);
    map.on("load", () => {
      const bounds = map.getBounds();
      onViewportChangeRef.current?.({
        minLat: bounds.getSouth(),
        minLng: bounds.getWest(),
        maxLat: bounds.getNorth(),
        maxLng: bounds.getEast(),
      });
    });
    map.on("click", () => {
      // Any click that reaches the MapLibre canvas wasn't caught by a StationMarker overlay
      // Therefore, it's a click on an empty area of the map or the route line.
      onSelectRef.current(null);
    });
    map.on("zoom", () => {
      const zoom = map.getZoom();
      setIsZoomedIn(zoom > 11.5);
      setIsZoomedOut(zoom < 10.0);
    });
    map.on("moveend", () => {
      const bounds = map.getBounds();
      onViewportChangeRef.current?.({
        minLat: bounds.getSouth(),
        minLng: bounds.getWest(),
        maxLat: bounds.getNorth(),
        maxLng: bounds.getEast(),
      });
    });

    let frameId: number;
    const animatePulse = (timestamp: number) => {
      const currentMap = mapRef.current;
      if (currentMap?.getLayer("focus-halo")) {
        // Continuous smooth oscillation between 0 and 1
        const phase = (Math.sin(timestamp / 800) + 1) / 2;
        
        // "Breathing" radius: smoothly grows and shrinks between roughly 12px and 22px
        const radius = 12 + 10 * phase;
        
        // Intelligently linked opacity: when the halo is smallest, it glows brightest (0.7).
        // When it expands, the light "dilutes" and becomes more transparent (0.3).
        const opacity = 0.7 - 0.4 * phase;
        
        try {
          currentMap.setPaintProperty("focus-halo", "circle-radius", radius);
          currentMap.setPaintProperty("focus-halo", "circle-opacity", opacity);
          currentMap.setPaintProperty("focus-halo", "circle-stroke-opacity", opacity);
        } catch (error) {
          // Layer might be rendering or map disconnected temporarily
        }
      }
      frameId = requestAnimationFrame(animatePulse);
    };
    frameId = requestAnimationFrame(animatePulse);

    return () => {
      cancelAnimationFrame(frameId);
      map.remove();
      mapRef.current = null;
    };
  }, []);

  useEffect(() => {
    const map = mapRef.current;

    if (!map) {
      return;
    }

    const apply = () => {
      ensureOperationalLayers(map, mapMode);
      syncMapData(
        map,
        route,
        candidates,
        browseCandidates,
        selectedStationId,
        hoveredStationId,
      );
    };

    if (!map.isStyleLoaded()) {
      return;
    }

    apply();
  }, [route, candidates, browseCandidates, selectedStationId, hoveredStationId, mapMode]);

  useEffect(() => {
    const map = mapRef.current;

    if (!map) {
      return;
    }

    mapModeRef.current = mapMode;
    map.setStyle(mapStyleForMode(mapMode));
    let cancelled = false;

    const rehydrateStyle = () => {
      if (cancelled) {
        return;
      }

      if (!map.isStyleLoaded()) {
        requestAnimationFrame(rehydrateStyle);
        return;
      }

      ensureOperationalLayers(map, mapModeRef.current);
      syncMapData(
        map,
        routeRef.current,
        candidatesRef.current,
        browseCandidatesRef.current,
        selectedStationIdRef.current,
        hoveredStationIdRef.current,
      );
    };

    requestAnimationFrame(rehydrateStyle);

    return () => {
      cancelled = true;
    };
  }, [mapMode]);

  useEffect(() => {
    const map = mapRef.current;
    if (!map) return;
    fitMapToContent(map, route, candidates);
  }, [route.routeId]); // eslint-disable-line react-hooks/exhaustive-deps

  // Merge candidate lists without duplicates
  const allCandidates = new Map<string, RouteCandidate>();
  candidates.forEach(c => allCandidates.set(c.stationId, c));
  browseCandidates.forEach(c => allCandidates.set(c.stationId, c));

  return (
    <>
      <div ref={containerRef} className="h-full w-full" />
      {mapInstance && <CustomCompass map={mapInstance} candidatesOpen={candidatesOpen} />}
      {mapInstance &&
        Array.from(allCandidates.values()).map((candidate) => (
          <StationMarker
            key={candidate.stationId}
            map={mapInstance}
            candidate={candidate}
            isSelected={selectedStationId === candidate.stationId || hoveredStationId === candidate.stationId}
            isZoomedIn={isZoomedIn}
            isZoomedOut={isZoomedOut}
            onClick={onSelect}
          />
        ))}
    </>
  );
}
