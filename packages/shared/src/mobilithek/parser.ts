import type {
  AvailabilitySummary,
  ChargePointStatus,
  CurrentType,
  StationRecord,
  TariffSummary,
} from "../domain/types";
import { XMLParser } from "fast-xml-parser";
import type {
  ParsedChargePoint,
  ParsedConnector,
  ParsedTariffComponent,
  ParsedDynamicFeed,
  ParsedDynamicUpdate,
  ParsedStaticFeed,
  ParsedStationCatalog,
  ParsedTariff,
} from "./types";

function stableId(parts: Array<string | number | null | undefined>) {
  const input = parts
    .map((part) => (part == null ? "" : String(part).trim()))
    .filter(Boolean)
    .join("|");

  let hash = 0;
  for (let index = 0; index < input.length; index += 1) {
    hash = (hash << 5) - hash + input.charCodeAt(index);
    hash |= 0;
  }

  return `mobi-${Math.abs(hash).toString(36)}`;
}

function readMultilingual(value: unknown) {
  if (!value || typeof value !== "object") {
    return null;
  }

  const entry = (value as { values?: Array<{ value?: unknown }> }).values?.[0];
  const text = entry?.value;
  if (text == null) return null;
  if (typeof text === "object" && "#text" in text) {
    const rawText = (text as { "#text"?: unknown })["#text"];
    return rawText == null ? null : String(rawText);
  }
  return String(text);
}

function readAddressLine(address: {
  addressLine?: Array<{
    type?: { value?: string } | string;
    text?: { values?: Array<{ value?: unknown }> };
  }>;
}) {
  const lines = address.addressLine ?? [];
  const readType = (line: (typeof lines)[number]) =>
    typeof line.type === "string" ? line.type : line.type?.value;
  const street = readMultilingual(lines.find((line) => readType(line) === "street")?.text);
  const houseNumber = readMultilingual(lines.find((line) => readType(line) === "houseNumber")?.text);
  return [street, houseNumber].filter(Boolean).join(" ").trim();
}

function readValue(value: unknown): string | undefined {
  if (value == null) return undefined;
  if (typeof value === "string" || typeof value === "number" || typeof value === "boolean") {
    return String(value);
  }
  if (typeof value === "object") {
    const raw = (value as { value?: unknown; "#text"?: unknown }).value ?? (value as { "#text"?: unknown })["#text"];
    return readValue(raw);
  }
  return undefined;
}

function readExternalIdentifier(values: unknown): string | undefined {
  if (!Array.isArray(values)) {
    return readValue(values);
  }

  return values
    .map((value) =>
      typeof value === "object" && value != null && "identifier" in value
        ? readValue((value as { identifier?: unknown }).identifier)
        : readValue(value),
    )
    .find((value): value is string => Boolean(value));
}

function looksLikeOperatorCode(value: string) {
  return /^[A-Z]{2}\*[A-Z0-9*]+$/.test(value.trim().toUpperCase());
}

function readOrganisationName(operator?: { name?: unknown; legalName?: unknown }) {
  const name = operator ? readMultilingual(operator.name) : null;
  const legalName = operator ? readMultilingual(operator.legalName) : null;

  if (name && !looksLikeOperatorCode(name)) {
    return name;
  }

  return legalName ?? name ?? null;
}

function normalizeCpoIdentity(rawId: string, rawName: string) {
  if (rawId.trim().toUpperCase() === "DE*ISE" && rawName.trim() && rawName !== rawId) {
    return {
      cpoId: `${rawId}:${stableId([rawName])}`,
      cpoName: rawName,
    };
  }

  return {
    cpoId: rawId,
    cpoName: rawName,
  };
}

function normalizeCurrentType(value: unknown): CurrentType {
  return readValue(value)?.toUpperCase() === "AC" ? "AC" : "DC";
}

function isType2AcConnector(connectorType: string | undefined) {
  const normalized = connectorType?.toLowerCase() ?? "";
  return (
    normalized.includes("iec62196t2") &&
    !normalized.includes("combo") &&
    !normalized.includes("ccs")
  );
}

function normalizeAvailablePowerKw(
  powerKw: number,
  currentType: CurrentType,
  connectorType: string | undefined,
) {
  if (currentType === "AC" && isType2AcConnector(connectorType) && powerKw >= 7 && powerKw <= 7.5) {
    return 22;
  }

  return powerKw;
}

