import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { findCandidatesForRoute, planRoute } from "../src/index";

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
    const route = await planRoute("Berlin", "Hamburg", "auto");
    const result = findCandidatesForRoute(route, {
      maxPriceKwh: 0.55,
      allowBlockingFee: false,
      onlyCompletePrices: true,
    });

    expect(result.candidates).toHaveLength(1);
    expect(result.candidates[0].cpoName).toBe("Mer Germany");
  });

  it("sorts default results by price, then detour, then power", async () => {
    const route = await planRoute("Berlin", "Hamburg", "auto");
    const result = findCandidatesForRoute(route, {
      maxPriceKwh: 0.7,
    });

    expect(result.candidates.length).toBeGreaterThan(2);
    expect(result.candidates[0].cpoName).toBe("Mer Germany");
    expect(
      (result.candidates[0].tariffSummary.pricePerKwh ?? 0) <=
        (result.candidates[1].tariffSummary.pricePerKwh ?? 0),
    ).toBe(true);
  });

  it("maps public payment categories to the underlying tariff methods", async () => {
    const route = await planRoute("Berlin", "Hamburg", "auto");
    const result = findCandidatesForRoute(route, {
      paymentMethods: ["ecCard", "creditCard", "webQr"],
    });

    expect(result.candidates.length).toBeGreaterThan(0);
    expect(
      result.candidates.every((candidate) =>
        candidate.paymentMethods.includes("emv") &&
        candidate.paymentMethods.includes("website"),
      ),
    ).toBe(true);
  });

  it("reduces results when the route corridor is narrowed", async () => {
    const route = await planRoute("Berlin", "Hamburg", "auto");
    const wide = findCandidatesForRoute(route, {});
    const narrow = findCandidatesForRoute(
      {
        ...route,
        corridorKm: 2,
      },
      {},
    );

    expect(wide.candidates.length).toBeGreaterThan(0);
    expect(narrow.candidates.length).toBeLessThanOrEqual(wide.candidates.length);
  });

  it("fails clearly for truck routing without Valhalla", async () => {
    await expect(planRoute("Berlin", "Hamburg", "truck")).rejects.toThrow(
      "LKW-Routing ist aktuell nicht konfiguriert.",
    );
  });
});
