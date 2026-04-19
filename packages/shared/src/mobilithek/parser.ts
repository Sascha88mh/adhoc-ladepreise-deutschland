import type {
  AvailabilitySummary,
  ChargePointStatus,
  CurrentType,
  StationRecord,
  TariffSummary,
} from "../domain/types";
import type {
  ParsedChargePoint,
  ParsedConnector,
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

  const entry = (value as { values?: Array<{ value?: string }> }).values?.[0];
  return entry?.value ?? null;
}

function readAddressLine(address: {
  addressLine?: Array<{
    type?: { value?: string };
    text?: { values?: Array<{ value?: string }> };
  }>;
}) {
  const lines = address.addressLine ?? [];
  const street = lines.find((line) => line.type?.value === "street")?.text?.values?.[0]?.value;
  const houseNumber = lines.find((line) => line.type?.value === "houseNumber")?.text?.values?.[0]?.value;
  return [street, houseNumber].filter(Boolean).join(" ").trim();
}

function normalizeCurrentType(value: string | undefined): CurrentType {
  return value?.toUpperCase() === "AC" ? "AC" : "DC";
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

function parseMobilithekJson(payload: string): Record<string, unknown> {
  try {
    return JSON.parse(payload) as Record<string, unknown>;
  } catch (error) {
    const sanitized = sanitizeMobilithekJsonPayload(payload);

    if (sanitized !== payload) {
      return JSON.parse(sanitized) as Record<string, unknown>;
    }

    throw error;
  }
}

function normalizeStatus(value: string | undefined): ChargePointStatus {
  const normalized = value?.trim().toLowerCase();

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

  if (["outofservice", "out_of_service", "faulted", "offline"].includes(normalized)) {
    return "OUT_OF_SERVICE";
  }

  if (["maintenance", "plannedmaintenance"].includes(normalized)) {
    return "MAINTENANCE";
  }

  return "UNKNOWN";
}

function parseTariff(rate: {
  idG?: string;
  rateName?: unknown;
  applicableCurrency?: string[];
  payment?: {
    paymentMeans?: Array<{ value?: string }>;
    brandsAccepted?: Array<{ value?: string }>;
  };
  energyPrice?: Array<{
    priceType?: { value?: string };
    value?: number;
    priceCap?: number;
    timeBasedApplicability?: { fromMinute?: number };
  }>;
}): ParsedTariff {
  const summary: ParsedTariff = {
    id:
      rate.idG ??
      stableId([
        readMultilingual(rate.rateName),
        rate.applicableCurrency?.[0],
        JSON.stringify(rate.energyPrice ?? []),
      ]),
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
      .map((payment) => payment.value)
      .filter((value): value is string => Boolean(value)),
    brandsAccepted: (rate.payment?.brandsAccepted ?? [])
      .map((brand) => brand.value)
      .filter((value): value is string => Boolean(value)),
    isComplete: true,
  };

  for (const price of rate.energyPrice ?? []) {
    const priceType = price.priceType?.value?.toLowerCase();

    if (priceType === "priceperkwh") {
      summary.pricePerKwh = price.value ?? null;
    } else if (priceType === "priceperminute") {
      if (price.timeBasedApplicability?.fromMinute != null) {
        summary.blockingFeePerMinute = price.value ?? null;
        summary.blockingFeeStartsAfterMinutes = price.timeBasedApplicability.fromMinute;
      } else {
        summary.pricePerMinute = price.value ?? null;
      }
    } else if (priceType === "pricepersession" || priceType === "flatfee") {
      summary.sessionFee = price.value ?? null;
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
    currentType?: { value?: string };
    connector?: Array<{ connectorType?: { value?: string } }>;
    availableChargingPower?: number[];
    electricEnergy?: Array<{
      energyRate?: Array<{
        idG?: string;
        rateName?: unknown;
        applicableCurrency?: string[];
        payment?: {
          paymentMeans?: Array<{ value?: string }>;
          brandsAccepted?: Array<{ value?: string }>;
        };
        energyPrice?: Array<{
          priceType?: { value?: string };
          value?: number;
          priceCap?: number;
          timeBasedApplicability?: { fromMinute?: number };
        }>;
      }>;
    }>;
  },
  stationCode: string,
): ParsedChargePoint {
  const chargePointCode =
    point.idG ??
    stableId([
      stationCode,
      point.currentType?.value,
      JSON.stringify(point.availableChargingPower ?? []),
    ]);

  const connectors: ParsedConnector[] = (point.connector ?? []).map((connector, index) => ({
    connectorType: connector.connectorType?.value ?? `UNKNOWN_${index + 1}`,
    maxPowerKw: point.availableChargingPower?.[index]
      ? point.availableChargingPower[index]! / 1000
      : null,
  }));

  const tariffs = (point.electricEnergy ?? []).flatMap((energy) =>
    (energy.energyRate ?? []).map((rate) => parseTariff(rate)),
  );

  return {
    chargePointCode,
    currentType: normalizeCurrentType(point.currentType?.value),
    connectors,
    maxPowerKw: Math.max(
      ...((point.availableChargingPower ?? []).map((value) => value / 1000)),
      0,
    ),
    tariffs,
  };
}

type FacilityAddress = {
  postcode?: string;
  city?: unknown;
  countryCode?: string;
  addressLine?: Array<{
    type?: { value?: string };
    text?: { values?: Array<{ value?: string }> };
  }>;
};

type LocationBlock = {
  coordinatesForDisplay?: { latitude?: number; longitude?: number };
  locLocationExtensionG?: {
    FacilityLocation?: { address?: FacilityAddress };
    facilityLocation?: { address?: FacilityAddress };
  };
};

function resolveLocationRef(ref?: {
  locAreaLocation?: LocationBlock;
  locPointLocation?: LocationBlock;
  name?: unknown;
}) {
  const area = ref?.locAreaLocation;
  const point = ref?.locPointLocation;
  const coords =
    area?.coordinatesForDisplay ??
    point?.coordinatesForDisplay;
  const ext =
    area?.locLocationExtensionG ??
    point?.locLocationExtensionG;
  const address =
    ext?.FacilityLocation?.address ??
    ext?.facilityLocation?.address;
  return { coords, address };
}

function parseStationCatalog(
  site: {
    operator?: { afacAnOrganisation?: { name?: unknown; externalIdentifier?: Array<{ identifier?: string }> } };
    locationReference?: {
      locAreaLocation?: LocationBlock;
      locPointLocation?: LocationBlock;
    };
    energyInfrastructureStation?: Array<{
      idG?: string;
      description?: unknown;
      externalIdentifier?: Array<{ identifier?: string }>;
      authenticationAndIdentificationMethods?: Array<{ value?: string }>;
      numberOfRefillPoints?: number;
      totalMaximumPower?: number;
      // Vaylens puts locationReference here instead of at the site level
      locationReference?: {
        locAreaLocation?: LocationBlock;
        locPointLocation?: LocationBlock;
      };
      refillPoint?: Array<{
        aegiElectricChargingPoint?: {
          idG?: string;
          currentType?: { value?: string };
          connector?: Array<{ connectorType?: { value?: string } }>;
          availableChargingPower?: number[];
          electricEnergy?: Array<{
            energyRate?: Array<{
              idG?: string;
              rateName?: unknown;
              applicableCurrency?: string[];
              payment?: {
                paymentMeans?: Array<{ value?: string }>;
                brandsAccepted?: Array<{ value?: string }>;
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
      }>;
    }>;
  }): ParsedStationCatalog[] {
  // Tesla-style: locationReference on the site itself.
  // Vaylens-style: locationReference on each energyInfrastructureStation instead.
  const siteLocation = resolveLocationRef(site.locationReference);
  const firstStation = site.energyInfrastructureStation?.[0];
  const { coords: coordinates, address } =
    siteLocation.coords != null && siteLocation.address != null
      ? siteLocation
      : resolveLocationRef(firstStation?.locationReference);

  const latitude = coordinates?.latitude;
  const longitude = coordinates?.longitude;

  if (latitude == null || longitude == null || !address) {
    return [];
  }

  const cpoId =
    site.operator?.afacAnOrganisation?.externalIdentifier?.[0]?.identifier ??
    readMultilingual(site.operator?.afacAnOrganisation?.name) ??
    "unknown";
  const cpoName = readMultilingual(site.operator?.afacAnOrganisation?.name) ?? "Unknown CPO";

  return (site.energyInfrastructureStation ?? []).map((station, stationIndex) => {
    const stationCode =
      station.idG ??
      station.externalIdentifier?.[0]?.identifier ??
      stableId([cpoId, readMultilingual(station.description), stationIndex]);

    const chargePoints = (station.refillPoint ?? [])
      .map((item) => item.aegiElectricChargingPoint)
      .filter((point): point is NonNullable<typeof point> => Boolean(point))
      .map((point) => parseChargePoint(point, stationCode));

    const tariffs = chargePoints.flatMap((point) => point.tariffs);
    const paymentMethods = Array.from(
      new Set([
        ...(station.authenticationAndIdentificationMethods ?? []).map((method) => method.value),
        ...tariffs.flatMap((tariff) => tariff.paymentMethods),
      ].filter((value): value is string => Boolean(value))),
    );

    const connectorTypes = Array.from(
      new Set(chargePoints.flatMap((point) => point.connectors.map((connector) => connector.connectorType))),
    );

    const currentTypes = Array.from(
      new Set(chargePoints.map((point) => point.currentType)),
    );

    const maxPowerKw = Math.max(
      station.totalMaximumPower ? station.totalMaximumPower / 1000 : 0,
      ...chargePoints.map((point) => point.maxPowerKw),
      0,
    );

    const chargePointCount = Math.max(1, station.numberOfRefillPoints ?? chargePoints.length);

    return {
      stationCode,
      cpoId,
      cpoName,
      name: readMultilingual(station.description) ?? "Ladestation",
      addressLine: readAddressLine(address),
      city: readMultilingual(address.city) ?? "Unbekannt",
      postalCode: address.postcode ?? "",
      countryCode: address.countryCode ?? "DE",
      coordinates: {
        lat: latitude,
        lng: longitude,
      },
      chargePointCount,
      currentTypes,
      connectorTypes,
      paymentMethods,
      maxPowerKw,
      chargePoints,
      notes: [],
    } satisfies ParsedStationCatalog;
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
  const parsed = typeof payload === "string" ? parseMobilithekJson(payload) : payload;
  const publication = (parsed.payload as {
    aegiEnergyInfrastructureTablePublication?: {
      energyInfrastructureTable?: Array<{
        energyInfrastructureSite?: Array<Parameters<typeof parseStationCatalog>[0]>;
      }>;
    };
  })?.aegiEnergyInfrastructureTablePublication;

  const catalog =
    publication?.energyInfrastructureTable?.flatMap((table) =>
      (table.energyInfrastructureSite ?? []).flatMap((site) => parseStationCatalog(site)),
    ) ?? [];

  return {
    catalog,
    stations: catalog.map((station) => toStationRecord(station)),
  };
}

export function parseDynamicMobilithekPayload(payload: string | Record<string, unknown>): ParsedDynamicFeed {
  const parsed = typeof payload === "string" ? parseMobilithekJson(payload) : payload;
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
                        timeBasedApplicability?: { fromMinute?: number };
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

  const updates =
    messageContainer?.payload?.flatMap((item) =>
      (item.aegiEnergyInfrastructureStatusPublication?.energyInfrastructureSiteStatus ?? []).flatMap((site) =>
        (site.energyInfrastructureStationStatus ?? []).flatMap((station) =>
          (station.refillPointStatus ?? []).flatMap((pointStatus) => {
            const point = pointStatus.aegiElectricChargingPointStatus;
            if (!point?.reference?.idG) {
              return [];
            }

            const tariffs = (point.energyRateUpdate ?? []).map((rate) =>
              parseTariff({
                idG: rate.energyRateReference?.idG,
                energyPrice: rate.energyPrice,
              }),
            );

            return [
              {
                chargePointId: point.reference.idG,
                statusRaw: point.status?.value?.toUpperCase() ?? "UNKNOWN",
                statusCanonical: normalizeStatus(point.status?.value),
                tariffs,
                lastUpdatedAt: point.lastUpdated ?? null,
              } satisfies ParsedDynamicUpdate,
            ];
          }),
        ),
      ),
    ) ?? [];

  return { updates };
}