export function sanitizeMobilithekJsonPayload(payload: string) {
  return payload
    .replace(/\u0000/g, "")
    .replace(/\\u0000/gi, "")
    // ES6 braced escapes (\u{XXXX}) are valid JS but invalid JSON — expand them
    .replace(/\\u\{([0-9a-fA-F]+)\}/g, (_, hex) => {
      const codePoint = Number.parseInt(hex, 16);
      if (Number.isNaN(codePoint) || codePoint > 0x10ffff) return "";
      return String.fromCodePoint(codePoint);
    })
    // \u not followed by exactly 4 hex digits is a JSON syntax error
    .replace(/\\u(?![0-9a-fA-F]{4})/gi, "\\uFFFD")
    // Lone high surrogates (\uD800–\uDBFF not followed by a low surrogate)
    .replace(/\\uD[89AB][0-9A-F]{2}(?!\\uD[CDEF][0-9A-F]{2})/gi, "\\uFFFD")
    // Lone low surrogates (\uDC00–\uDFFF not preceded by a high surrogate)
    .replace(/(^|[^\\])(\\uD[CDEF][0-9A-F]{2})/gi, (_, prefix) => `${prefix}\\uFFFD`);
}

const xmlArrayTags = new Set([
  "addressLine",
  "authenticationAndIdentificationMethods",
  "availableChargingPower",
  "brandsAccepted",
  "connector",
  "electricEnergy",
  "energyInfrastructureSite",
  "energyInfrastructureSiteStatus",
  "energyInfrastructureStation",
  "energyInfrastructureStationStatus",
  "energyInfrastructureTable",
  "energyPrice",
  "energyRate",
  "energyRateUpdate",
  "externalIdentifier",
  "paymentMeans",
  "payload",
  "refillPoint",
  "refillPointStatus",
  "values",
]);

function parseMobilithekXml(payload: string): Record<string, unknown> {
  const parser = new XMLParser({
    attributeNamePrefix: "",
    ignoreAttributes: false,
    parseAttributeValue: true,
    parseTagValue: true,
    removeNSPrefix: true,
    trimValues: true,
    isArray: (tagName) => xmlArrayTags.has(tagName),
  });

  return parser.parse(payload) as Record<string, unknown>;
}

function parseMobilithekPayload(payload: string): Record<string, unknown> {
  const trimmed = payload.trimStart();
  if (trimmed.startsWith("<")) {
    return parseMobilithekXml(payload);
  }

  return JSON.parse(sanitizeMobilithekJsonPayload(payload)) as Record<string, unknown>;
}

function normalizeStatus(value: unknown): ChargePointStatus {
  const normalized = readValue(value)?.trim().toLowerCase();

  if (!normalized) {
    return "UNKNOWN";
  }

  if (["available", "free", "vacant", "idle"].includes(normalized)) {
    return "AVAILABLE";
  }

  if (["charging", "inuse", "occupied", "busy"].includes(normalized)) {
    return "CHARGING";
  }

  if (["reserved", "booking"].includes(normalized)) {
    return "RESERVED";
  }

  if (["blocked", "unavailable"].includes(normalized)) {
    return "BLOCKED";
  }

  if (["outofservice", "out_of_service", "outoforder", "faulted", "inoperative", "offline"].includes(normalized)) {
    return "OUT_OF_SERVICE";
  }

  if (["maintenance", "plannedmaintenance"].includes(normalized)) {
    return "MAINTENANCE";
  }

  return "UNKNOWN";
}

function buildTariffId(
  scope: ParsedTariff["scope"],
  scopeCode: string,
  externalCode: string,
) {
  return `${scope}|${scopeCode}|${externalCode}`;
}

