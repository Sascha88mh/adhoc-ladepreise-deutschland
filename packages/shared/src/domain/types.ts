import { z } from "zod";

export const routeProfileSchema = z.enum(["auto", "truck"]);
export type RouteProfile = z.infer<typeof routeProfileSchema>;

export const currentTypeSchema = z.enum(["AC", "DC"]);
export type CurrentType = z.infer<typeof currentTypeSchema>;

export const coordinateSchema = z.object({
  lat: z.number(),
  lng: z.number(),
});
export type Coordinate = z.infer<typeof coordinateSchema>;

export const routeLocationSchema = z.object({
  label: z.string(),
  city: z.string().optional(),
  coordinates: coordinateSchema,
});
export type RouteLocation = z.infer<typeof routeLocationSchema>;

export const availabilitySummarySchema = z.object({
  available: z.number().int().nonnegative(),
  occupied: z.number().int().nonnegative(),
  outOfService: z.number().int().nonnegative(),
  unknown: z.number().int().nonnegative(),
});
export type AvailabilitySummary = z.infer<typeof availabilitySummarySchema>;

export const tariffCapSchema = z.object({
  label: z.string(),
  amount: z.number(),
  currency: z.string().default("EUR"),
});
export type TariffCap = z.infer<typeof tariffCapSchema>;

export const tariffSummarySchema = z.object({
  id: z.string(),
  label: z.string(),
  currency: z.string().default("EUR"),
  pricePerKwh: z.number().nullable(),
  pricePerMinute: z.number().nullable(),
  sessionFee: z.number().nullable(),
  preauthAmount: z.number().nullable(),
  blockingFeePerMinute: z.number().nullable(),
  blockingFeeStartsAfterMinutes: z.number().nullable(),
  caps: z.array(tariffCapSchema),
  paymentMethods: z.array(z.string()),
  brandsAccepted: z.array(z.string()),
  isComplete: z.boolean(),
});
export type TariffSummary = z.infer<typeof tariffSummarySchema>;

export const chargePointStatusSchema = z.enum([
  "AVAILABLE",
  "CHARGING",
  "RESERVED",
  "BLOCKED",
  "OUT_OF_SERVICE",
  "MAINTENANCE",
  "UNKNOWN",
]);
export type ChargePointStatus = z.infer<typeof chargePointStatusSchema>;

export const stationRecordSchema = z.object({
  stationId: z.string(),
  cpoId: z.string(),
  cpoName: z.string(),
  name: z.string(),
  addressLine: z.string(),
  city: z.string(),
  postalCode: z.string(),
  countryCode: z.string().default("DE"),
  coordinates: coordinateSchema,
  chargePointCount: z.number().int().positive(),
  currentTypes: z.array(currentTypeSchema),
  connectorTypes: z.array(z.string()),
  paymentMethods: z.array(z.string()),
  maxPowerKw: z.number().positive(),
  availabilitySummary: availabilitySummarySchema,
  lastPriceUpdateAt: z.string(),
  lastStatusUpdateAt: z.string(),
  tariffs: z.array(tariffSummarySchema),
  notes: z.array(z.string()).default([]),
});
export type StationRecord = z.infer<typeof stationRecordSchema>;

export const routePlanSchema = z.object({
  routeId: z.string(),
  profile: routeProfileSchema,
  corridorKm: z.number().positive(),
  origin: routeLocationSchema,
  destination: routeLocationSchema,
  geometry: z.array(coordinateSchema).min(2),
  distanceKm: z.number().positive(),
  durationMinutes: z.number().positive(),
  bounds: z.object({
    minLat: z.number(),
    minLng: z.number(),
    maxLat: z.number(),
    maxLng: z.number(),
  }),
  alternatives: z.array(
    z.object({
      id: z.string(),
      label: z.string(),
      distanceKm: z.number().positive(),
      durationMinutes: z.number().positive(),
    }),
  ),
});
export type RoutePlan = z.infer<typeof routePlanSchema>;

export const routeCandidateSchema = z.object({
  stationId: z.string(),
  stationName: z.string(),
  cpoId: z.string(),
  cpoName: z.string(),
  lat: z.number(),
  lng: z.number(),
  addressLine: z.string(),
  city: z.string(),
  distanceFromRouteKm: z.number().nonnegative(),
  detourMinutes: z.number().nonnegative(),
  maxPowerKw: z.number().positive(),
  chargePointCount: z.number().int().positive(),
  currentTypes: z.array(currentTypeSchema),
  connectorTypes: z.array(z.string()),
  availabilitySummary: availabilitySummarySchema,
  tariffSummary: tariffSummarySchema,
  paymentMethods: z.array(z.string()),
  lastPriceUpdateAt: z.string(),
  lastStatusUpdateAt: z.string(),
  freshnessMinutes: z.number().nonnegative(),
});
export type RouteCandidate = z.infer<typeof routeCandidateSchema>;

export const stationDetailSchema = stationRecordSchema.extend({
  exportTargets: z.object({
    googleMaps: z.string().url(),
    appleMaps: z.string().url(),
    waze: z.string().url(),
    coordinates: z.string(),
  }),
});
export type StationDetail = z.infer<typeof stationDetailSchema>;

export const candidateFiltersSchema = z.object({
  corridorKm: z.number().positive().optional(),
  maxPriceKwh: z.number().positive().optional(),
  minPowerKw: z.number().positive().optional(),
  minChargePointCount: z.number().int().positive().optional(),
  currentTypes: z.array(currentTypeSchema).optional(),
  paymentMethods: z.array(z.string()).optional(),
  cpoIds: z.array(z.string()).optional(),
  availableOnly: z.boolean().optional(),
  allowSessionFee: z.boolean().optional(),
  allowBlockingFee: z.boolean().optional(),
  onlyCompletePrices: z.boolean().optional(),
  freshWithinMinutes: z.number().int().positive().optional(),
  sort: z.enum(["price", "detour", "power"]).optional(),
});
export type CandidateFilters = z.infer<typeof candidateFiltersSchema>;

