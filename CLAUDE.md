# CLAUDE.md — Adhoc Plattform

Operativer Leitfaden für Claude-Sessions in diesem Monorepo. Für tiefe Doku → [`docs/`](./docs/):
- [`ARCHITECTURE.md`](./docs/ARCHITECTURE.md) — Aufbau, Datenflüsse, Hot-Spot-Dateien
- [`SECURITY.md`](./docs/SECURITY.md) — Auth, Webhooks, Secrets
- [`DEPLOYMENT.md`](./docs/DEPLOYMENT.md) — Netlify/Railway/Supabase-Setup
- [`FEEDS.md`](./docs/FEEDS.md) — Feed-Onboarding und -Betrieb (Single Source of Truth)

---

## Kommunikationsstil

- Datei- und Zeilenlinks in Antworten nur sparsam verwenden.
- Solche Links nur dann einfügen, wenn sie den konkreten Punkt wesentlich klarer machen, z. B. bei Review-Findings, Debugging-Hinweisen oder gezielten Codeverweisen.
- Keine automatische Pfad-Link-Sammlung an fast jeden Satz anhängen.
- Wenn ein normaler Klartextsatz ausreicht, Klartext ohne Datei-Link bevorzugen.

---

## Projektstruktur (Schnellüberblick)

```
apps/web/                Next.js 16 App + Admin
apps/ingest/             Cron-Worker (CLI)
apps/mobilithek-gateway/ Cloudflare Worker (Webhook-Reserve)
packages/shared/         Domain (Parser, DB, Ingest, Geo)
db/                      schema.sql + migrations/ + fixtures/
docs/                    Doku (siehe oben)
```

Wichtige Dateien:

| Zweck | Datei |
|---|---|
| DATEX-II/AFIR-Parser | `packages/shared/src/mobilithek/parser.ts` |
| Ingest-Orchestrierung | `packages/shared/src/ingest/index.ts` |
| Domain-Typen (Zod) | `packages/shared/src/domain/types.ts` |
| DB-Queries (public) | `packages/shared/src/db/public.ts` |
| DB-Queries (admin) | `packages/shared/src/db/admin.ts` |
| Admin-Auth-Middleware | `apps/web/middleware.ts` + `apps/web/lib/supabase/middleware.ts` |
| Admin-API-Guard | `apps/web/lib/supabase/require-admin.ts` |
| Edge Webhook | `apps/web/netlify/edge-functions/mobilithek-webhook.ts` |
| Cron Sync | `apps/web/netlify/functions/ingest-sync.mts` |

---

## Häufige Kommandos

```sh
# TypeScript prüfen (beide Pakete)
cd packages/shared && npx tsc --noEmit
cd apps/web && npx tsc --noEmit

# Parser gegen echte Payload testen
cat > /tmp/test.mts << 'EOF'
import { parseStaticMobilithekPayload } from '/abs/path/to/packages/shared/src/mobilithek/parser.ts';
import { readFileSync } from 'fs';
const result = parseStaticMobilithekPayload(readFileSync('/path/to/payload.json', 'utf8'));
console.log('Stationen:', result.catalog.length);
EOF
npx tsx /tmp/test.mts

# DB direkt abfragen
cat > /tmp/db.mjs << 'EOF'
import { createRequire } from 'module';
import { readFileSync } from 'fs';
const require = createRequire(import.meta.url);
const pg = require('<root>/node_modules/.pnpm/pg@8.20.0/node_modules/pg/lib/index.js');
const url = readFileSync('<root>/apps/web/.env.local', 'utf8')
  .split('\n').find(l => l.startsWith('DATABASE_URL='))?.replace('DATABASE_URL=','').trim();
const pool = new pg.Pool({ connectionString: url, ssl: { rejectUnauthorized: false } });
const r = await pool.query('SELECT count(*) FROM stations');
console.log(r.rows);
await pool.end();
EOF
node /tmp/db.mjs
```

---

## Deployment vs. Lokal

| Kontext | Welcher Code läuft? |
|---|---|
| Netlify Cron (jede Minute) | **Deployed Code** — erst nach `git push` + Netlify-Build aktiv |
| Admin-Console Sync-Button (lokal) | **Lokaler Code** — sofort nach Speichern |
| `next dev` API-Routes | **Lokaler Code** — hot-reload aktiv |

→ Nach Parser-Fixes immer manuell über lokale Admin-Console synchen (`/admin` → Feed → Sync), nicht auf Netlify-Cron warten.
→ Wenn Netlify-App läuft aber DB-Daten falsch sind: Prüfen, ob Netlify mit altem Code deployt ist.

---

## Auth (seit 2026-05-05)

- Admin-Bereich (`/admin`, `/api/admin/*`) ist hinter Supabase Auth.
- Schutz: **Middleware (apps/web/middleware.ts)** + **`requireAdmin()` in jeder API-Route** (Defense in Depth).
- User wird im Supabase-Dashboard manuell angelegt.
- Allowlist via `ADMIN_EMAILS` (Komma-Liste). Nur diese Emails dürfen Admin sein, auch wenn ein Supabase-User sonst existiert.
- Logout-Button im Admin-Header.