function parseTariff(rate: {
  idG?: string;
  id?: string;
  rateName?: unknown;
  applicableCurrency?: string[];
  payment?: {
    paymentMeans?: Array<{ value?: string } | string>;
    brandsAccepted?: Array<{ value?: string } | string>;
  };
  energyPrice?: Array<{
    priceType?: { value?: string } | string;
    value?: number;
    priceCap?: number;
    taxIncluded?: boolean;
    taxRate?: number;
    overallPeriod?: Record<string, unknown>;
    timeBasedApplicability?: { fromMinute?: number };
    energyBasedApplicability?: Record<string, unknown>;
  }>;
},
identity: {
  scope: ParsedTariff["scope"];
  scopeCode: string;
}): ParsedTariff {
  const externalCode =
    rate.idG ??
    rate.id ??
    stableId([
      readMultilingual(rate.rateName),
      rate.applicableCurrency?.[0],
      JSON.stringify(rate.energyPrice ?? []),
    ]);
  const summary: ParsedTariff = {
    id: buildTariffId(identity.scope, identity.scopeCode, externalCode),
    externalCode,
    scope: identity.scope,
    scopeCode: identity.scopeCode,
    label: readMultilingual(rate.rateName) ?? "Ad-hoc",
    currency: rate.applicableCurrency?.[0] ?? "EUR",
    pricePerKwh: null,
    pricePerMinute: null,
    sessionFee: null,
    preauthAmount: null,
    blockingFeePerMinute: null,
    blockingFeeStartsAfterMinutes: null,
    caps: [],
    paymentMethods: (rate.payment?.paymentMeans ?? [])
      .map((payment) => readValue(payment))
      .filter((value): value is string => Boolean(value)),
    brandsAccepted: (rate.payment?.brandsAccepted ?? [])
      .map((brand) => readValue(brand))
      .filter((value): value is string => Boolean(value)),
    isComplete: true,
    components: [],
  };

  for (const price of rate.energyPrice ?? []) {
    const priceType = readValue(price.priceType)?.toLowerCase();
    const component: ParsedTariffComponent = {
      componentType: "pricePerKWh",
      amount: price.value ?? 0,
      startsAfterMinutes: price.timeBasedApplicability?.fromMinute ?? null,
      priceCap: price.priceCap ?? null,
      timeBasedApplicability:
        price.timeBasedApplicability != null
          ? (price.timeBasedApplicability as Record<string, unknown>)
          : null,
      overallPeriod: price.overallPeriod ?? null,
      energyBasedApplicability: price.energyBasedApplicability ?? null,
      taxIncluded: price.taxIncluded ?? null,
      taxRate: price.taxRate ?? null,
    };

    if (priceType === "priceperkwh") {
      summary.pricePerKwh = price.value ?? null;
      summary.components.push(component);
    } else if (priceType === "priceperminute") {
      if (price.timeBasedApplicability?.fromMinute != null) {
        summary.blockingFeePerMinute = price.value ?? null;
        summary.blockingFeeStartsAfterMinutes = price.timeBasedApplicability.fromMinute;
        summary.components.push({
          ...component,
          componentType: "blockingFee",
        });
      } else {
        summary.pricePerMinute = price.value ?? null;
        summary.components.push({
          ...component,
          componentType: "pricePerMinute",
        });
      }
    } else if (priceType === "pricepersession" || priceType === "flatfee") {
      summary.sessionFee = price.value ?? null;
      summary.components.push({
        ...component,
        componentType: "sessionFee",
      });
    }

    if (price.priceCap != null) {
      summary.caps.push({
        label: "priceCap",
        amount: price.priceCap,
        currency: summary.currency,
      });
    }
  }

  const requiredKeys = [summary.pricePerKwh, summary.sessionFee, summary.blockingFeePerMinute];
  summary.isComplete = requiredKeys.some((value) => value != null);
  return summary;
}

function emptyAvailability(chargePointCount: number): AvailabilitySummary {
  return {
    available: 0,
    occupied: 0,
    outOfService: 0,
    unknown: chargePointCount,
  };
}

