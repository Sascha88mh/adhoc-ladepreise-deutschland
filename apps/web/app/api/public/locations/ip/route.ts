import { reverseGeocodeLocation } from "@adhoc/shared";

type IpApiResponse = {
  city?: string;
  region?: string;
  country_name?: string;
  latitude?: number;
  longitude?: number;
};

export async function GET() {
  try {
    const response = await fetch("https://ipapi.co/json/", {
      headers: {
        accept: "application/json",
      },
      cache: "no-store",
    });

    if (!response.ok) {
      return Response.json(
        { error: "IP-Standort konnte nicht geladen werden." },
        { status: 502 },
      );
    }

    const payload = (await response.json()) as IpApiResponse;

    if (
      typeof payload.latitude !== "number" ||
      typeof payload.longitude !== "number"
    ) {
      return Response.json(
        { error: "IP-Standort konnte nicht aufgeloest werden." },
        { status: 502 },
      );
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
    return Response.json(
      { error: "IP-Standort konnte nicht geladen werden." },
      { status: 502 },
    );
  }
}