Beim Anlegen einer **neuen Admin-API-Route**: zwingend mit
```ts
const guard = await requireAdmin();
if (!guard.ok) return adminGuardResponse(guard);
```
beginnen. Middleware allein reicht nicht — Defense in Depth.

---

## DATEX-II Parser — Kernkonzepte

### Hierarchie

```
energyInfrastructureSite        ← Physischer Standort (eine Adresse)
  └─ energyInfrastructureStation ← Eine Ladesäule
       └─ refillPoint             ← Ein Ladepunkt (Stecker)
            └─ aegiElectricChargingPoint
```

### Aggregierungsregeln (ab 2026-04-19)

| Site hat eigene `locationReference`? | Ergebnis |
|---|---|
| Ja (Coords + Adresse auf Site) | **1 DB-Station pro Site**, `stationCode = site.idG`. Alle Stationen aggregiert. ← EnBW, Tesla |
| Nein (Location nur auf Station) | **1 DB-Station pro `energyInfrastructureStation`** ← Vaylens |

### CPO-IDs aus Payload

`cpoId` = `site.operator.afacAnOrganisation.externalIdentifier[0].identifier`
→ Für EnBW: `"EBW"` (nicht `"enbw"`, nicht `"ENBW"`)
→ `feed_configs.cpo_id` muss damit übereinstimmen — oder leer lassen

### Bekannte Payload-Eigenheiten

| CPO | Besonderheit |
|---|---|
| Tesla | `availableChargingPower = null` auf allen Charge Points; Leistung aus `connector.maxPowerAtSocket` (Watt ÷ 1000) |
| EnBW | Bis zu 20 `energyInfrastructureStation` pro Site; site.idG als stationCode verwenden |
| Vaylens | `locationReference` auf Station-Ebene statt Site-Ebene; ~75 MB Payload |

---

## DB-Schema (Kernpunkte)

- `stations.station_code` — UNIQUE, von Parser gesetzt (`site.idG` oder Stable-Hash)
- `charge_points.charge_point_code` — UNIQUE (`aegiElectricChargingPoint.idG`)
- `tariffs.tariff_code` — UNIQUE (`energyRate.idG`)
- Alle FK-Cascades: `ON DELETE CASCADE` auf `charge_points`, `tariffs`, `connectors`
- Advisory Locks: `pg_try_advisory_xact_lock(hash(feedId))` — auto-release bei COMMIT/ROLLBACK
- Migrationen 003 existieren als zwei Files (`003_sync_run_claims.sql`, `003_tariff_instances_*.sql`) — alphabetische Reihenfolge ist beabsichtigt; nicht umbenennen ohne DB-Audit.

---

## Debugging-Checkliste

**„Stationen erscheinen nicht im Frontend"**
1. Feed sync status prüfen: `SELECT status, message, delta_count FROM sync_runs WHERE feed_id='...' ORDER BY started_at DESC LIMIT 5`
2. `delta_count = 0`? → Parser produziert leeren Katalog → `locationReference` prüfen
3. `delta_count > 0` aber keine Marker? → `is_active`, `ingest_catalog` prüfen; CPO in `cpos`-Tabelle?
4. Korrekte Anzahl Stationen? → `SELECT count(*) FROM stations WHERE cpo_id='EBW'`

**„Ladepunkt-Anzahl / Leistung falsch"**
1. Parser-Test mit echter Payload (`npx tsx /tmp/test.mts`) — produziert er richtige Werte?
2. DB-Abfrage: `SELECT station_code, charge_point_count, max_power_kw FROM stations WHERE address_line ILIKE '%...'`
3. Wenn Parser ok, DB falsch → Feed nicht mit neuem Code synchronisiert
4. Wenn DB ok, Frontend falsch → Browser-Cache leeren oder Next.js-Cache prüfen

**„Feed wird bereits verarbeitet (Lock belegt)"**
→ Normal bei überlappenden Syncs. Wenn dauerhaft: Admin-Console → „Beenden erzwingen", dann warten bis Lock-Transaktion committed/rollbacked (Advisory Lock auto-release).

**„Admin-Login funktioniert nicht"**
1. `NEXT_PUBLIC_SUPABASE_URL` + `NEXT_PUBLIC_SUPABASE_ANON_KEY` gesetzt?
2. `ADMIN_EMAILS` enthält die User-Email (lowercased)?
3. User in Supabase angelegt und bestätigt?
4. Browser-Cookies löschen → erneut versuchen.

**„Webhook 401/503 nach Deploy"**
- 503: `MOBILITHEK_FORWARD_SECRET` ist nicht gesetzt — endpoint blockiert. Setzen + redeploy.
- 401: Forward-Secret stimmt nicht zwischen Edge-Function/Cloudflare-Worker und App überein.
