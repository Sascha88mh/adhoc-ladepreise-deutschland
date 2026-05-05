"use client";

import { useEffect, useRef, useState } from "react";
import maplibregl, {
  type GeoJSONSource,
  type Map as MaplibreMap,
  type MapLayerMouseEvent,
  type StyleSpecification,
} from "maplibre-gl";
import type { CandidateFilters, RouteCandidate, RoutePlan } from "@adhoc/shared";
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

const INTERACTIVE_STATION_LAYERS = [
  "browse-points",
  "candidate-halo",
  "candidate-points",
  "browse-power-labels",
  "candidate-power-labels",
] as const;
const STATION_TILE_SOURCE_ID = "station-tiles";
const STATION_TILE_SOURCE_LAYER = "stations";
const STATION_TILE_FILTER_LAYERS = ["browse-points", "browse-power-labels"] as const;
const STATION_TILE_MIN_ZOOM = 4;
const STATION_TILE_MAX_ZOOM = 14;
const STATION_TILE_URL_TEMPLATE =
  process.env.NEXT_PUBLIC_MAP_TILE_URL ??
  "/api/public/stations/tiles/{z}/{x}/{y}";

const SATELLITE_STYLE: StyleSpecification = {
  version: 8,
  glyphs: "https://demotiles.maplibre.org/font/{fontstack}/{range}.pbf",
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

export type MapViewport = {
  lat: number;
  lng: number;
  zoom: number;
  bearing: number;
  pitch: number;
};

type Props = {
  route: RoutePlan;
  candidates: RouteCandidate[];
  browseCandidates: RouteCandidate[];
  filters: CandidateFilters;
  selectedStationId: string | null;
  hoveredStationId: string | null;
  onSelect: (stationId: string | null) => void;
  onViewportChange?: (state: {
    bounds: {
      minLat: number;
      minLng: number;
      maxLat: number;
      maxLng: number;
    };
    viewport: MapViewport;
  }) => void;
  mapMode: MapMode;
  initialViewport?: MapViewport | null;
  preserveViewport?: boolean;
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

function stationTileUrl() {
  if (/^https?:\/\//.test(STATION_TILE_URL_TEMPLATE)) {
    return STATION_TILE_URL_TEMPLATE;
  }

  if (typeof window === "undefined") {
    return STATION_TILE_URL_TEMPLATE;
  }

  const path = STATION_TILE_URL_TEMPLATE.startsWith("/")
    ? STATION_TILE_URL_TEMPLATE
    : `/${STATION_TILE_URL_TEMPLATE}`;
  return `${window.location.origin}${path}`;
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
  const now = Date.now();
  return {
    type: "FeatureCollection" as const,
    features: candidates.map((candidate, index) => {
      const lastStatusMs = new Date(candidate.lastStatusUpdateAt).getTime();
      const statusAgeMin = lastStatusMs === 0
        ? 2147483647
        : Math.floor((now - lastStatusMs) / 60000);
      return {
        type: "Feature" as const,
        geometry: {
          type: "Point" as const,
          coordinates: [candidate.lng, candidate.lat],
        },
        properties: {
          id: candidate.stationId,
          rank: index + 1,
          available: candidate.availabilitySummary.available,
          status_age_min: statusAgeMin,
          power: candidate.maxPowerKw,
          price: candidate.tariffSummary.pricePerKwh ?? 9,
        },
      };
    }),
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

type SelectedTileFeature = {
  stationId: string;
  lng: number;
  lat: number;
};

function selectedCollection(
  candidates: RouteCandidate[],
  browseCandidates: RouteCandidate[],
  selectedStationId: string | null,
  hoveredStationId: string | null,
  selectedTileFeature: SelectedTileFeature | null,
) {
  const highlighted = [...candidates, ...browseCandidates].find(
    (candidate) =>
      candidate.stationId === selectedStationId ||
      candidate.stationId === hoveredStationId,
  );
  const highlightedTile =
    !highlighted &&
    selectedTileFeature &&
    (selectedTileFeature.stationId === selectedStationId ||
      selectedTileFeature.stationId === hoveredStationId)
      ? selectedTileFeature
      : null;

  return {
    type: "FeatureCollection" as const,
    features: highlighted || highlightedTile
      ? [
          {
            type: "Feature" as const,
            geometry: {
              type: "Point" as const,
              coordinates: highlighted
                ? [highlighted.lng, highlighted.lat]
                : [highlightedTile!.lng, highlightedTile!.lat],
            },
            properties: {
              id: highlighted?.stationId ?? highlightedTile!.stationId,
            },
          },
        ]
      : [],
  };
}

function paymentProperty(method: string) {
  const normalized = method.toLowerCase();

  if (normalized === "eccard" || normalized === "creditcard") {
    return "pay_emv";
  }

  if (normalized === "applepay") {
    return "pay_applepay";
  }

  if (normalized === "googlepay") {
    return "pay_googlepay";
  }

  if (normalized === "webqr") {
    return "pay_website";
  }

  return null;
}

function stationTileFilter(filters: CandidateFilters) {
  const clauses: unknown[] = ["all"];
  const useHpcPrice =
    filters.currentTypes?.includes("DC") &&
    (filters.minPowerKw ?? 0) >= 100 &&
    filters.maxPowerKw === undefined;
  const hasPriceProperty = useHpcPrice ? "hpc_has_price" : "has_price";
  const minPriceProperty = useHpcPrice ? "hpc_min_price_ct" : "min_price_ct";
  const maxPriceProperty = useHpcPrice ? "hpc_max_price_ct" : "max_price_ct";

  if (filters.currentTypes?.includes("AC")) {
    clauses.push(["==", ["get", "has_ac"], 1]);
  }

  if (filters.currentTypes?.includes("DC")) {
    clauses.push(["==", ["get", "has_dc"], 1]);
  }

  if (filters.minPowerKw !== undefined) {
    clauses.push([">=", ["get", "power_kw"], filters.minPowerKw]);
  }

  if (filters.maxPowerKw !== undefined) {
    clauses.push(["<=", ["get", "power_kw"], filters.maxPowerKw]);
  }

  if (filters.minChargePointCount !== undefined) {
    clauses.push([">=", ["get", "charge_points"], filters.minChargePointCount]);
  }

  if (filters.maxChargePointCount !== undefined) {
    clauses.push(["<=", ["get", "charge_points"], filters.maxChargePointCount]);
  }

  if (filters.availableOnly) {
    clauses.push([">", ["get", "available"], 0]);
  }

  if (filters.minPriceKwh !== undefined || filters.maxPriceKwh !== undefined) {
    clauses.push(["==", ["get", hasPriceProperty], 1]);
  }

  if (filters.minPriceKwh !== undefined) {
    clauses.push([">=", ["get", maxPriceProperty], Math.round(filters.minPriceKwh * 100)]);
  }

  if (filters.maxPriceKwh !== undefined) {
    clauses.push(["<=", ["get", minPriceProperty], Math.round(filters.maxPriceKwh * 100)]);
  }

  if (filters.onlyCompletePrices) {
    clauses.push(["==", ["get", "complete_price"], 1]);
  }

  if (filters.allowSessionFee === false) {
    clauses.push(["==", ["get", "has_session_fee"], 0]);
  }

  if (filters.allowBlockingFee === false) {
    clauses.push(["==", ["get", "has_blocking_fee"], 0]);
  }

  if (filters.freshWithinMinutes !== undefined) {
    clauses.push(["<=", ["get", "status_age_min"], filters.freshWithinMinutes]);
    clauses.push(["<=", ["get", "price_age_min"], filters.freshWithinMinutes]);
  }

  if (filters.cpoIds?.length) {
    clauses.push(["in", ["get", "cpo"], ["literal", filters.cpoIds]]);
  }

  const paymentProperties = new Set(
    (filters.paymentMethods ?? [])
      .map(paymentProperty)
      .filter((property) => property != null),
  );
  for (const property of paymentProperties) {
    clauses.push(["==", ["get", property], 1]);
  }

  return clauses.length > 1 ? clauses : null;
}

function applyStationTileFilter(map: MaplibreMap, filters: CandidateFilters) {
  const filter = stationTileFilter(filters);

  for (const layerId of STATION_TILE_FILTER_LAYERS) {
    if (map.getLayer(layerId)) {
      map.setFilter(
        layerId,
        filter as Parameters<MaplibreMap["setFilter"]>[1],
      );
    }
  }
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

  if (!map.getSource(STATION_TILE_SOURCE_ID)) {
    map.addSource(STATION_TILE_SOURCE_ID, {
      type: "vector",
      tiles: [stationTileUrl()],
      minzoom: STATION_TILE_MIN_ZOOM,
      maxzoom: STATION_TILE_MAX_ZOOM,
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

  if (!map.getLayer("browse-points")) {
    map.addLayer({
      id: "browse-points",
      type: "circle",
      source: STATION_TILE_SOURCE_ID,
      "source-layer": STATION_TILE_SOURCE_LAYER,
      paint: {
        "circle-color": [
          "case",
          [">", ["get", "status_age_min"], 60],
          "#4b5563",
          [">", ["coalesce", ["get", "available"], 0], 0],
          "#156f63",
          "#d09a4a",
        ],
        "circle-radius": [
          "interpolate",
          ["linear"],
          ["zoom"],
          5, 1.8,
          9, 3.2,
          11, 5.4,
          12, 9.5,
          14, 11.3,
          16, 13.0,
        ],
        "circle-opacity": [
          "interpolate",
          ["linear"],
          ["zoom"],
          5,
          0.6,
          10,
          0.78,
        ],
        "circle-stroke-color": "#ffffff",
        "circle-stroke-opacity": [
          "interpolate",
          ["linear"],
          ["zoom"],
          8,
          0,
          11,
          0.82,
        ],
        "circle-stroke-width": [
          "interpolate",
          ["linear"],
          ["zoom"],
          8,
          0,
          12,
          1.2,
        ],
      },
    });
  }

  if (!map.getLayer("candidate-halo")) {
    map.addLayer({
      id: "candidate-halo",
      type: "circle",
      source: "candidates",
      paint: {
        "circle-color": palette.line,
        "circle-opacity": [
          "interpolate",
          ["linear"],
          ["zoom"],
          5,
          0.18,
          10,
          0.3,
          14,
          0.42,
        ],
        "circle-radius": [
          "interpolate",
          ["linear"],
          ["zoom"],
          5,
          7,
          9,
          12,
          12,
          20,
          16,
          28,
        ],
        "circle-stroke-color": palette.line,
        "circle-stroke-width": [
          "interpolate",
          ["linear"],
          ["zoom"],
          8,
          1,
          13,
          3,
        ],
        "circle-stroke-opacity": 0.82,
      },
    });
  }

  if (!map.getLayer("candidate-points")) {
    map.addLayer({
      id: "candidate-points",
      type: "circle",
      source: "candidates",
      paint: {
        "circle-color": [
          "case",
          [">", ["coalesce", ["get", "status_age_min"], 2147483647], 60],
          "#4b5563",
          [">", ["coalesce", ["get", "available"], 0], 0],
          "#156f63",
          "#d09a4a",
        ],
        "circle-radius": [
          "interpolate",
          ["linear"],
          ["zoom"],
          5, 4.0,
          9, 6.4,
          11, 9.4,
          12, 13.8,
          14, 16.5,
          16, 18.5,
        ],
        "circle-opacity": 0.96,
        "circle-stroke-color": palette.candidateStroke,
        "circle-stroke-width": [
          "interpolate",
          ["linear"],
          ["zoom"],
          8,
          0.8,
          13,
          2,
        ],
      },
    });
  }

  if (!map.getLayer("browse-power-labels")) {
    map.addLayer({
      id: "browse-power-labels",
      type: "symbol",
      source: STATION_TILE_SOURCE_ID,
      "source-layer": STATION_TILE_SOURCE_LAYER,
      minzoom: 12,
      layout: {
        "text-field": ["to-string", ["get", "power_kw"]],
        "text-size": [
          "interpolate",
          ["linear"],
          ["zoom"],
          12,
          9,
          15,
          11,
        ],
        "text-font": ["Open Sans Bold", "Arial Unicode MS Bold"],
        "text-allow-overlap": false,
        "text-ignore-placement": false,
      },
      paint: {
        "text-color": "#ffffff",
        "text-halo-color": "rgba(15, 23, 42, 0.46)",
        "text-halo-width": 0.7,
      },
    });
  }

  if (!map.getLayer("candidate-power-labels")) {
    map.addLayer({
      id: "candidate-power-labels",
      type: "symbol",
      source: "candidates",
      minzoom: 8,
      layout: {
        "text-field": [
          "concat",
          ["to-string", ["get", "rank"]],
          " · ",
          ["to-string", ["get", "power"]],
          " kW",
        ],
        "text-size": [
          "interpolate",
          ["linear"],
          ["zoom"],
          8,
          10,
          15,
          12.5,
        ],
        "text-font": ["Open Sans Bold", "Arial Unicode MS Bold"],
        "text-allow-overlap": true,
        "text-ignore-placement": true,
        "text-offset": [0, 1.35],
      },
      paint: {
        "text-color": "#ffffff",
        "text-halo-color": "rgba(15, 23, 42, 0.78)",
        "text-halo-width": 1.4,
      },
    });
  }

  if (!map.getLayer("selected-ring")) {
    map.addLayer({
      id: "selected-ring",
      type: "circle",
      source: "selected",
      paint: {
        "circle-color": palette.selectedFill,
        "circle-opacity": 0.18,
        "circle-radius": [
          "interpolate",
          ["linear"],
          ["zoom"],
          5,
          8,
          12,
          17,
          15,
          23,
        ],
        "circle-stroke-color": palette.selectedStroke,
        "circle-stroke-width": 3,
        "circle-stroke-opacity": 0.95,
      },
    });
  }

  map.setPaintProperty("route-glow", "line-color", palette.glow);
  map.setPaintProperty("route-line", "line-color", palette.line);
  map.setPaintProperty("candidate-halo", "circle-color", palette.line);
  map.setPaintProperty("candidate-halo", "circle-stroke-color", palette.line);
  map.setPaintProperty("focus-halo", "circle-color", palette.focusHalo);
  map.setPaintProperty("focus-halo", "circle-stroke-color", palette.focusCore);
  map.setPaintProperty("focus-core", "circle-color", palette.focusCore);
  map.setPaintProperty("candidate-points", "circle-stroke-color", palette.candidateStroke);
  map.setPaintProperty("selected-ring", "circle-color", palette.selectedFill);
  map.setPaintProperty("selected-ring", "circle-stroke-color", palette.selectedStroke);
}

function syncMapData(
  map: MaplibreMap,
  route: RoutePlan,
  candidates: RouteCandidate[],
  browseCandidates: RouteCandidate[],
  selectedStationId: string | null,
  hoveredStationId: string | null,
  selectedTileFeature: SelectedTileFeature | null,
) {
  updateSource(
    map,
    "route",
    isLocationFocusRoute(route) ? emptyCollection() : routeCollection(route),
  );
  updateSource(map, "candidates", candidateCollection(candidates));
  updateSource(
    map,
    "selected",
    selectedCollection(
      candidates,
      browseCandidates,
      selectedStationId,
      hoveredStationId,
      selectedTileFeature,
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
  filters,
  selectedStationId,
  hoveredStationId,
  onSelect,
  onViewportChange,
  mapMode,
  initialViewport,
  preserveViewport = false,
  candidatesOpen,
}: Props) {
  const [mapInstance, setMapInstance] = useState<MaplibreMap | null>(null);
  const [mapError, setMapError] = useState<string | null>(null);
  const containerRef = useRef<HTMLDivElement | null>(null);
  const mapRef = useRef<MaplibreMap | null>(null);
  const onSelectRef = useRef(onSelect);
  const routeRef = useRef(route);
  const candidatesRef = useRef(candidates);
  const browseCandidatesRef = useRef(browseCandidates);
  const filtersRef = useRef(filters);
  const selectedStationIdRef = useRef(selectedStationId);
  const hoveredStationIdRef = useRef(hoveredStationId);
  const selectedTileFeatureRef = useRef<SelectedTileFeature | null>(null);
  const mapModeRef = useRef(mapMode);
  const onViewportChangeRef = useRef(onViewportChange);
  const preserveViewportRef = useRef(preserveViewport);
  const initialViewportRef = useRef(initialViewport);

  useEffect(() => {
    onSelectRef.current = onSelect;
  }, [onSelect]);

  useEffect(() => {
    onViewportChangeRef.current = onViewportChange;
  }, [onViewportChange]);

  useEffect(() => {
    preserveViewportRef.current = preserveViewport;
  }, [preserveViewport]);

  useEffect(() => {
    routeRef.current = route;
    candidatesRef.current = candidates;
    browseCandidatesRef.current = browseCandidates;
    filtersRef.current = filters;
    selectedStationIdRef.current = selectedStationId;
    hoveredStationIdRef.current = hoveredStationId;
    mapModeRef.current = mapMode;
  }, [route, candidates, browseCandidates, filters, selectedStationId, hoveredStationId, mapMode]);

  useEffect(() => {
    if (!containerRef.current || mapRef.current) {
      return;
    }

    let map: MaplibreMap;

    try {
      map = new maplibregl.Map({
        container: containerRef.current,
        style: mapStyleForMode(mapModeRef.current),
        center: [
          initialViewportRef.current?.lng ?? routeRef.current.origin.coordinates.lng,
          initialViewportRef.current?.lat ?? routeRef.current.origin.coordinates.lat,
        ],
        zoom: initialViewportRef.current?.zoom ?? (isLocationFocusRoute(routeRef.current) ? 14 : 6),
        bearing: initialViewportRef.current?.bearing ?? 0,
        pitch: initialViewportRef.current?.pitch ?? 20,
        maxZoom: 16,
        attributionControl: false,
      });
    } catch {
      containerRef.current.replaceChildren();
      window.queueMicrotask(() => {
        setMapError("Karte konnte in diesem Browser nicht gestartet werden.");
      });
      return;
    }

    mapRef.current = map;
    setMapInstance(map);
    setMapError(null);

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
        selectedTileFeatureRef.current,
      );
      applyStationTileFilter(map, filtersRef.current);

      if (!preserveViewportRef.current) {
        fitMapToContent(map, currentRoute, currentCandidates);
      }
    };

    const emitViewport = () => {
      const bounds = map.getBounds();
      const center = map.getCenter();
      onViewportChangeRef.current?.({
        bounds: {
          minLat: bounds.getSouth(),
          minLng: bounds.getWest(),
          maxLat: bounds.getNorth(),
          maxLng: bounds.getEast(),
        },
        viewport: {
          lat: center.lat,
          lng: center.lng,
          zoom: map.getZoom(),
          bearing: map.getBearing(),
          pitch: map.getPitch(),
        },
      });
    };

    map.on("load", renderCurrentState);
    map.on("load", emitViewport);
    map.on("click", (event) => {
      const interactiveFeatures = map.queryRenderedFeatures(event.point, {
        layers: [...INTERACTIVE_STATION_LAYERS],
      });

      if (interactiveFeatures.length > 0) {
        return;
      }

      onSelectRef.current(null);
    });
    map.on("moveend", () => {
      emitViewport();
    });

    const selectFeature = (event: MapLayerMouseEvent) => {
      const feature = event.features?.[0];
      const id = feature?.properties?.id;
      if (typeof id === "string") {
        if (feature?.geometry.type === "Point") {
          const coordinates = feature.geometry.coordinates;
          if (
            Array.isArray(coordinates) &&
            typeof coordinates[0] === "number" &&
            typeof coordinates[1] === "number"
          ) {
            selectedTileFeatureRef.current = {
              stationId: id,
              lng: coordinates[0],
              lat: coordinates[1],
            };
          }
        }
        onSelectRef.current(id);
      }
    };
    const enablePointer = () => {
      map.getCanvas().style.cursor = "pointer";
    };
    const disablePointer = () => {
      map.getCanvas().style.cursor = "";
    };

    for (const layerId of INTERACTIVE_STATION_LAYERS) {
      map.on("click", layerId, selectFeature);
      map.on("mouseenter", layerId, enablePointer);
      map.on("mouseleave", layerId, disablePointer);
    }

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
        } catch {
          // Layer might be rendering or map disconnected temporarily
        }
      }
      frameId = requestAnimationFrame(animatePulse);
    };
    frameId = requestAnimationFrame(animatePulse);

    return () => {
      cancelAnimationFrame(frameId);
      for (const layerId of INTERACTIVE_STATION_LAYERS) {
        map.off("click", layerId, selectFeature);
        map.off("mouseenter", layerId, enablePointer);
        map.off("mouseleave", layerId, disablePointer);
      }
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
        selectedTileFeatureRef.current,
      );
      applyStationTileFilter(map, filters);
    };

    if (!map.isStyleLoaded()) {
      return;
    }

    apply();
  }, [route, candidates, browseCandidates, filters, selectedStationId, hoveredStationId, mapMode]);

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
        selectedTileFeatureRef.current,
      );
      applyStationTileFilter(map, filtersRef.current);
    };

    requestAnimationFrame(rehydrateStyle);

    return () => {
      cancelled = true;
    };
  }, [mapMode]);

  useEffect(() => {
    const map = mapRef.current;
    if (!map) return;
    if (preserveViewport) return;
    fitMapToContent(map, route, candidates);
  }, [route.routeId, preserveViewport]); // eslint-disable-line react-hooks/exhaustive-deps

  return (
    <div className="relative h-full w-full">
      <div ref={containerRef} className="h-full w-full" />
      {mapError && (
        <div className="absolute inset-0 flex items-center justify-center bg-[var(--background)] px-6 text-center">
          <div className="glass-panel-strong max-w-sm rounded-[28px] px-6 py-5 text-sm text-[var(--foreground)] shadow-2xl">
            {mapError}
          </div>
        </div>
      )}
      {mapInstance && !mapError && (
        <CustomCompass map={mapInstance} candidatesOpen={candidatesOpen} />
      )}
    </div>
  );
}
