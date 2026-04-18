import type {
  ChargePointStatus,
  Coordinate,
  CurrentType,
  StationRecord,
  TariffSummary,
} from "../domain/types";

export type ParsedConnector = {
  connectorType: string;
  maxPowerKw: number | null;
};

export type ParsedTariff = TariffSummary & {
  id: string;
};

export type ParsedChargePoint = {
  chargePointCode: string;
  currentType: CurrentType;
  maxPowerKw: number;
  connectors: ParsedConnector[];
  tariffs: ParsedTariff[];
};

export type ParsedStationCatalog = {
  stationCode: string;
  cpoId: string;
  cpoName: string;
  name: string;
  addressLine: string;
  city: string;
  postalCode: string;
  countryCode: string;
  coordinates: Coordinate;
  chargePointCount: number;
  currentTypes: CurrentType[];
  connectorTypes: string[];
  paymentMethods: string[];
  maxPowerKw: number;
  chargePoints: ParsedChargePoint[];
  notes: string[];
};

export type ParsedStaticFeed = {
  stations: StationRecord[];
  catalog: ParsedStationCatalog[];
};

export type ParsedDynamicUpdate = {
  chargePointId: string;
  statusRaw: string;
  statusCanonical: ChargePointStatus;
  tariffs: ParsedTariff[];
  lastUpdatedAt: string | null;
};

export type ParsedDynamicFeed = {
  updates: ParsedDynamicUpdate[];
};
