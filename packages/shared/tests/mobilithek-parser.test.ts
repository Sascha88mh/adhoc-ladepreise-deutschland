import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { describe, expect, it } from "vitest";
import { parseDynamicMobilithekPayload, parseStaticMobilithekPayload } from "../src/index";

const STATIC_FIXTURE = readFileSync(
  resolve(import.meta.dirname, "../../../db/fixtures/mobilithek-static.sample.json"),
  "utf8",
);
const DYNAMIC_FIXTURE = readFileSync(
  resolve(import.meta.dirname, "../../../db/fixtures/mobilithek-dynamic.sample.json"),
  "utf8",
);

const ENBW_STATIC_REUSED_TARIFF = JSON.stringify({
  payload: {
    aegiEnergyInfrastructureTablePublication: {
      energyInfrastructureTable: [
        {
          energyInfrastructureSite: [
            {
              idG: "site-1",
              operator: {
                afacAnOrganisation: {
                  name: { values: [{ value: "EnBW" }] },
                  externalIdentifier: [{ identifier: "enbw" }],
                },
              },
              locationReference: {
                locPointLocation: {
                  coordinatesForDisplay: { latitude: 48.1, longitude: 9.1 },
                  locLocationExtensionG: {
                    facilityLocation: {
                      address: {
                        postcode: "12345",
                        city: { values: [{ value: "Ulm" }] },
                        countryCode: "DE",
                        addressLine: [
                          { type: { value: "street" }, text: { values: [{ value: "Testweg" }] } },
                          { type: { value: "houseNumber" }, text: { values: [{ value: "1" }] } },
                        ],
                      },
                    },
                  },
                },
              },
              energyInfrastructureStation: [
                {
                  idG: "station-1",
                  numberOfRefillPoints: 2,
                  refillPoint: [
                    {
                      aegiElectricChargingPoint: {
                        idG: "DE*EBW*ONE",
                        currentType: { value: "dc" },
                        connector: [{ connectorType: { value: "iec62196T2COMBO" }, maxPowerAtSocket: 150000 }],
                        electricEnergy: [
                          {
                            energyRate: [
                              {
                                idG: "adHoc",
                                applicableCurrency: ["EUR"],
                                energyPrice: [
                                  { priceType: { value: "pricePerKWh" }, value: 0.66 },
                                ],
                              },
                            ],
                          },
                        ],
                      },
                    },
                    {
                      aegiElectricChargingPoint: {
                        idG: "DE*EBW*TWO",
                        currentType: { value: "dc" },
                        connector: [{ connectorType: { value: "iec62196T2COMBO" }, maxPowerAtSocket: 150000 }],
                        electricEnergy: [
                          {
                            energyRate: [
                              {
                                idG: "adHoc",
                                applicableCurrency: ["EUR"],
                                energyPrice: [
                                  { priceType: { value: "pricePerKWh" }, value: 0.59 },
                                ],
                              },
                            ],
                          },
                        ],
                      },
                    },
                  ],
                },
              ],
            },
          ],
        },
      ],
    },
  },
});

const ENBW_DYNAMIC_REFILL_POINT = JSON.stringify({
  messageContainer: {
    payload: [
      {
        aegiEnergyInfrastructureStatusPublication: {
          energyInfrastructureSiteStatus: [
            {
              energyInfrastructureStationStatus: [
                {
                  refillPointStatus: [
                    {
                      aegiRefillPointStatus: {
                        reference: { idG: "DE*EBW*ONE" },
                        lastUpdated: "2026-04-20T09:43:01.852+02:00",
                        status: { value: "outOfOrder" },
                        energyRateUpdate: [
                          {
                            energyRateReference: { idG: "adHoc" },
                            energyPrice: [
                              { priceType: { value: "pricePerKWh" }, value: 0.59 },
                            ],
                          },
                        ],
                      },
                    },
                  ],
                },
              ],
            },
          ],
        },
      },
    ],
  },
});

describe("Mobilithek parser", () => {
  it("parses static station payloads from the official AFIR example", () => {
    const result = parseStaticMobilithekPayload(STATIC_FIXTURE);

    expect(result.stations.length).toBeGreaterThan(0);
    expect(result.catalog.length).toBe(result.stations.length);
    expect(result.stations[0].name.length).toBeGreaterThan(0);
    expect(result.stations[0].maxPowerKw).toBeGreaterThan(0);
    expect(result.stations[0].tariffs.length).toBeGreaterThan(0);
    expect(result.catalog[0]?.stationCode.length).toBeGreaterThan(0);
    expect(result.catalog[0]?.chargePoints[0]?.chargePointCode.length).toBeGreaterThan(0);
  });

  it("extracts complex tariff components like blocking fee caps from the static example", () => {
    const result = parseStaticMobilithekPayload(STATIC_FIXTURE);
    const complexTariff = result.stations
      .flatMap((station) => station.tariffs)
      .find((tariff) => tariff.blockingFeeStartsAfterMinutes != null);

    expect(complexTariff).toBeDefined();
    expect(complexTariff?.blockingFeeStartsAfterMinutes).toBeGreaterThanOrEqual(200);
    expect(complexTariff?.caps.length).toBeGreaterThan(0);
  });

  it("parses dynamic delta payloads from the official AFIR example", () => {
    const result = parseDynamicMobilithekPayload(DYNAMIC_FIXTURE);

    expect(result.updates.length).toBeGreaterThan(0);
    expect(result.updates[0].chargePointId.length).toBeGreaterThan(0);
    expect(result.updates[0].tariffs[0].pricePerKwh).toBe(0.37);
    expect(result.updates[0].statusCanonical).toBe("CHARGING");
  });

  it("keeps externally provided ids stable across repeated parses", () => {
    const first = parseStaticMobilithekPayload(STATIC_FIXTURE);
    const second = parseStaticMobilithekPayload(STATIC_FIXTURE);

    expect(first.catalog[0]?.stationCode).toBe(second.catalog[0]?.stationCode);
    expect(first.catalog[0]?.chargePoints[0]?.chargePointCode).toBe(
      second.catalog[0]?.chargePoints[0]?.chargePointCode,
    );
    expect(first.catalog[0]?.chargePoints[0]?.tariffs[0]?.id).toBe(
      second.catalog[0]?.chargePoints[0]?.tariffs[0]?.id,
    );
  });

  it("creates unique tariff instance ids when a CPO reuses one external tariff code across charge points", () => {
    const result = parseStaticMobilithekPayload(ENBW_STATIC_REUSED_TARIFF);
    const tariffs = result.catalog[0]?.chargePoints.flatMap((point) => point.tariffs) ?? [];

    expect(tariffs).toHaveLength(2);
    expect(tariffs[0]?.externalCode).toBe("adHoc");
    expect(tariffs[1]?.externalCode).toBe("adHoc");
    expect(tariffs[0]?.id).not.toBe(tariffs[1]?.id);
  });

  it("parses refill-point based dynamic status updates used by EnBW", () => {
    const result = parseDynamicMobilithekPayload(ENBW_DYNAMIC_REFILL_POINT);

    expect(result.updates).toHaveLength(1);
    expect(result.updates[0]?.chargePointId).toBe("DE*EBW*ONE");
    expect(result.updates[0]?.statusCanonical).toBe("OUT_OF_SERVICE");
    expect(result.updates[0]?.tariffs[0]?.id).toBe("charge_point|DE*EBW*ONE|adHoc");
    expect(result.updates[0]?.tariffs[0]?.pricePerKwh).toBe(0.59);
  });
});