export const routePlanRequestSchema = z.object({
  origin: z.string().min(1),
  destination: z.string().min(1),
  profile: routeProfileSchema.default("auto"),
});
export type RoutePlanRequest = z.infer<typeof routePlanRequestSchema>;

export const locationSuggestionSchema = z.object({
  id: z.string(),
  label: z.string(),
  secondaryLabel: z.string().nullable(),
  inputLabel: z.string(),
  query: z.string(),
  coordinates: coordinateSchema,
});
export type LocationSuggestion = z.infer<typeof locationSuggestionSchema>;

export const routeCandidatesRequestSchema = z.object({
  routeId: z.string().optional(),
  polyline: z.array(coordinateSchema).min(2).optional(),
  filters: candidateFiltersSchema.default({}),
}).refine((value) => Boolean(value.routeId || value.polyline), {
  message: "Either routeId or polyline is required",
  path: ["routeId"],
});
export type RouteCandidatesRequest = z.infer<typeof routeCandidatesRequestSchema>;

export const feedConfigSchema = z.object({
  id: z.string(),
  source: z.enum(["mobilithek"]).default("mobilithek"),
  cpoId: z.string().nullable(),
  name: z.string(),
  mode: z.enum(["push", "pull", "hybrid"]),
  type: z.enum(["static", "dynamic"]),
  subscriptionId: z.string(),
  urlOverride: z.string().nullable(),
  pollIntervalMinutes: z.number().int().positive().nullable(),
  reconciliationIntervalMinutes: z.number().int().positive().nullable(),
  isActive: z.boolean(),
  ingestCatalog: z.boolean().default(true),
  ingestPrices: z.boolean().default(true),
  ingestStatus: z.boolean().default(false),
  credentialRef: z.string().nullable(),
  webhookSecretRef: z.string().nullable(),
  notes: z.string(),
  lastSuccessAt: z.string().nullable(),
  lastSnapshotAt: z.string().nullable(),
  lastDeltaCount: z.number().int().nonnegative(),
  errorRate: z.number().min(0).max(1),
  cursorState: z.record(z.string(), z.unknown()).nullable().default(null),
  lastErrorMessage: z.string().nullable().default(null),
  consecutiveFailures: z.number().int().nonnegative().default(0),
});
export type FeedConfig = z.infer<typeof feedConfigSchema>;

export const syncRunSchema = z.object({
  id: z.string(),
  feedId: z.string(),
  kind: z.enum(["test", "manual", "webhook", "reconciliation"]),
  status: z.enum(["queued", "running", "success", "failed"]),
  startedAt: z.string(),
  finishedAt: z.string().nullable(),
  message: z.string(),
  deltaCount: z.number().int().nonnegative(),
});
export type SyncRun = z.infer<typeof syncRunSchema>;

export const webhookDeliverySchema = z.object({
  id: z.string(),
  feedId: z.string(),
  receivedAt: z.string(),
  status: z.enum(["accepted", "ignored", "failed"]),
  payloadSize: z.number().int().nonnegative(),
});
export type WebhookDelivery = z.infer<typeof webhookDeliverySchema>;

export const stationOverrideSchema = z.object({
  stationId: z.string(),
  displayName: z.string().nullable(),
  addressLine: z.string().nullable(),
  city: z.string().nullable(),
  postalCode: z.string().nullable(),
  maxPowerKw: z.number().nullable(),
  isHidden: z.boolean(),
  adminNote: z.string().nullable(),
  updatedAt: z.string(),
});
export type StationOverride = z.infer<typeof stationOverrideSchema>;

export const adminStationRecordSchema = z.object({
  stationId: z.string(),
  stationCode: z.string(),
  cpoId: z.string(),
  cpoName: z.string(),
  sourceName: z.string(),
  effectiveName: z.string(),
  sourceAddressLine: z.string(),
  effectiveAddressLine: z.string(),
  sourceCity: z.string(),
  effectiveCity: z.string(),
  sourcePostalCode: z.string(),
  effectivePostalCode: z.string(),
  sourceMaxPowerKw: z.number(),
  effectiveMaxPowerKw: z.number(),
  isHidden: z.boolean(),
  override: stationOverrideSchema.nullable(),
});
export type AdminStationRecord = z.infer<typeof adminStationRecordSchema>;

export const publicRoutePlanResponseSchema = z.object({
  data: routePlanSchema,
});

export const publicLocationSuggestionsResponseSchema = z.object({
  data: z.array(locationSuggestionSchema),
});

export const publicReverseLocationResponseSchema = z.object({
  data: locationSuggestionSchema,
});

export const publicCandidatesResponseSchema = z.object({
  data: z.object({
    route: routePlanSchema,
    filters: candidateFiltersSchema,
    candidates: z.array(routeCandidateSchema),
    providerList: z.array(
      z.object({
        cpoId: z.string(),
        cpoName: z.string(),
        stations: z.number().int().positive(),
      }),
    ),
    priceBand: z.object({
      min: z.number().nullable(),
      max: z.number().nullable(),
    }),
  }),
});

export const publicMapStationsResponseSchema = z.object({
  data: z.array(routeCandidateSchema),
});

export const stationDetailResponseSchema = z.object({
  data: stationDetailSchema,
});

export const feedConfigResponseSchema = z.object({
  data: z.array(feedConfigSchema),
});

export const syncRunsResponseSchema = z.object({
  data: z.array(syncRunSchema),
});

export const stationOverridesResponseSchema = z.object({
  data: z.array(adminStationRecordSchema),
});