function parseChargePoint(
  point: {
    idG?: string;
    id?: string;
    externalIdentifier?: Array<{ identifier?: string } | string>;
    currentType?: { value?: string } | string;
    connector?: Array<{ connectorType?: { value?: string } | string; maxPowerAtSocket?: number }>;
    availableChargingPower?: number[];
    electricEnergy?: Array<{
      energyRate?: Array<{
        idG?: string;
        rateName?: unknown;
        applicableCurrency?: string[];
        payment?: {
          paymentMeans?: Array<{ value?: string } | string>;
          brandsAccepted?: Array<{ value?: string } | string>;
        };
        energyPrice?: Array<{
          priceType?: { value?: string } | string;
          value?: number;
          priceCap?: number;
          timeBasedApplicability?: { fromMinute?: number };
        }>;
      }>;
    }>;
  },
  stationCode: string,
  fallbackDiscriminator: string | number,
): ParsedChargePoint {
  const chargePointCode =
    point.idG ??
    point.id ??
    readExternalIdentifier(point.externalIdentifier) ??
    stableId([
      stationCode,
      fallbackDiscriminator,
      readValue(point.currentType),
      JSON.stringify(point.availableChargingPower ?? []),
    ]);

  const connectorPowersKw = (point.connector ?? [])
    .map((connector, index) => {
      const connectorType = readValue(connector.connectorType);
      if (connector.maxPowerAtSocket != null) {
        return connector.maxPowerAtSocket / 1000;
      }
      if (point.availableChargingPower?.[index] != null) {
        return normalizeAvailablePowerKw(
          point.availableChargingPower[index]! / 1000,
          normalizeCurrentType(point.currentType),
          connectorType,
        );
      }
      return null;
    })
    .filter((value): value is number => value != null && value > 0);
  const availablePowersKw = (point.availableChargingPower ?? [])
    .map((value) => value / 1000)
    .filter((value) => value > 0);

  const connectors: ParsedConnector[] = (point.connector ?? []).map((connector, index) => ({
    connectorType: readValue(connector.connectorType) ?? `UNKNOWN_${index + 1}`,
    maxPowerKw:
      connector.maxPowerAtSocket != null
        ? connector.maxPowerAtSocket / 1000
        : point.availableChargingPower?.[index] != null
          ? normalizeAvailablePowerKw(
              point.availableChargingPower[index]! / 1000,
              normalizeCurrentType(point.currentType),
              readValue(connector.connectorType),
            )
          : null,
  }));

  const tariffs = (point.electricEnergy ?? []).flatMap((energy) =>
    (energy.energyRate ?? []).map((rate) =>
      parseTariff(rate, {
        scope: "charge_point",
        scopeCode: chargePointCode,
      }),
    ),
  );

  return {
    chargePointCode,
    currentType: normalizeCurrentType(point.currentType),
    connectors,
    maxPowerKw: Math.max(...(connectorPowersKw.length ? connectorPowersKw : availablePowersKw), 0),
    tariffs,
  };
}

type FacilityAddress = {
  postcode?: string | number;
  city?: unknown;
  countryCode?: string;
  addressLine?: Array<{
    type?: { value?: string } | string;
    text?: { values?: Array<{ value?: unknown }> };
  }>;
};

type LocationBlock = {
  coordinatesForDisplay?: { latitude?: number; longitude?: number };
  pointByCoordinates?: { pointCoordinates?: { latitude?: number; longitude?: number } };
  locLocationExtensionG?: {
    FacilityLocation?: { address?: FacilityAddress };
    facilityLocation?: { address?: FacilityAddress };
  };
  _locationReferenceExtension?: {
    FacilityLocation?: { address?: FacilityAddress };
    facilityLocation?: { address?: FacilityAddress };
  };
};

function resolveLocationRef(ref?: {
  locAreaLocation?: LocationBlock;
  locPointLocation?: LocationBlock;
  name?: unknown;
} & LocationBlock) {
  const area = ref?.locAreaLocation;
  const point = ref?.locPointLocation;
  const direct = ref;
  const coords =
    area?.coordinatesForDisplay ??
    area?.pointByCoordinates?.pointCoordinates ??
    point?.coordinatesForDisplay ??
    point?.pointByCoordinates?.pointCoordinates ??
    direct?.coordinatesForDisplay ??
    direct?.pointByCoordinates?.pointCoordinates;
  const ext =
    area?.locLocationExtensionG ??
    area?._locationReferenceExtension ??
    point?.locLocationExtensionG ??
    point?._locationReferenceExtension ??
    direct?.locLocationExtensionG ??
    direct?._locationReferenceExtension;
  const address =
    ext?.FacilityLocation?.address ??
    ext?.facilityLocation?.address;
  return { coords, address };
}

