// lib/datex2/parser.ts
//
// Parses DATEX II V3 JSON from Mobilithek.
//
// Actual Mobilithek format (all feeds observed in production):
//   messageContainer.payload[].aegiEnergyInfrastructureStatusPublication
//     .energyInfrastructureSiteStatus[]
//       .energyInfrastructureStationStatus[]
//         .refillPointStatus[]
//           .aegiElectricChargingPointStatus | .aegiRefillPointStatus
//             .reference.idG  → EVSE ID
//             .status.value   → availability status

// ─── Internal normalized types (matches existing DB schema) ─────────────────

export interface Datex2Station {
  datex2Id: string;
  cpoId?: string;
  name?: string;
  address?: { street?: string; city?: string; zip?: string; country?: string };
  coordinates: { lat: number; lng: number };
  openingHours?: { alwaysOpen: boolean };
  chargePoints: Datex2ChargePoint[];
}

export interface Datex2ChargePoint {
  datex2Id: string;
  connectorType: string;
  connectorFormat: string;
  powerKw: number;
  voltageV?: number;
  ampereA?: number;
  currentType: 'AC' | 'DC';
  status?: string;
  paymentMethods?: string[];
  adhocPricePerKwh?: number;
  adhocPricePerMin?: number;
  adhocPriceFlat?: number;
  adhocPreAuthAmount?: number;
}

// ─── Internal types for messageContainer format ───────────────────────────────

interface AegiCpRef { idG: string }
interface AegiEnergyPrice { priceType?: { value?: string }; value?: number }
interface AegiEnergyRateUpdate { energyPrice?: AegiEnergyPrice[] }
interface AegiCpStatus {
  reference?: AegiCpRef;
  status?: { value?: string };
  energyRateUpdate?: AegiEnergyRateUpdate[];
}
interface AegiRefillPoint {
  aegiElectricChargingPointStatus?: AegiCpStatus;
  aegiRefillPointStatus?: AegiCpStatus;
}
interface AegiStationStatus { refillPointStatus?: AegiRefillPoint[] }
interface AegiSiteStatus { energyInfrastructureStationStatus?: AegiStationStatus[] }
interface AegiStatusPublication { energyInfrastructureSiteStatus?: AegiSiteStatus[] }

// ─── Parse functions ──────────────────────────────────────────────────────────

export interface AvailabilityUpdate {
  datex2Id: string;
  status: string;
  pricePerKwh?: number;
  pricePerMin?: number;
  priceFlat?: number;
}

/**
 * Parse DATEX II V3 JSON from Mobilithek.
 * Handles:
 *   - messageContainer format (actual Mobilithek AEGI profile, all current feeds)
 *   - d2LogicalModel format (legacy / AFIR profile, kept for future compatibility)
 *   - eliso custom format: { "evses": [...] }
 */
export function parseDatex2Json(json: string): {
  stations: Datex2Station[];
  availabilityUpdates: AvailabilityUpdate[];
} {
  let root: Record<string, unknown>;

  try {
    root = JSON.parse(json) as Record<string, unknown>;
  } catch (e) {
    console.error('[datex2 parser] Invalid JSON:', e);
    return { stations: [], availabilityUpdates: [] };
  }

  // ── eliso custom format: { "evses": [...] } ─────────────────────────────
  if (Array.isArray((root as { evses?: unknown }).evses)) {
    return parseElisoJson(root as { evses: ElisoEvse[] });
  }

  // ── New format: messageContainer.payload[] ───────────────────────────────
  const mc = root?.messageContainer as { payload?: unknown[] } | undefined;
  if (mc?.payload?.length) {
    return parseMsgContainerPayloads(mc.payload);
  }

  // ── Legacy format: d2LogicalModel.payloadPublication ────────────────────
  const lm = (root as { d2LogicalModel?: { payloadPublication?: Record<string, unknown> } })
    ?.d2LogicalModel;
  const payload = lm?.payloadPublication;
  if (!payload) {
    console.warn('[datex2 parser] Unrecognized root structure — no messageContainer or d2LogicalModel');
    return { stations: [], availabilityUpdates: [] };
  }

  return parseLegacyPayload(payload);
}

// ─── eliso custom dynamic format ─────────────────────────────────────────────
// Format: { "evses": [{ evseId, adhoc_price, operational_status, availability_status }] }
// operational_status: "Operational" | "Non-operational"
// availability_status: "Not in use" | "In use"

interface ElisoEvse {
  evseId?: string;
  adhoc_price?: number;
  blocking_fee?: number;
  operational_status?: string;
  availability_status?: string;
}

