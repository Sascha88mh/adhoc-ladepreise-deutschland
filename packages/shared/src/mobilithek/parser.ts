import type { AvailabilitySummary, StationRecord, TariffSummary } from "../domain/types";
import type { ParsedDynamicFeed, ParsedStaticFeed } from "./types";

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
}): TariffSummary {
  const summary: TariffSummary = {
    id: rate.idG ?? crypto.randomUUID(),
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

function parseStation(
  site: {
    operator?: { afacAnOrganisation?: { name?: unknown; externalIdentifier?: Array<{ identifier?: string }> } };
    locationReference?: {
      locAreaLocation?: {
        coordinatesForDisplay?: { latitude?: number; longitude?: number };
        locLocationExtensionG?: {
          FacilityLocation?: {
            address?: {
              postcode?: string;
              city?: unknown;
              countryCode?: string;
              addressLine?: Array<{
                type?: { value?: string };
                text?: { values?: Array<{ value?: string }> };
              }>;
            };
          };
        };
      };
    };
    energyInfrastructureStation?: Array<{
      idG?: string;
      description?: unknown;
      externalIdentifier?: Array<{ identifier?: string }>;
      authenticationAndIdentificationMethods?: Array<{ value?: string }>;
      numberOfRefillPoints?: number;
      totalMaximumPower?: number;
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
  }): StationRecord[] {
  const coordinates = site.locationReference?.locAreaLocation?.coordinatesForDisplay;
  const address = site.locationReference?.locAreaLocation?.locLocationExtensionG?.FacilityLocation?.address;
  const latitude = coordinates?.latitude;
  const longitude = coordinates?.longitude;

  if (latitude == null || longitude == null || !address) {
    return [];
  }

  return (site.energyInfrastructureStation ?? []).map((station) => {
    const points = (station.refillPoint ?? [])
      .map((item) => item.aegiElectricChargingPoint)
      .filter((point): point is NonNullable<typeof point> => Boolean(point));

    const tariffs = points.flatMap((point) =>
      (point.electricEnergy ?? []).flatMap((energy) =>
        (energy.energyRate ?? []).map((rate) => parseTariff(rate)),
      ),
    );

    const paymentMethods = Array.from(
      new Set([
        ...(station.authenticationAndIdentificationMethods ?? []).map((method) => method.value),
        ...tariffs.flatMap((tariff) => tariff.paymentMethods),
      ].filter((value): value is string => Boolean(value))),
    );

    const connectorTypes = Array.from(
      new Set(
        points.flatMap((point) =>
          (point.connector ?? [])
            .map((connector) => connector.connectorType?.value)
            .filter((value): value is string => Boolean(value)),
        ),
      ),
    );

    const currentTypes = Array.from(
      new Set(
        points
          .map((point) => point.currentType?.value?.toUpperCase())
          .filter((value): value is "AC" | "DC" => value === "AC" || value === "DC"),
      ),
    );

    const maxPowerKw = Math.max(
      station.totalMaximumPower ? station.totalMaximumPower / 1000 : 0,
      ...points.flatMap((point) => (point.availableChargingPower ?? []).map((value) => value / 1000)),
      0,
    );

    const chargePointCount = Math.max(1, station.numberOfRefillPoints ?? points.length);

    return {
      stationId: station.idG ?? crypto.randomUUID(),
      cpoId:
        site.operator?.afacAnOrganisation?.externalIdentifier?.[0]?.identifier ??
        site.operator?.afacAnOrganisation?.name?.toString() ??
        "unknown",
      cpoName: readMultilingual(site.operator?.afacAnOrganisation?.name) ?? "Unknown CPO",
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
      availabilitySummary: emptyAvailability(chargePointCount),
      lastPriceUpdateAt: new Date().toISOString(),
      lastStatusUpdateAt: new Date().toISOString(),
      tariffs,
      notes: [],
    } satisfies StationRecord;
  });
}

export function parseStaticMobilithekPayload(payload: string | Record<string, unknown>): ParsedStaticFeed {
  const parsed = typeof payload === "string" ? (JSON.parse(payload) as Record<string, unknown>) : payload;
  const publication = (parsed.payload as {
    aegiEnergyInfrastructureTablePublication?: {
      energyInfrastructureTable?: Array<{
        energyInfrastructureSite?: Array<Parameters<typeof parseStation>[0]>;
      }>;
    };
  })?.aegiEnergyInfrastructureTablePublication;

  const stations =
    publication?.energyInfrastructureTable?.flatMap((table) =>
      (table.energyInfrastructureSite ?? []).flatMap((site) => parseStation(site)),
    ) ?? [];

  return { stations };
}

export function parseDynamicMobilithekPayload(payload: string | Record<string, unknown>): ParsedDynamicFeed {
  const parsed = typeof payload === "string" ? (JSON.parse(payload) as Record<string, unknown>) : payload;
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
                status: point.status?.value?.toUpperCase() ?? "UNKNOWN",
                tariffs,
                lastUpdatedAt: point.lastUpdated ?? null,
              },
            ];
          }),
        ),
      ),
    ) ?? [];

  return { updates };
}