type StationEntry = {
  idG?: string;
  id?: string;
  name?: unknown;
  description?: unknown;
  externalIdentifier?: Array<{ identifier?: string } | string>;
  authenticationAndIdentificationMethods?: Array<{ value?: string } | string>;
  numberOfRefillPoints?: number;
  totalMaximumPower?: number;
  // Vaylens puts locationReference here instead of at the site level
  locationReference?: {
    locAreaLocation?: LocationBlock;
    locPointLocation?: LocationBlock;
  };
  operator?: {
    afacAnOrganisation?: { name?: unknown; legalName?: unknown; externalIdentifier?: Array<{ identifier?: string } | string> };
    name?: unknown;
    legalName?: unknown;
    externalIdentifier?: Array<{ identifier?: string } | string>;
    id?: string;
  };
  refillPoint?: Array<{
    aegiElectricChargingPoint?: {
      idG?: string;
      id?: string;
      externalIdentifier?: Array<{ identifier?: string } | string>;
      currentType?: { value?: string } | string;
      connector?: Array<{ connectorType?: { value?: string } | string; maxPowerAtSocket?: number }>;
      availableChargingPower?: number[];
      electricEnergy?: Array<{
        energyRate?: Array<{
          idG?: string;
          rateName?: unknown;
          applicableCurrency?: string[];
          payment?: {
            paymentMeans?: Array<{ value?: string } | string>;
            brandsAccepted?: Array<{ value?: string } | string>;
          };
          energyPrice?: Array<{
            priceType?: { value?: string };
            value?: number;
            priceCap?: number;
            timeBasedApplicability?: { fromMinute?: number };
          }>;
        }>;
      }>;
    };
    idG?: string;
    id?: string;
    externalIdentifier?: Array<{ identifier?: string } | string>;
    currentType?: { value?: string } | string;
    connector?: Array<{ connectorType?: { value?: string } | string; maxPowerAtSocket?: number }>;
    availableChargingPower?: number[];
    electricEnergy?: Array<{
      energyRate?: Array<{
        idG?: string;
        id?: string;
        rateName?: unknown;
        applicableCurrency?: string[];
        payment?: {
          paymentMeans?: Array<{ value?: string } | string>;
          brandsAccepted?: Array<{ value?: string } | string>;
        };
        energyPrice?: Array<{
          priceType?: { value?: string } | string;
          value?: number;
          priceCap?: number;
          timeBasedApplicability?: { fromMinute?: number };
        }>;
      }>;
    }>;
  }>;
};

function buildCatalogEntry(
  stationCode: string,
  cpoId: string,
  cpoName: string,
  address: FacilityAddress,
  latitude: number,
  longitude: number,
  stations: StationEntry[],
): ParsedStationCatalog {
  const allChargePoints = stations.flatMap((station, stationIndex) =>
    (station.refillPoint ?? [])
      .map((item, refillPointIndex) => ({
        point: item.aegiElectricChargingPoint ?? item,
        fallbackDiscriminator: `${station.idG ?? station.id ?? stationIndex}:${refillPointIndex}`,
      }))
      .filter((entry): entry is { point: NonNullable<typeof entry.point>; fallbackDiscriminator: string } =>
        Boolean(entry.point),
      )
      .map(({ point, fallbackDiscriminator }) => parseChargePoint(point, stationCode, fallbackDiscriminator)),
  );

  const deduplicatedChargePoints = Array.from(
    allChargePoints
      .reduce<Map<string, ParsedChargePoint>>((acc, point) => {
        const current = acc.get(point.chargePointCode);
        acc.set(
          point.chargePointCode,
          current
            ? {
                ...current,
                maxPowerKw: Math.max(current.maxPowerKw, point.maxPowerKw),
                connectors: Array.from(
                  new Map(
                    [...current.connectors, ...point.connectors].map((connector) => [
                      `${connector.connectorType}|${connector.maxPowerKw ?? ""}`,
                      connector,
                    ]),
                  ).values(),
                ),
                tariffs: Array.from(
                  new Map([...current.tariffs, ...point.tariffs].map((tariff) => [tariff.id, tariff])).values(),
                ),
              }
            : point,
        );
        return acc;
      }, new Map())
      .values(),
  );

  const paymentMethods = Array.from(
    new Set(
      [
        ...stations.flatMap((station) =>
          (station.authenticationAndIdentificationMethods ?? []).map((method) => readValue(method)),
        ),
        ...deduplicatedChargePoints.flatMap((point) => point.tariffs.flatMap((tariff) => tariff.paymentMethods)),
      ].filter((value): value is string => Boolean(value)),
    ),
  );

  const connectorTypes = Array.from(
    new Set(deduplicatedChargePoints.flatMap((point) => point.connectors.map((connector) => connector.connectorType))),
  );

  const currentTypes = Array.from(new Set(deduplicatedChargePoints.map((point) => point.currentType)));

  const chargePointMaxPowerKw = Math.max(...deduplicatedChargePoints.map((point) => point.maxPowerKw), 0);
  const stationTotalPowerKw = Math.max(
    ...stations.map((station) => (station.totalMaximumPower != null ? station.totalMaximumPower / 1000 : 0)),
    0,
  );
  const maxPowerKw = chargePointMaxPowerKw > 0 ? chargePointMaxPowerKw : stationTotalPowerKw;

  const chargePointCount = Math.max(
    1,
    stations.reduce((sum, station) => sum + (station.numberOfRefillPoints ?? 0), 0) ||
      deduplicatedChargePoints.length,
  );

  const name =
    stations
      .map((station) => readMultilingual(station.description) ?? readMultilingual(station.name))
      .find(Boolean) ?? "Ladestation";

  return {
    stationCode,
    cpoId,
    cpoName,
    name,
    addressLine: readAddressLine(address),
    city: readMultilingual(address.city) ?? "Unbekannt",
    postalCode: address.postcode == null ? "" : String(address.postcode),
    countryCode: address.countryCode ?? "DE",
    coordinates: { lat: latitude, lng: longitude },
    chargePointCount,
    currentTypes,
    connectorTypes,
    paymentMethods,
    maxPowerKw,
    chargePoints: deduplicatedChargePoints,
    notes: [],
  };
}

