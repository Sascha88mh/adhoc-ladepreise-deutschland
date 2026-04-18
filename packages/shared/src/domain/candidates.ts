import type {
  CandidateFilters,
  RouteCandidate,
  RoutePlan,
  StationDetail,
  StationRecord,
  TariffSummary,
} from "./types";
import { routeCandidateSchema, stationDetailSchema } from "./types";
import { DEMO_STATIONS } from "../fixtures/demo-stations";
import { distanceFromRouteKm } from "../geo/route-corridor";

function normalizePaymentMethod(method: string) {
  const normalized = method.toLowerCase();

  if (normalized === "eccard" || normalized === "creditcard") {
    return "emv";
  }

  if (normalized === "webqr") {
    return "website";
  }

  return normalized;
}

function bestTariff(station: StationRecord) {
  return [...station.tariffs].sort((left, right) => {
    const leftPrice = left.pricePerKwh ?? Number.POSITIVE_INFINITY;
    const rightPrice = right.pricePerKwh ?? Number.POSITIVE_INFINITY;
    return leftPrice - rightPrice;
  })[0];
}

function isFreshEnough(isoTimestamp: string, limitMinutes?: number) {
  if (!limitMinutes) {
    return true;
  }

  const ageMinutes = (Date.now() - new Date(isoTimestamp).getTime()) / 60_000;
  return ageMinutes <= limitMinutes;
}

function includeTariff(tariff: TariffSummary, filters: CandidateFilters) {
  if (filters.maxPriceKwh !== undefined) {
    if (tariff.pricePerKwh == null || tariff.pricePerKwh > filters.maxPriceKwh) {
      return false;
    }
  }

  if (filters.onlyCompletePrices && !tariff.isComplete) {
    return false;
  }

  if (filters.allowSessionFee === false && (tariff.sessionFee ?? 0) > 0) {
    return false;
  }

  if (
    filters.allowBlockingFee === false &&
    ((tariff.blockingFeePerMinute ?? 0) > 0 || tariff.blockingFeeStartsAfterMinutes != null)
  ) {
    return false;
  }

  if (filters.paymentMethods?.length) {
    const supported = new Set(tariff.paymentMethods.map((method) => method.toLowerCase()));
    if (!filters.paymentMethods.every((method) => supported.has(normalizePaymentMethod(method)))) {
      return false;
    }
  }

  return true;
}

function detourMinutes(distanceKm: number, maxPowerKw: number) {
  const base = Math.max(2, Math.round(distanceKm * 2.4));
  return maxPowerKw >= 250 ? Math.max(2, base - 1) : base;
}

