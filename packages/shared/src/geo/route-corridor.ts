import type { Coordinate } from "../domain/types";
import { haversineKm } from "./haversine";

type SegmentProjection = {
  distanceKm: number;
  ratio: number;
};

function project(point: Coordinate) {
  const scale = Math.cos((point.lat * Math.PI) / 180);
  return {
    x: point.lng * 111.32 * scale,
    y: point.lat * 110.574,
  };
}

function projectToSegment(point: Coordinate, start: Coordinate, end: Coordinate): SegmentProjection {
  const p = project(point);
  const a = project(start);
  const b = project(end);
  const abx = b.x - a.x;
  const aby = b.y - a.y;
  const apx = p.x - a.x;
  const apy = p.y - a.y;
  const denominator = abx ** 2 + aby ** 2;

  if (denominator === 0) {
    return {
      distanceKm: haversineKm(point, start),
      ratio: 0,
    };
  }

  const ratio = Math.max(0, Math.min(1, (apx * abx + apy * aby) / denominator));
  const projection = {
    x: a.x + abx * ratio,
    y: a.y + aby * ratio,
  };

  return {
    distanceKm: Math.hypot(p.x - projection.x, p.y - projection.y),
    ratio,
  };
}

export function distanceFromRouteKm(route: Coordinate[], point: Coordinate) {
  let minimum = Number.POSITIVE_INFINITY;

  for (let index = 1; index < route.length; index += 1) {
    minimum = Math.min(
      minimum,
      projectToSegment(point, route[index - 1], route[index]).distanceKm,
    );
  }

  return Number.isFinite(minimum) ? minimum : 0;
}

export function routeProgressAtNearestPointKm(route: Coordinate[], point: Coordinate) {
  let minimum = Number.POSITIVE_INFINITY;
  let distanceFromStartKm = 0;
  let travelledKm = 0;

  for (let index = 1; index < route.length; index += 1) {
    const start = route[index - 1];
    const end = route[index];
    const segmentDistanceKm = haversineKm(start, end);
    const projection = projectToSegment(point, start, end);

    if (projection.distanceKm < minimum) {
      minimum = projection.distanceKm;
      distanceFromStartKm = travelledKm + segmentDistanceKm * projection.ratio;
    }

    travelledKm += segmentDistanceKm;
  }

  return {
    distanceFromRouteKm: Number.isFinite(minimum) ? minimum : 0,
    distanceFromStartKm,
  };
}

export function routeBounds(route: Coordinate[]) {
  return route.reduce(
    (accumulator, point) => ({
      minLat: Math.min(accumulator.minLat, point.lat),
      minLng: Math.min(accumulator.minLng, point.lng),
      maxLat: Math.max(accumulator.maxLat, point.lat),
      maxLng: Math.max(accumulator.maxLng, point.lng),
    }),
    {
      minLat: Number.POSITIVE_INFINITY,
      minLng: Number.POSITIVE_INFINITY,
      maxLat: Number.NEGATIVE_INFINITY,
      maxLng: Number.NEGATIVE_INFINITY,
    },
  );
}