function stationLocationGroupKey(address: FacilityAddress, latitude: number, longitude: number) {
  return [
    address.countryCode ?? "DE",
    address.postcode == null ? "" : String(address.postcode),
    readMultilingual(address.city) ?? "",
    readAddressLine(address),
    latitude.toFixed(5),
    longitude.toFixed(5),
  ]
    .map((part) => part.trim().toLowerCase())
    .join("|");
}

function catalogLocationGroupKey(station: ParsedStationCatalog) {
  return [
    station.cpoId,
    station.countryCode,
    station.postalCode,
    station.city,
    station.addressLine,
  ]
    .map((part) => part.trim().toLowerCase())
    .join("|");
}

function mergeChargePoints(points: ParsedChargePoint[]) {
  return Array.from(
    points
      .reduce<Map<string, ParsedChargePoint>>((acc, point) => {
        const current = acc.get(point.chargePointCode);
        acc.set(
          point.chargePointCode,
          current
            ? {
                ...current,
                maxPowerKw: Math.max(current.maxPowerKw, point.maxPowerKw),
                connectors: Array.from(
                  new Map(
                    [...current.connectors, ...point.connectors].map((connector) => [
                      `${connector.connectorType}|${connector.maxPowerKw ?? ""}`,
                      connector,
                    ]),
                  ).values(),
                ),
                tariffs: Array.from(
                  new Map([...current.tariffs, ...point.tariffs].map((tariff) => [tariff.id, tariff])).values(),
                ),
              }
            : point,
        );
        return acc;
      }, new Map())
      .values(),
  );
}

function mergeCatalogEntries(catalog: ParsedStationCatalog[]) {
  const clustersByAddress = new Map<string, ParsedStationCatalog[]>();

  for (const station of catalog) {
    const key = catalogLocationGroupKey(station);
    const stations = clustersByAddress.get(key) ?? [];
    stations.push(station);
    clustersByAddress.set(key, stations);
  }

  return [...clustersByAddress.values()].map((stations) => {
    if (stations.length === 1) {
      return stations[0]!;
    }

    const first = stations[0]!;
    const chargePoints = mergeChargePoints(stations.flatMap((station) => station.chargePoints));
    const coordinates = {
      lat: stations.reduce((sum, station) => sum + station.coordinates.lat, 0) / stations.length,
      lng: stations.reduce((sum, station) => sum + station.coordinates.lng, 0) / stations.length,
    };
    const chargePointCount = Math.max(
      chargePoints.length,
      stations.reduce((sum, station) => sum + station.chargePointCount, 0),
      1,
    );

    return {
      ...first,
      stationCode: stableId([
        "location",
        catalogLocationGroupKey(first),
      ]),
      name: stations.map((station) => station.name).find((name) => name !== "Ladestation") ?? first.name,
      coordinates,
      chargePointCount,
      currentTypes: Array.from(new Set(stations.flatMap((station) => station.currentTypes))),
      connectorTypes: Array.from(new Set(stations.flatMap((station) => station.connectorTypes))),
      paymentMethods: Array.from(new Set(stations.flatMap((station) => station.paymentMethods))),
      maxPowerKw: Math.max(...stations.map((station) => station.maxPowerKw), 0),
      chargePoints,
      notes: Array.from(new Set(stations.flatMap((station) => station.notes))),
    };
  });
}