function parseElisoJson(data: { evses: ElisoEvse[] }): {
  stations: Datex2Station[];
  availabilityUpdates: AvailabilityUpdate[];
} {
  const availabilityUpdates: AvailabilityUpdate[] = [];

  for (const evse of data.evses ?? []) {
    if (!evse.evseId) continue;

    let status: string;
    if (evse.operational_status === 'Non-operational') {
      status = 'OUT_OF_SERVICE';
    } else if (evse.availability_status === 'In use') {
      status = 'OCCUPIED';
    } else if (evse.availability_status === 'Not in use') {
      status = 'AVAILABLE';
    } else {
      status = 'UNKNOWN';
    }

    const update: AvailabilityUpdate = { datex2Id: evse.evseId, status };
    if (typeof evse.adhoc_price === 'number') {
      update.pricePerKwh = evse.adhoc_price;
    }
    availabilityUpdates.push(update);
  }

  return { stations: [], availabilityUpdates };
}

// ─── messageContainer format ─────────────────────────────────────────────────

function parseMsgContainerPayloads(payloads: unknown[]): {
  stations: Datex2Station[];
  availabilityUpdates: AvailabilityUpdate[];
} {
  const availabilityUpdates: AvailabilityUpdate[] = [];
  const stations: Datex2Station[] = [];

  for (const p of payloads) {
    const payload = p as Record<string, unknown>;

    // Status/availability publication
    const statusPub = payload['aegiEnergyInfrastructureStatusPublication'] as AegiStatusPublication | undefined;
    if (statusPub) {
      for (const site of statusPub.energyInfrastructureSiteStatus ?? []) {
        for (const station of site.energyInfrastructureStationStatus ?? []) {
          for (const rp of station.refillPointStatus ?? []) {
            // CPOs use either aegiElectricChargingPointStatus or aegiRefillPointStatus
            const cp = rp.aegiElectricChargingPointStatus ?? rp.aegiRefillPointStatus;
            if (!cp) continue;
            const id = cp.reference?.idG;
            const rawStatus = cp.status?.value;
            if (!id || !rawStatus) continue;

            const update: AvailabilityUpdate = {
              datex2Id: id,
              status: normalizeDatex2Status(rawStatus),
            };

            // Extract pricing from energyRateUpdate (e.g. SMATRICS dynamic feed)
            for (const rateUpdate of cp.energyRateUpdate ?? []) {
              for (const price of rateUpdate.energyPrice ?? []) {
                const type = price.priceType?.value?.toLowerCase() ?? '';
                const val = typeof price.value === 'number' ? price.value : undefined;
                if (val === undefined) continue;
                if (type === 'priceperunit' || type === 'priceperkwh') update.pricePerKwh = val;
                else if (type === 'priceperminute' || type === 'pricepertime') update.pricePerMin = val;
                else if (type === 'flatfee' || type === 'sessionfee') update.priceFlat = val;
              }
            }

            availabilityUpdates.push(update);
          }
        }
      }
    }

    // Static station table publication — structure TBD when first static feed is approved
    const tablePub = payload['aegiEnergyInfrastructureTablePublication'];
    if (tablePub) {
      console.log('[datex2 parser] Received aegiEnergyInfrastructureTablePublication — static station seeding not yet implemented');
      // TODO: parse static station data once we have a confirmed example
    }
  }

  return { stations, availabilityUpdates };
}

// ─── Legacy d2LogicalModel format ────────────────────────────────────────────

function parseLegacyPayload(payload: Record<string, unknown>): {
  stations: Datex2Station[];
  availabilityUpdates: AvailabilityUpdate[];
} {
  if (payload._type === 'AfirEnergyInfrastructureTableStatusPublication') {
    const groups = (payload.afirEnergyInfrastructureTableStatus as Array<{
      evseStatuses?: Array<{ evseId: string; evseAvailabilityStatus: string }>;
    }>) ?? [];
    const updates: AvailabilityUpdate[] = groups.flatMap(g =>
      (g.evseStatuses ?? []).map(e => ({
        datex2Id: e.evseId,
        status: normalizeDatex2Status(e.evseAvailabilityStatus),
      }))
    );
    return { stations: [], availabilityUpdates: updates };
  }

  if (payload._type === 'AfirEnergyInfrastructureTablePublication') {
    // Legacy static station format — reuse existing parse logic via dynamic import workaround
    console.log('[datex2 parser] Legacy AfirEnergyInfrastructureTablePublication — parsing stations');
    const table = (payload.afirEnergyInfrastructureTable as unknown[]) ?? [];
    const stations = table.map(parseLegacyStation).filter(Boolean) as Datex2Station[];
    return { stations, availabilityUpdates: [] };
  }

  console.warn('[datex2 parser] Unknown legacy payload type:', payload._type);
  return { stations: [], availabilityUpdates: [] };
}

