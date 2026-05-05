import { reverseGeocodeLocation } from "@adhoc/shared";

type IpApiResponse = {
  city?: string;
  region?: string;
  country_name?: string;
  latitude?: number;
  longitude?: number;
};

function fallbackLocation() {
  return Response.json({
    data: {
      id: "fallback-deutschland",
      label: "Deutschland",
      secondaryLabel: null,
      inputLabel: "Deutschland",
      query: "51.16570, 10.45150",
      coordinates: {
        lat: 51.1657,
        lng: 10.4515,
      },
    },
  });
}

export async function GET() {
  try {
    const response = await fetch("https://ipapi.co/json/", {
      headers: {
        accept: "application/json",
      },
      cache: "no-store",
    });

    if (!response.ok) {
      return fallbackLocation();
    }

    const payload = (await response.json()) as IpApiResponse;

    if (
      typeof payload.latitude !== "number" ||
      typeof payload.longitude !== "number"
    ) {
      return fallbackLocation();
    }

    const reverse = await reverseGeocodeLocation(payload.latitude, payload.longitude);

    if (reverse) {
      return Response.json({
        data: {
          ...reverse,
          label: reverse.label || payload.city || "Ungefaehre Position",
        },
      });
    }

    const inputLabel = [payload.city, payload.region, payload.country_name]
      .filter(Boolean)
      .join(", ");

    return Response.json({
      data: {
        id: `ip-${payload.latitude}-${payload.longitude}`,
        label: payload.city || "Ungefaehre Position",
        secondaryLabel: [payload.region, payload.country_name].filter(Boolean).join(", ") || null,
        inputLabel: inputLabel || `${payload.latitude.toFixed(4)}, ${payload.longitude.toFixed(4)}`,
        query: `${payload.latitude.toFixed(5)}, ${payload.longitude.toFixed(5)}`,
        coordinates: {
          lat: payload.latitude,
          lng: payload.longitude,
        },
      },
    });
  } catch {
    return fallbackLocation();
  }
}