function parseStationCatalog(
  site: {
    idG?: string;
    id?: string;
    operator?: {
      afacAnOrganisation?: { name?: unknown; legalName?: unknown; externalIdentifier?: Array<{ identifier?: string } | string> };
      name?: unknown;
      legalName?: unknown;
      externalIdentifier?: Array<{ identifier?: string } | string>;
      id?: string;
    };
    locationReference?: {
      locAreaLocation?: LocationBlock;
      locPointLocation?: LocationBlock;
    } & LocationBlock;
    energyInfrastructureStation?: StationEntry[];
  }): ParsedStationCatalog[] {
  const operator = (site.operator?.afacAnOrganisation ?? site.operator) as
    | {
        name?: unknown;
        legalName?: unknown;
        externalIdentifier?: Array<{ identifier?: string } | string>;
        id?: string;
      }
    | undefined;
  const cpoId =
    readExternalIdentifier(operator?.externalIdentifier) ??
    readValue(operator?.id) ??
    readOrganisationName(operator) ??
    "unknown";
  const cpoName = readOrganisationName(operator) ?? cpoId;
  const cpo = normalizeCpoIdentity(cpoId, cpoName);

  const allStations = site.energyInfrastructureStation ?? [];
  const siteLocation = resolveLocationRef(site.locationReference);

  if (siteLocation.coords != null && siteLocation.address != null) {
    // EnBW/Tesla-style: site has its own location → aggregate all stations into one DB entry
    const { coords, address } = siteLocation;
    const latitude = coords!.latitude;
    const longitude = coords!.longitude;

    if (latitude == null || longitude == null) return [];

    const stationCode = site.idG ?? site.id ?? stableId([cpo.cpoId, String(latitude), String(longitude)]);

    return [buildCatalogEntry(stationCode, cpo.cpoId, cpo.cpoName, address!, latitude, longitude, allStations)];
  }

  // Vaylens-style: no site-level location → group stations by their own display location.
  const stationGroups = new Map<
    string,
    {
      address: FacilityAddress;
      latitude: number;
      longitude: number;
      stations: StationEntry[];
      fallbackParts: Array<string | number | null | undefined>;
    }
  >();

  for (const [stationIndex, station] of allStations.entries()) {
    const { coords, address } = resolveLocationRef(station.locationReference);
    const latitude = coords?.latitude;
    const longitude = coords?.longitude;

    if (latitude == null || longitude == null || !address) continue;

    const key = stationLocationGroupKey(address, latitude, longitude);
    const current = stationGroups.get(key);
    const stationIdentity =
      station.idG ??
      station.id ??
      readExternalIdentifier(station.externalIdentifier) ??
      `${readMultilingual(station.description) ?? readMultilingual(station.name) ?? "station"}:${stationIndex}`;

    if (current) {
      current.stations.push(station);
      current.fallbackParts.push(stationIdentity);
      continue;
    }

    stationGroups.set(key, {
      address,
      latitude,
      longitude,
      stations: [station],
      fallbackParts: [stationIdentity],
    });
  }

  return [...stationGroups.values()].map((group) => {
    const stationCode =
      group.stations.length === 1
        ? group.fallbackParts[0] ?? stableId([cpo.cpoId, group.latitude, group.longitude])
        : stableId([cpo.cpoId, stationLocationGroupKey(group.address, group.latitude, group.longitude)]);

    return buildCatalogEntry(
      String(stationCode),
      cpo.cpoId,
      cpo.cpoName,
      group.address,
      group.latitude,
      group.longitude,
      group.stations,
    );
  });
}

function toStationRecord(station: ParsedStationCatalog): StationRecord {
  const tariffs: TariffSummary[] = Array.from(
    new Map(
      station.chargePoints
        .flatMap((point) => point.tariffs)
        .map((tariff) => [tariff.id, tariff] as const),
    ).values(),
  );

  return {
    stationId: station.stationCode,
    cpoId: station.cpoId,
    cpoName: station.cpoName,
    name: station.name,
    addressLine: station.addressLine,
    city: station.city,
    postalCode: station.postalCode,
    countryCode: station.countryCode,
    coordinates: station.coordinates,
    chargePointCount: station.chargePointCount,
    currentTypes: station.currentTypes,
    connectorTypes: station.connectorTypes,
    paymentMethods: station.paymentMethods,
    maxPowerKw: station.maxPowerKw,
    availabilitySummary: emptyAvailability(station.chargePointCount),
    lastPriceUpdateAt: new Date().toISOString(),
    lastStatusUpdateAt: new Date().toISOString(),
    tariffs,
    notes: station.notes,
  };
}