function parseLegacyStation(s: unknown): Datex2Station | null {
  const station = s as {
    id: string;
    facilityLocation?: {
      coordinates?: { latitude: number; longitude: number };
      address?: { streetName?: string; houseNumber?: string; city?: string; postcode?: string; country?: string };
    };
    operatorInformation?: { operatorName?: string };
    openingTimes?: { twentyFourHoursDay?: boolean; openAllYear?: boolean };
    evses?: Array<{
      connectors?: unknown[];
      paymentMethods?: Array<{ paymentMethodType: string }>;
    }>;
  };
  const loc = station.facilityLocation;
  if (!loc?.coordinates) return null;
  return {
    datex2Id: station.id,
    name: station.operatorInformation?.operatorName,
    address: {
      street: loc.address?.streetName
        ? `${loc.address.streetName} ${loc.address.houseNumber ?? ''}`.trim()
        : undefined,
      city: loc.address?.city,
      zip: loc.address?.postcode,
      country: loc.address?.country === 'DEU' ? 'DE' : (loc.address?.country ?? 'DE'),
    },
    coordinates: { lat: loc.coordinates.latitude, lng: loc.coordinates.longitude },
    openingHours: {
      alwaysOpen: station.openingTimes?.twentyFourHoursDay ?? station.openingTimes?.openAllYear ?? true,
    },
    chargePoints: [],
  };
}

// ─── Normalization helpers ────────────────────────────────────────────────────

export function normalizeDatex2Status(raw: string): string {
  if (!raw) return 'UNKNOWN';
  // Normalize: lowercase, remove non-alphanumeric
  const key = raw.toLowerCase().replace(/[^a-z]/g, '');
  const map: Record<string, string> = {
    'available':      'AVAILABLE',
    'occupied':       'OCCUPIED',
    'charging':       'OCCUPIED',   // EnBW/AEGI "charging" = occupied
    'reserved':       'RESERVED',
    'outofservice':   'OUT_OF_SERVICE',
    'outoforder':     'OUT_OF_SERVICE',  // SMATRICS "outOfOrder"
    'inoperative':    'OUT_OF_SERVICE',
    'planned':        'PLANNED',
    'unknown':        'UNKNOWN',
    'offline':        'OUT_OF_SERVICE',
    'inoperation':    'AVAILABLE',  // Tesla "inOperation" status field (not status.value)
  };
  return map[key] ?? 'UNKNOWN';
}

export function normalizeConnectorType(raw: string): string {
  if (!raw) return 'Type2';
  const r = raw.toUpperCase().replace(/[_\s-]/g, '');
  if (r.includes('IEC62196T2COMBO') || r.includes('COMBO2') || r.includes('CCS')) return 'CCS';
  if (r.includes('CHADEMO')) return 'CHAdeMO';
  if (r.includes('TESLA') || r.includes('NACS')) return 'Tesla';
  if (r.includes('IEC62196T2') || r.includes('TYPE2') || r.includes('T2')) return 'Type2';
  if (r.includes('IEC62196T1') || r.includes('TYPE1')) return 'Type1';
  return raw;
}

// ─── XML parser (Smartlab / ladenetz.de DATEX II V3 XML) ─────────────────────
//
// Format: EnergyInfrastructureStatusPublication in messageContainer XML.
// EVSE IDs from <ns6:reference id="DE1ESExxxxxx"/> inside refillPointStatus.
// Status from <ns11:status>available|charging|outOfService|...</ns11:status>.
//
// Smartlab sends compact IDs without `*` separators (e.g. "DE1ESE020701").
// BNetzA stores them with separators ("DE*1ES*E020701"). normalizeCompactEvseId
// converts between the two so upsertAvailability finds the matching row.

function normalizeCompactEvseId(id: string): string {
  if (id.includes('*')) return id; // already in standard format
  if (id.length < 7) return id;    // too short to split safely
  // "DE1ESE020701" → "DE*1ES*E020701"
  return `${id.slice(0, 2)}*${id.slice(2, 5)}*${id.slice(5)}`;
}

export function parseDatex2Xml(xml: string): {
  stations: Datex2Station[];
  availabilityUpdates: AvailabilityUpdate[];
} {
  const availabilityUpdates: AvailabilityUpdate[] = [];

  // Match each refillPointStatus block (ns11 prefix used by ladenetz.de)
  const refillBlockRx =
    /<ns11:refillPointStatus[^>]*>([\s\S]*?)<\/ns11:refillPointStatus>/g;

  let block: RegExpExecArray | null;
  while ((block = refillBlockRx.exec(xml)) !== null) {
    const content = block[1];

    // EVSE ID from <ns6:reference id="..." .../>
    const idMatch = content.match(/<ns6:reference\s[^>]*\bid="([^"]+)"/);
    if (!idMatch) continue;
    const datex2Id = normalizeCompactEvseId(idMatch[1]);

    // Status from <ns11:status>...</ns11:status>
    const statusMatch = content.match(/<ns11:status>([^<]+)<\/ns11:status>/);
    if (!statusMatch) continue;

    availabilityUpdates.push({
      datex2Id,
      status: normalizeDatex2Status(statusMatch[1].trim()),
    });
  }

  return { stations: [], availabilityUpdates };
}
