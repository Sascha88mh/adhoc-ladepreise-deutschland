import { describe, expect, it } from "vitest";
import { findCandidatesForRoute, planRoute } from "../src/index";

describe("route candidate selection", () => {
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
});
