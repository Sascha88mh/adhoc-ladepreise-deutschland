"use client";

import { useEffect, useRef } from "react";
import maplibregl, { type GeoJSONSource, type Map } from "maplibre-gl";
import type { RouteCandidate, RoutePlan } from "@adhoc/shared";

const MAP_STYLE =
  process.env.NEXT_PUBLIC_MAP_STYLE ??
  "https://basemaps.cartocdn.com/gl/positron-gl-style/style.json";

type Props = {
  route: RoutePlan;
  candidates: RouteCandidate[];
  selectedStationId: string | null;
  hoveredStationId: string | null;
  onSelect: (stationId: string) => void;
};

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

function updateSource(
  map: Map,
  sourceId: string,
  data: Parameters<GeoJSONSource["setData"]>[0],
) {
  const source = map.getSource(sourceId) as GeoJSONSource | undefined;
  source?.setData(data);
}

export function RouteMap({
  route,
  candidates,
  selectedStationId,
  hoveredStationId,
  onSelect,
}: Props) {
  const containerRef = useRef<HTMLDivElement | null>(null);
  const mapRef = useRef<Map | null>(null);
  const onSelectRef = useRef(onSelect);

  useEffect(() => {
    onSelectRef.current = onSelect;
  }, [onSelect]);

  useEffect(() => {
    if (!containerRef.current || mapRef.current) {
      return;
    }

    const map = new maplibregl.Map({
      container: containerRef.current,
      style: MAP_STYLE,
      center: [route.origin.coordinates.lng, route.origin.coordinates.lat],
      zoom: 6,
      pitch: 20,
      maxZoom: 16,
      attributionControl: false,
    });

    map.addControl(new maplibregl.NavigationControl(), "top-right");

    map.on("load", () => {
      map.addSource("route", {
        type: "geojson",
        data: routeCollection(route),
      });
      map.addSource("candidates", {
        type: "geojson",
        data: candidateCollection(candidates),
      });
      map.addSource("selected", {
        type: "geojson",
        data: {
          type: "FeatureCollection",
          features: [],
        },
      });

      map.addLayer({
        id: "route-glow",
        type: "line",
        source: "route",
        paint: {
          "line-color": "rgba(21,111,99,0.2)",
          "line-width": 18,
          "line-blur": 12,
        },
      });

      map.addLayer({
        id: "route-line",
        type: "line",
        source: "route",
        paint: {
          "line-color": "#156f63",
          "line-width": 5,
        },
      });

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
          "circle-stroke-color": "#ffffff",
        },
      });

      map.addLayer({
        id: "selected-circle",
        type: "circle",
        source: "selected",
        paint: {
          "circle-color": "#ffffff",
          "circle-radius": 16,
          "circle-stroke-width": 4,
          "circle-stroke-color": "#156f63",
          "circle-opacity": 0.7,
        },
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

      const highlighted = candidates.find(
        (candidate) =>
          candidate.stationId === selectedStationId ||
          candidate.stationId === hoveredStationId,
      );

      updateSource(map, "selected", {
        type: "FeatureCollection",
        features: highlighted
          ? [
              {
                type: "Feature",
                geometry: {
                  type: "Point",
                  coordinates: [highlighted.lng, highlighted.lat],
                },
                properties: {
                  id: highlighted.stationId,
                },
              },
            ]
          : [],
      });

      const bounds = new maplibregl.LngLatBounds();
      route.geometry.forEach((point) => bounds.extend([point.lng, point.lat]));
      map.fitBounds(bounds, { padding: 90, duration: 700 });
    });

    mapRef.current = map;

    return () => {
      map.remove();
      mapRef.current = null;
    };
  }, [route, candidates, hoveredStationId, selectedStationId]);

  useEffect(() => {
    const map = mapRef.current;
    if (!map?.isStyleLoaded()) {
      return;
    }

    updateSource(map, "route", routeCollection(route));
    updateSource(map, "candidates", candidateCollection(candidates));

    const highlighted = candidates.find(
      (candidate) => candidate.stationId === selectedStationId || candidate.stationId === hoveredStationId,
    );

    updateSource(map, "selected", {
      type: "FeatureCollection",
      features: highlighted
        ? [
            {
              type: "Feature",
              geometry: {
                type: "Point",
                coordinates: [highlighted.lng, highlighted.lat],
              },
              properties: {
                id: highlighted.stationId,
              },
            },
          ]
        : [],
    });

  }, [route, candidates, selectedStationId, hoveredStationId]);

  useEffect(() => {
    const map = mapRef.current;

    if (!map?.isStyleLoaded()) {
      return;
    }

    const bounds = new maplibregl.LngLatBounds();
    route.geometry.forEach((point) => bounds.extend([point.lng, point.lat]));
    map.fitBounds(bounds, { padding: 90, duration: 700 });
  }, [route]);

  return <div ref={containerRef} className="h-full w-full" />;
}
