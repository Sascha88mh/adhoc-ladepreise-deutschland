"use client";

import { useEffect, useRef } from "react";
import maplibregl, {
  type GeoJSONSource,
  type Map,
  type StyleSpecification,
} from "maplibre-gl";
import type { RouteCandidate, RoutePlan } from "@adhoc/shared";

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
};

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
  map: Map,
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

function ensureOperationalLayers(map: Map, mapMode: MapMode) {
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

  if (!map.getLayer("browse-circles")) {
    map.addLayer({
      id: "browse-circles",
      type: "circle",
      source: "browse",
      paint: {
        "circle-color": [
          "case",
          [">", ["get", "available"], 0],
          "#2f8577",
          "#d09a4a",
        ],
        "circle-radius": [
          "case",
          [">=", ["get", "power"], 250],
          8,
          [">=", ["get", "power"], 150],
          7,
          5.5,
        ],
        "circle-opacity": 0.72,
        "circle-stroke-width": 1.6,
        "circle-stroke-color": palette.candidateStroke,
      },
    });
  }

  if (!map.getLayer("candidate-circles")) {
    map.addLayer({
      id: "candidate-circles",
      type: "circle",
      source: "candidates",
      paint: {
        "circle-color": [
          "case",
          [">", ["get", "available"], 0],
          "#156f63",
          "#b96710",
        ],
        "circle-radius": [
          "case",
          [">=", ["get", "power"], 250],
          11,
          [">=", ["get", "power"], 150],
          9,
          7,
        ],
        "circle-stroke-width": 2.4,
        "circle-stroke-color": palette.candidateStroke,
      },
    });
  }

  if (!map.getLayer("selected-circle")) {
    map.addLayer({
      id: "selected-circle",
      type: "circle",
      source: "selected",
      paint: {
        "circle-color": palette.selectedFill,
        "circle-radius": 16,
        "circle-stroke-width": 4,
        "circle-stroke-color": palette.selectedStroke,
        "circle-opacity": 0.78,
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
  map.setPaintProperty("browse-circles", "circle-stroke-color", palette.candidateStroke);
  map.setPaintProperty("candidate-circles", "circle-stroke-color", palette.candidateStroke);
  map.setPaintProperty("selected-circle", "circle-color", palette.selectedFill);
  map.setPaintProperty("selected-circle", "circle-stroke-color", palette.selectedStroke);
  map.setPaintProperty("focus-halo", "circle-color", palette.focusHalo);
  map.setPaintProperty("focus-halo", "circle-stroke-color", palette.focusCore);
  map.setPaintProperty("focus-core", "circle-color", palette.focusCore);
}

function syncMapData(
  map: Map,
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

function fitMapToContent(map: Map, route: RoutePlan, candidates: RouteCandidate[]) {
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
}: Props) {
  const containerRef = useRef<HTMLDivElement | null>(null);
  const mapRef = useRef<Map | null>(null);
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

    map.addControl(new maplibregl.NavigationControl(), "top-right");
    mapRef.current = map;

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
    map.on("click", "candidate-circles", (event) => {
      const feature = event.features?.[0];
      const id = feature?.properties?.id;

      if (typeof id === "string") {
        onSelectRef.current(id);
      }
    });
    map.on("mouseenter", "candidate-circles", () => {
      map.getCanvas().style.cursor = "pointer";
    });
    map.on("mouseleave", "candidate-circles", () => {
      map.getCanvas().style.cursor = "";
    });
    map.on("click", "browse-circles", (event) => {
      const feature = event.features?.[0];
      const id = feature?.properties?.id;

      if (typeof id === "string") {
        onSelectRef.current(id);
      }
    });
    map.on("click", (event) => {
      const features = map.queryRenderedFeatures(event.point, {
        layers: ["candidate-circles", "browse-circles"],
      });

      if (features.length === 0) {
        onSelectRef.current(null);
      }
    });
    map.on("mouseenter", "browse-circles", () => {
      map.getCanvas().style.cursor = "pointer";
    });
    map.on("mouseleave", "browse-circles", () => {
      map.getCanvas().style.cursor = "";
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

    return () => {
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

    if (!map || !map.isStyleLoaded()) {
      return;
    }

    fitMapToContent(map, route, candidates);
  }, [route.routeId]);

  return <div ref={containerRef} className="h-full w-full" />;
}