export function findCandidatesForRoute(
  route: RoutePlan,
  filters: CandidateFilters = {},
  stations: StationRecord[] = DEMO_STATIONS,
) {
  const candidates = stations
    .map((station) => {
      const distanceKm = distanceFromRouteKm(route.geometry, station.coordinates);
      const candidateTariff = station.tariffs.find((tariff) => includeTariff(tariff, filters)) ?? null;

      return {
        station,
        distanceKm,
        candidateTariff,
      };
    })
    .filter(({ station, distanceKm, candidateTariff }) => {
      if (distanceKm > route.corridorKm) {
        return false;
      }

      if (!candidateTariff) {
        return false;
      }

      if (filters.currentTypes?.length) {
        const set = new Set(station.currentTypes);
        if (!filters.currentTypes.every((type) => set.has(type))) {
          return false;
        }
      }

      if (filters.cpoIds?.length && !filters.cpoIds.includes(station.cpoId)) {
        return false;
      }

      if (filters.minPowerKw && station.maxPowerKw < filters.minPowerKw) {
        return false;
      }

      if (filters.minChargePointCount && station.chargePointCount < filters.minChargePointCount) {
        return false;
      }

      if (filters.availableOnly && station.availabilitySummary.available === 0) {
        return false;
      }

      return (
        isFreshEnough(station.lastStatusUpdateAt, filters.freshWithinMinutes) &&
        isFreshEnough(station.lastPriceUpdateAt, filters.freshWithinMinutes)
      );
    })
    .map(({ station, distanceKm, candidateTariff }) => {
      const tariff = candidateTariff!;

      return routeCandidateSchema.parse({
        stationId: station.stationId,
        stationName: station.name,
        cpoId: station.cpoId,
        cpoName: station.cpoName,
        lat: station.coordinates.lat,
        lng: station.coordinates.lng,
        addressLine: station.addressLine,
        city: station.city,
        distanceFromRouteKm: Number(distanceKm.toFixed(1)),
        detourMinutes: detourMinutes(distanceKm, station.maxPowerKw),
        maxPowerKw: station.maxPowerKw,
        chargePointCount: station.chargePointCount,
        currentTypes: station.currentTypes,
        connectorTypes: station.connectorTypes,
        availabilitySummary: station.availabilitySummary,
        tariffSummary: tariff,
        paymentMethods: Array.from(
          new Set([...station.paymentMethods, ...tariff.paymentMethods]),
        ),
        lastPriceUpdateAt: station.lastPriceUpdateAt,
        lastStatusUpdateAt: station.lastStatusUpdateAt,
        freshnessMinutes: Math.max(
          0,
          Math.round(
            (Date.now() - new Date(station.lastStatusUpdateAt).getTime()) / 60_000,
          ),
        ),
      });
    });

  const sortMode = filters.sort ?? "price";
  candidates.sort((left, right) => {
    if (sortMode === "power") {
      return right.maxPowerKw - left.maxPowerKw || left.detourMinutes - right.detourMinutes;
    }

    if (sortMode === "detour") {
      return left.detourMinutes - right.detourMinutes || (left.tariffSummary.pricePerKwh ?? 999) - (right.tariffSummary.pricePerKwh ?? 999);
    }

    return (
      (left.tariffSummary.pricePerKwh ?? Number.POSITIVE_INFINITY) -
        (right.tariffSummary.pricePerKwh ?? Number.POSITIVE_INFINITY) ||
      left.detourMinutes - right.detourMinutes ||
      right.maxPowerKw - left.maxPowerKw
    );
  });

  const providerMap = new Map<string, { cpoId: string; cpoName: string; stations: number }>();
  for (const candidate of candidates) {
    const current = providerMap.get(candidate.cpoId);
    if (current) {
      current.stations += 1;
    } else {
      providerMap.set(candidate.cpoId, {
        cpoId: candidate.cpoId,
        cpoName: candidate.cpoName,
        stations: 1,
      });
    }
  }

  const pricePoints = candidates
    .map((candidate) => candidate.tariffSummary.pricePerKwh)
    .filter((value): value is number => value != null);

  return {
    candidates,
    providerList: [...providerMap.values()].sort((left, right) => right.stations - left.stations),
    priceBand: {
      min: pricePoints.length ? Math.min(...pricePoints) : null,
      max: pricePoints.length ? Math.max(...pricePoints) : null,
    },
  };
}

export function getStationDetail(stationId: string, stations: StationRecord[] = DEMO_STATIONS): StationDetail | null {
  const station = stations.find((candidate) => candidate.stationId === stationId);

  if (!station) {
    return null;
  }

  return stationDetailSchema.parse({
    ...station,
    exportTargets: {
      googleMaps: `https://www.google.com/maps/dir/?api=1&destination=${station.coordinates.lat},${station.coordinates.lng}`,
      appleMaps: `https://maps.apple.com/?daddr=${station.coordinates.lat},${station.coordinates.lng}&dirflg=d`,
      waze: `https://waze.com/ul?ll=${station.coordinates.lat},${station.coordinates.lng}&navigate=yes`,
      coordinates: `${station.coordinates.lat.toFixed(5)}, ${station.coordinates.lng.toFixed(5)}`,
    },
  });
}

export function getCpoList(stations: StationRecord[] = DEMO_STATIONS) {
  const grouped = new Map<string, { id: string; name: string; stations: number }>();

  for (const station of stations) {
    const current = grouped.get(station.cpoId);
    if (current) {
      current.stations += 1;
    } else {
      grouped.set(station.cpoId, {
        id: station.cpoId,
        name: station.cpoName,
        stations: 1,
      });
    }
  }

  return [...grouped.values()].sort((left, right) => left.name.localeCompare(right.name));
}

export function getBestTariffForStation(station: StationRecord) {
  return bestTariff(station);
}
