import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { findCandidatesForRoute, planRoute, type StationRecord } from "../src/index";

const TEST_STATIONS: StationRecord[] = [
  {
    stationId: "mer-hamburg",
    cpoId: "mer",
    cpoName: "Mer Germany",
    name: "Mer Hamburg Nord",
    addressLine: "Beispielweg 1",
    city: "Hamburg",
    postalCode: "20095",
    countryCode: "DE",
    coordinates: { lat: 53.18, lng: 11.21 },
    chargePointCount: 6,
    currentTypes: ["DC"],
    connectorTypes: ["CCS"],
    paymentMethods: ["emv", "website"],
    maxPowerKw: 300,
    availabilitySummary: { available: 4, occupied: 1, outOfService: 0, unknown: 1 },
    lastPriceUpdateAt: new Date().toISOString(),
    lastStatusUpdateAt: new Date().toISOString(),
    tariffs: [
      {
        id: "mer-tariff",
        label: "Mer Direct",
        currency: "EUR",
        pricePerKwh: 0.49,
        pricePerMinute: null,
        sessionFee: null,
        preauthAmount: null,
        blockingFeePerMinute: null,
        blockingFeeStartsAfterMinutes: null,
        caps: [],
        paymentMethods: ["emv", "website"],
        brandsAccepted: [],
        isComplete: true,
      },
    ],
    notes: [],
  },
  {
    stationId: "ionity-hamburg",
    cpoId: "ionity",
    cpoName: "IONITY",
    name: "IONITY Hamburg",
    addressLine: "Beispielweg 2",
    city: "Hamburg",
    postalCode: "20095",
    countryCode: "DE",
    coordinates: { lat: 52.98, lng: 11.87 },
    chargePointCount: 8,
    currentTypes: ["DC"],
    connectorTypes: ["CCS"],
    paymentMethods: ["emv", "website"],
    maxPowerKw: 350,
    availabilitySummary: { available: 5, occupied: 3, outOfService: 0, unknown: 0 },
    lastPriceUpdateAt: new Date().toISOString(),
    lastStatusUpdateAt: new Date().toISOString(),
    tariffs: [
      {
        id: "ionity-tariff",
        label: "IONITY Direct",
        currency: "EUR",
        pricePerKwh: 0.69,
        pricePerMinute: null,
        sessionFee: null,
        preauthAmount: null,
        blockingFeePerMinute: 0.1,
        blockingFeeStartsAfterMinutes: 60,
        caps: [],
        paymentMethods: ["emv", "website"],
        brandsAccepted: [],
        isComplete: true,
      },
    ],
    notes: [],
  },
  {
    stationId: "enbw-berlin",
    cpoId: "enbw",
    cpoName: "EnBW",
    name: "EnBW Berlin",
    addressLine: "Beispielweg 3",
    city: "Berlin",
    postalCode: "10115",
    countryCode: "DE",
    coordinates: { lat: 52.63, lng: 13.07 },
    chargePointCount: 4,
    currentTypes: ["DC"],
    connectorTypes: ["CCS"],
    paymentMethods: ["emv", "website"],
    maxPowerKw: 150,
    availabilitySummary: { available: 2, occupied: 2, outOfService: 0, unknown: 0 },
    lastPriceUpdateAt: new Date().toISOString(),
    lastStatusUpdateAt: new Date().toISOString(),
    tariffs: [
      {
        id: "enbw-tariff",
        label: "EnBW Mobility+",
        currency: "EUR",
        pricePerKwh: 0.59,
        pricePerMinute: null,
        sessionFee: 0.5,
        preauthAmount: null,
        blockingFeePerMinute: null,
        blockingFeeStartsAfterMinutes: null,
        caps: [],
        paymentMethods: ["emv", "website"],
        brandsAccepted: [],
        isComplete: true,
      },
    ],
    notes: [],
  },
];

describe("route candidate selection", () => {
  beforeEach(() => {
    vi.stubGlobal(
      "fetch",
      vi.fn(async (input: RequestInfo | URL) => {
        const url = input instanceof URL ? input.toString() : String(input);

        if (url.includes("/route/v1/driving/")) {
          return new Response(
            JSON.stringify({
              routes: [
                {
                  distance: 289000,
                  duration: 11100,
                  geometry: {
                    coordinates: [
                      [13.404954, 52.520008],
                      [13.07, 52.63],
                      [11.87, 52.98],
                      [11.21, 53.18],
                      [10.27, 53.47],
                      [9.993682, 53.551086],
                    ],
                  },
                },
              ],
            }),
            {
              status: 200,
              headers: {
                "content-type": "application/json",
              },
            },
          );
        }

        throw new Error(`Unexpected fetch in test: ${url}`);
      }),
    );
  });

  afterEach(() => {
    vi.unstubAllGlobals();
    vi.restoreAllMocks();
  });

  it("keeps the cheapest complete stations with no blocking fee when filters demand it", async () => {
    const route = await planRoute("52.520008,13.404954", "53.551086,9.993682", "auto");
    const result = findCandidatesForRoute(route, {
      maxPriceKwh: 0.55,
      allowBlockingFee: false,
      onlyCompletePrices: true,
    }, TEST_STATIONS);

    expect(result.candidates).toHaveLength(1);
    expect(result.candidates[0].cpoName).toBe("Mer Germany");
  });

  it("sorts default results by price, then detour, then power", async () => {
    const route = await planRoute("52.520008,13.404954", "53.551086,9.993682", "auto");
    const result = findCandidatesForRoute(route, {
      maxPriceKwh: 0.7,
    }, TEST_STATIONS);

    expect(result.candidates.length).toBeGreaterThan(2);
    expect(result.candidates[0].cpoName).toBe("Mer Germany");
    expect(
      (result.candidates[0].tariffSummary.pricePerKwh ?? 0) <=
        (result.candidates[1].tariffSummary.pricePerKwh ?? 0),
    ).toBe(true);
  });

  it("maps public payment categories to the underlying tariff methods", async () => {
    const route = await planRoute("52.520008,13.404954", "53.551086,9.993682", "auto");
    const result = findCandidatesForRoute(route, {
      paymentMethods: ["ecCard", "creditCard", "webQr"],
    }, TEST_STATIONS);

    expect(result.candidates.length).toBeGreaterThan(0);
    expect(
      result.candidates.every((candidate) =>
        candidate.paymentMethods.includes("emv") &&
        candidate.paymentMethods.includes("website"),
      ),
    ).toBe(true);
  });

  it("reduces results when the route corridor is narrowed", async () => {
    const route = await planRoute("52.520008,13.404954", "53.551086,9.993682", "auto");
    const wide = findCandidatesForRoute(route, {}, TEST_STATIONS);
    const narrow = findCandidatesForRoute(
      {
        ...route,
        corridorKm: 2,
      },
      {},
      TEST_STATIONS,
    );

    expect(wide.candidates.length).toBeGreaterThan(0);
    expect(narrow.candidates.length).toBeLessThanOrEqual(wide.candidates.length);
  });

  it("fails clearly for truck routing without Valhalla", async () => {
    await expect(planRoute("52.520008,13.404954", "53.551086,9.993682", "truck")).rejects.toThrow(
      "LKW-Routing ist aktuell nicht konfiguriert.",
    );
  });
});