export function parseStaticMobilithekPayload(payload: string | Record<string, unknown>): ParsedStaticFeed {
  const parsed = typeof payload === "string" ? parseMobilithekPayload(payload) : payload;
  const rootPayload = (parsed.payload ??
    (parsed.messageContainer as { payload?: unknown } | undefined)?.payload) as unknown;
  const payloadItems = Array.isArray(rootPayload) ? rootPayload : [rootPayload];
  const publications = payloadItems
    .map((item) =>
      (item as {
        aegiEnergyInfrastructureTablePublication?: unknown;
        energyInfrastructureTable?: unknown;
      } | null | undefined)?.aegiEnergyInfrastructureTablePublication ?? item,
    )
    .filter(Boolean) as Array<{
    aegiEnergyInfrastructureTablePublication?: {
      energyInfrastructureTable?: Array<{
        energyInfrastructureSite?: Array<Parameters<typeof parseStationCatalog>[0]>;
      }>;
    };
    energyInfrastructureTable?: Array<{
      energyInfrastructureSite?: Array<Parameters<typeof parseStationCatalog>[0]>;
    }>;
  }>;

  const catalog = mergeCatalogEntries(
    publications.flatMap((publication) =>
      (publication.aegiEnergyInfrastructureTablePublication?.energyInfrastructureTable ??
        publication.energyInfrastructureTable ??
        []).flatMap((table) =>
        (table.energyInfrastructureSite ?? []).flatMap((site) => parseStationCatalog(site)),
      ),
    ) ?? [],
  );

  return {
    catalog,
    stations: catalog.map((station) => toStationRecord(station)),
  };
}

export function parseDynamicMobilithekPayload(payload: string | Record<string, unknown>): ParsedDynamicFeed {
  const parsed = typeof payload === "string" ? parseMobilithekPayload(payload) : payload;
  const messageContainer = parsed.messageContainer as
    | {
        payload?: Array<{
          aegiEnergyInfrastructureStatusPublication?: {
            energyInfrastructureSiteStatus?: Array<{
              energyInfrastructureStationStatus?: Array<{
                refillPointStatus?: Array<{
                  aegiElectricChargingPointStatus?: {
                    reference?: { idG?: string };
                    status?: { value?: string };
                    lastUpdated?: string;
                    energyRateUpdate?: Array<{
                      energyPrice?: Array<{
                        priceType?: { value?: string };
                        value?: number;
                        priceCap?: number;
                        taxIncluded?: boolean;
                        taxRate?: number;
                        overallPeriod?: Record<string, unknown>;
                        timeBasedApplicability?: { fromMinute?: number };
                        energyBasedApplicability?: Record<string, unknown>;
                      }>;
                      energyRateReference?: { idG?: string };
                    }>;
                  };
                  aegiRefillPointStatus?: {
                    reference?: { idG?: string };
                    status?: { value?: string };
                    lastUpdated?: string;
                    energyRateUpdate?: Array<{
                      energyPrice?: Array<{
                        priceType?: { value?: string };
                        value?: number;
                        priceCap?: number;
                        taxIncluded?: boolean;
                        taxRate?: number;
                        overallPeriod?: Record<string, unknown>;
                        timeBasedApplicability?: { fromMinute?: number };
                        energyBasedApplicability?: Record<string, unknown>;
                      }>;
                      energyRateReference?: { idG?: string };
                    }>;
                  };
                }>;
              }>;
            }>;
          };
        }>;
      }
    | undefined;
  const topLevelPayload = Array.isArray(parsed.payload)
    ? (parsed.payload as Array<NonNullable<NonNullable<typeof messageContainer>["payload"]>[number]>)
    : undefined;
  const payloadItems = messageContainer?.payload ?? topLevelPayload ?? [];

  const updates =
    payloadItems.flatMap((item) =>
        (item.aegiEnergyInfrastructureStatusPublication?.energyInfrastructureSiteStatus ?? []).flatMap((site) =>
          (site.energyInfrastructureStationStatus ?? []).flatMap((station) =>
          (station.refillPointStatus ?? []).flatMap((pointStatus) => {
            const point =
              pointStatus.aegiElectricChargingPointStatus ??
              pointStatus.aegiRefillPointStatus;
            const scopeCode = point?.reference?.idG;
            if (!scopeCode) {
              return [];
            }

            const tariffs = (point.energyRateUpdate ?? []).map((rate) =>
              parseTariff({
                idG: rate.energyRateReference?.idG,
                energyPrice: rate.energyPrice,
              }, {
                scope: "charge_point",
                scopeCode,
              }),
            );

            return [
              {
                chargePointId: scopeCode,
                statusRaw: readValue(point.status)?.toUpperCase() ?? "UNKNOWN",
                statusCanonical: normalizeStatus(point.status),
                tariffs,
                lastUpdatedAt: point.lastUpdated ?? null,
              } satisfies ParsedDynamicUpdate,
            ];
          }),
        ),
      ),
    );

  return { updates };
}
