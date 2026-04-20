import type {
  ChargePointStatus,
  Coordinate,
  CurrentType,
  TariffCap,
  StationRecord,
  TariffSummary,
} from "../domain/types";

export type ParsedConnector = {
  connectorType: string;
  maxPowerKw: number | null;
};

export type ParsedTariffComponent = {
  componentType: "pricePerKWh" | "pricePerMinute" | "sessionFee" | "preauth" | "blockingFee";
  amount: number;
  startsAfterMinutes: number | null;
  priceCap: number | null;
  timeBasedApplicability: Record<string, unknown> | null;
  overallPeriod: Record<string, unknown> | null;
  energyBasedApplicability: Record<string, unknown> | null;
  taxIncluded: boolean | null;
  taxRate: number | null;
};

export type ParsedTariff = TariffSummary & {
  id: string;
  externalCode: string;
  scope: "charge_point" | "station";
  scopeCode: string;
  components: ParsedTariffComponent[];
  caps: TariffCap[];
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
