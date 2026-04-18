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
});
