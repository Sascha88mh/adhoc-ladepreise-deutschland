import { afterEach, describe, expect, it, vi } from "vitest";
import {
  reverseGeocodeLocation,
  searchLocations,
} from "../src/index";

describe("geocoder helpers", () => {
  afterEach(() => {
    vi.unstubAllGlobals();
    vi.restoreAllMocks();
  });

  it("returns mapped suggestions for partial search queries", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(async (input: RequestInfo | URL) => {
        const url = input instanceof URL ? input.toString() : String(input);

        if (url.includes("/search")) {
          return new Response(
            JSON.stringify([
              {
                place_id: 1,
                lat: "52.520008",
                lon: "13.404954",
                name: "Berlin",
                display_name: "Berlin, Deutschland",
              },
            ]),
            {
              status: 200,
              headers: {
                "content-type": "application/json",
              },
            },
          );
        }

        throw new Error(`Unexpected fetch in geocoder test: ${url}`);
      }),
    );

    const result = await searchLocations("Ber", 5);

    expect(result[0]?.label).toBe("Berlin");
    expect(result[0]?.inputLabel).toBe("Berlin, Deutschland");
  });

  it("reverse geocodes coordinates into a suggestion", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(async (input: RequestInfo | URL) => {
        const url = input instanceof URL ? input.toString() : String(input);

        if (url.includes("/reverse")) {
          return new Response(
            JSON.stringify({
              place_id: 2,
              lat: "52.520008",
              lon: "13.404954",
              name: "176",
              display_name: "176, Invalidenstraße, Mitte, Berlin, 10115, Deutschland",
              address: {
                house_number: "176",
                road: "Invalidenstraße",
                postcode: "10115",
                city: "Berlin",
                country: "Deutschland",
              },
            }),
            {
              status: 200,
              headers: {
                "content-type": "application/json",
              },
            },
          );
        }

        throw new Error(`Unexpected fetch in reverse geocoder test: ${url}`);
      }),
    );

    const result = await reverseGeocodeLocation(52.520008, 13.404954);

    expect(result?.label).toBe("176");
    expect(result?.inputLabel).toBe("Invalidenstraße 176, 10115 Berlin");
    expect(result?.secondaryLabel).toBe("10115 Berlin");
  });
});
