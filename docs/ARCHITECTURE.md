# Architektur

> Stand: 2026-05-05. Lebendes Dokument — bei größeren Änderungen aktualisieren.

Dieses Dokument beschreibt **wie** der Code organisiert ist und **wie** Daten durch das System fließen. Für **was** und **warum** auf Roadmap/Skalierungs-Ebene → [`SCALING_ARCHITECTURE.md`](./SCALING_ARCHITECTURE.md). Für Feed-Onboarding und -Betrieb → [`FEEDS.md`](./FEEDS.md).

---

## 1. Monorepo-Layout

```
adhoc-plattform/
├─ apps/
│  ├─ web/                  Next.js 16 App: Public-Frontend + APIs + Admin-UI
│  │  ├─ app/               Next App Router (Pages + API-Routes)
│  │  ├─ components/        React-Komponenten (Map, Filter, Results, UI)
│  │  ├─ lib/
│  │  │  ├─ client/         Browser-seitige API-Wrapper (fetch-Helpers)
│  │  │  ├─ server/         Server-only: Admin-Daten, Public-API, Cache
│  │  │  └─ supabase/       Auth (Server/Browser/Middleware/Guard)
│  │  ├─ middleware.ts      Schützt /admin und /api/admin/* (Supabase-Session)
│  │  └─ netlify/
│  │     ├─ edge-functions/ Webhook-Vorverarbeitung (gzip-Decode)
│  │     └─ functions/      Scheduled Sync + Legacy-Webhook-Fallback
│  ├─ ingest/               Lokaler/Cron-Worker (CLI: `pnpm ingest:sync`)
│  └─ mobilithek-gateway/   Cloudflare Worker: /map-stations-Cache + Push-Webhook-Forwarder
│
├─ packages/
│  └─ shared/               Domain-Logik (vom Browser nicht importierbar)
│     └─ src/
│        ├─ db/             Postgres-Pool + Public/Admin-Queries
│        ├─ domain/         Zod-Typen, Route-Planner, Kandidaten-Logik
│        ├─ geo/            Geocoder, Haversine, Routenkorridore
│        ├─ ingest/         Feed-Orchestrierung, Sync-Loops, Queue
│        ├─ mobilithek/     mTLS-Client + DATEX-II/AFIR-Parser
│        └─ store/          (DEPRECATED – Demo-Store, weicht DB-Pfad)
│
├─ db/
│  ├─ schema.sql            Vollständiges Schema (für lokale Bootstraps)
│  ├─ migrations/           Versionierte SQL-Migrationen (001..009)
│  └─ fixtures/             JSON-Sample-Payloads für Tests
│
├─ docs/                    Diese Doku-Sammlung
└─ certs/                   mTLS-Zertifikate (gitignored, lokal befüllt)
```

### Hard rules

- `apps/web` darf nur über `@adhoc/shared` auf Domain-Logik zugreifen — **niemals** direkt aus Komponenten oder Routen die DB ansteuern, ausser via `lib/server/*`.
- `packages/shared` ist server-only. Kein React, kein DOM, kein Next-Import.
- `apps/ingest` ist ein dünner Wrapper um `@adhoc/shared/ingest` (Cron-Entry).
- Keine Logik-Duplikation zwischen `apps/web/api/...` und `packages/shared/ingest`.

---

## 2. Komponenten und Verantwortlichkeiten

### 2.1 `apps/web` (Next.js 16)

**Public Routes (App Router):**

| Route | Zweck |
|---|---|
| `/` | Public Route-Planner UI |
| `/admin` | Admin-Konsole (Auth-geschützt) |
| `/login` | Admin-Login (Supabase Email/Password) |

**Public APIs (`/api/public/...`):**

| Endpoint | Zweck |
|---|---|
| `GET /api/public/cpos` | Liste der bekannten CPOs |
| `GET /api/public/stations/[id]` | Station-Detail |
| `GET /api/public/stations/map` | Stationen für Map-Bounds |
| `GET /api/public/stations/stats` | Aggregierte Stats |
| `GET /api/public/stations/tiles/[z]/[x]/[y]` | MVT-/JSON-Vector-Tiles |
| `POST /api/public/routes/plan` | Routenberechnung (Valhalla/OSRM) |
| `POST /api/public/routes/candidates` | Stationen entlang Route |
| `GET /api/public/locations/{ip,reverse,suggest,focus}` | Geo-Helper |

**Admin APIs (`/api/admin/...`, alle Auth-geschützt):**

| Endpoint | Methoden | Zweck |
|---|---|---|
| `/api/admin/feeds` | GET, POST | Feed-Konfigurationen listen/anlegen |
| `/api/admin/feeds/[id]` | PATCH, DELETE | Feed bearbeiten/löschen |
| `/api/admin/feeds/[id]/sync` | POST | Sync auslösen |
| `/api/admin/feeds/[id]/test` | POST | Test-Lauf (kein Persistieren) |
| `/api/admin/feeds/[id]/terminate` | POST | Hängenden Lauf beenden |
| `/api/admin/stations` | GET | Admin-Stationssuche |
| `/api/admin/stations/[id]/override` | PATCH, DELETE | Station overriden/verstecken |
| `/api/admin/sync-runs` | GET, DELETE | Run-History / stuck-Cleanup |

**Internal APIs (nur per Shared-Secret aufrufbar):**

| Endpoint | Zweck |
|---|---|
| `POST /api/internal/mobilithek/webhook` | Empfänger der Edge-Function-Forwards (siehe 3.2) |
| `POST /api/internal/ingest-sync` | Trigger für Netlify Scheduled Function |

**Auth-Subsystem (`apps/web/lib/supabase/`):**

| Datei | Zweck |
|---|---|
| `server.ts` | `createSupabaseServerClient()` für Server-Components/Routes |
| `browser.ts` | `createSupabaseBrowserClient()` für Login-Form |
| `middleware.ts` | Session-Refresh + Route-Protection |
| `require-admin.ts` | Defense-in-Depth-Guard in jeder Admin-API-Route |
| `admin-emails.ts` | Allowlist-Logik (`ADMIN_EMAILS` env-Var) |

### 2.2 `packages/shared` (Domain-Layer)

| Modul | Verantwortung |
|---|---|
| `db/pool.ts` | Singleton `pg.Pool` mit Tuning (timeouts, FKs) |
| `db/public.ts` | Read-only Queries für Public-Routes (Stationen, Tarife, Routenkandidaten) |
| `db/admin.ts` | Read/Write-Queries für Admin-APIs (Feeds, Sync-Runs, Overrides) |
| `db/source.ts` | `usingDatabase()` — schaltet zwischen DB- und Fixture-Modus |
| `domain/types.ts` | Zod-Schemas + Domain-TS-Typen (Single Source of Truth) |
| `domain/route-planner.ts` | Routenberechnung (Valhalla/OSRM Adapter) |
| `domain/candidates.ts` | Stationskandidaten entlang Route (Korridor + SoC/Reichweite) |
| `geo/*` | OSM-Geocoding, Haversine, Korridor-Geometrie |
| `mobilithek/parser.ts` | DATEX-II / AFIR-Parser → `ParsedStaticFeed`/`ParsedChargePoint` |
| `mobilithek/client.ts` | Axios-Client mit mTLS, Pull-Download, Webhook-Decode |
| `ingest/index.ts` | Sync-Loop, Feed-Orchestrierung, Queue, Webhook-Verarbeitung |

### 2.3 `apps/ingest` (Worker-CLI)

- Einziger Code: `src/index.ts` (Cron-Entry) + `src/bootstrap-tesla.ts` (einmaliges Feed-Seeding).
- Verwendet `@adhoc/shared/ingest` für die gesamte Logik.
- Wird als Railway-Cron oder lokal per `pnpm ingest:sync` aufgerufen.

### 2.4 `apps/mobilithek-gateway` (Cloudflare Worker)

Hat zwei produktive Funktionen:

- **`GET /map-stations`** — primärer öffentlicher Map-Endpoint. Cached `s-maxage=60` mit `stale-while-revalidate=120` und ruft Netlify (`MAP_STATIONS_UPSTREAM_URL`) nur bei Cache-Miss. Reduziert Netlify-Function-Verbrauch auf einen Bruchteil und liefert Edge-nahe Latenz. Browser-Frontend zeigt direkt auf den Worker.
- **`POST /webhook/<feedId>` (oder `?subscriptionId=…`)** — Push-Webhook-Forwarder: dekodiert gzip, leitet sauberes JSON an `/api/internal/mobilithek/webhook` weiter, setzt `x-mobilithek-forward-secret`. Wird **aktuell nicht aktiv aufgerufen**, weil alle Feeds Pull-Mode haben — steht für künftige Push/Hybrid-Feeds bereit.

Konfiguration im Worker (via `wrangler secret put` / `vars` in `wrangler.toml`):

| Variable | Zweck |
|---|---|
| `UPSTREAM_WEBHOOK_URL` | Ziel des Webhook-Forwards (`https://adhoc-plattform.netlify.app/api/internal/mobilithek/webhook`) |
| `MAP_STATIONS_UPSTREAM_URL` | Ziel des Map-Stations-Cache-Misses (Netlify-Endpoint) |
| `MOBILITHEK_FORWARD_SECRET` | Muss identisch mit dem App-Wert sein, sobald Push-Feeds aktiv werden |

---

## 3. Datenflüsse

### 3.1 Public-Read-Pfad (Browser → Karte)

**Map-Stations (primär, Cloudflare-cached):**

```
Browser
  └─→ GET https://adhoc-mobilithek-gateway.sas-wilms.workers.dev/map-stations
        └─ Cloudflare Cache (s-maxage=60, stale-while-revalidate=120)
            ├─ Hit  → direkt Edge-Antwort
            └─ Miss → POST MAP_STATIONS_UPSTREAM_URL (Netlify)
                       └─→ packages/shared/src/db/public.ts
                             └─→ Postgres (PostGIS)
```

Damit landen die meisten Kartenanfragen im Cloudflare-Cache, Netlify wird nur bei Cache-Miss bzw. Revalidate angefasst — entscheidender Token/Compute-Spar-Win.

**Tiles (direkt gegen App):**

```
Browser
  └─→ GET /api/public/stations/tiles/{z}/{x}/{y}    [apps/web/app/api/...]
        └─→ packages/shared/src/db/public.ts        [parameterisiertes SQL]
              └─→ Postgres (PostGIS, materialisierte Tile-Tabelle)
        ←─ JSON-Tile (fast immer aus Cache)
```

Anti-Patterns vermeiden: Tile-Endpoint **muss** mit DB-Concurrency-Limit (`MAP_TILE_DB_CONCURRENCY`) und Slot-Wait-Timeout arbeiten — sonst Pool-Starvation auf Nano-Tier-Supabase.

### 3.2 Mobilithek-Webhook-Pfad (Push) — *aktuell inaktiv*

> Stand 2026-05-05: Alle Feeds laufen im Pull-Mode. Dieser Pfad ist nur dann aktiv, wenn ein Feed in `/admin` auf `mode: "push"` oder `"hybrid"` gesetzt wird.

```
Mobilithek-Server
  └─→ POST  https://adhoc-mobilithek-gateway.sas-wilms.workers.dev/webhook/<feedId>
        └─→ Cloudflare Worker `apps/mobilithek-gateway`           ← gzip-Decode + JSON-Normalize
              └─→ POST https://<netlify>/api/internal/mobilithek/webhook
                    └─ x-mobilithek-forward-secret               ← timing-safe Vergleich
                          └─→ packages/shared/src/ingest::processFeedWebhook
                                ├─ webhookSecretRef-Check (timing-safe)
                                └─→ enqueue → runFeedAction("webhook", payload)
```

(In `netlify.toml` ist außerdem eine Netlify Edge Function als alternativer Eingang konfiguriert, wird aber aktuell nicht angesprochen, weil Mobilithek auf den Cloudflare-Worker zeigt.)

Wichtig:
- `MOBILITHEK_FORWARD_SECRET` ist **pflicht** auf der App-Seite — der interne Endpoint failed-closed, wenn die env-Var nicht gesetzt ist.
- Sobald der erste Push-Feed aktiviert wird: Worker-Wert per `wrangler secret put MOBILITHEK_FORWARD_SECRET` mit dem App-Wert synchronisieren.
- Pro-Feed-Secret aus `webhookSecretRef` wird zusätzlich timing-safe verglichen.

### 3.3 Sync-Pfad (Pull / Cron)

```
Netlify Cron (jede Minute)
  └─→ POST /api/internal/ingest-sync   (kein Body)
        └─→ packages/shared/src/ingest::runDueFeedCycle
              ├─ Postgres advisory-lock pro feedId
              ├─ Pull Mobilithek (mTLS via Axios)
              ├─ Parser → CatalogDelta
              └─ Upsert in stations/charge_points/tariffs (CASCADE FKs)
```

Lokaler Trigger: Admin-UI → "Sync"-Button → `POST /api/admin/feeds/[id]/sync` → gleicher Code-Pfad.

### 3.4 Admin-Auth-Pfad

```
Browser  →  /admin                                 [Next App Router]
              └─ middleware.ts (apps/web/middleware.ts)
                  └─ updateAdminSession() prüft Supabase-Session-Cookie
                      ├─ kein User                → Redirect /login?next=/admin
                      ├─ User, aber email nicht in ADMIN_EMAILS → /login
                      └─ ok                        → Page-Render

Browser  →  POST /api/admin/feeds                  [API-Route]
              └─ middleware (gleicher Check)
              └─ DEFENSE-IN-DEPTH: requireAdmin() in der Route selbst
                  └─ falls Middleware umgangen → 401/403
```

---

## 4. DB-Schema (Kernpunkte)

Vollständig: [`db/schema.sql`](../db/schema.sql). Migrationen versioniert in [`db/migrations/`](../db/migrations/).

| Tabelle | Zweck | Wichtige Constraints |
|---|---|---|
| `cpos` | Charge Point Operators | id (PK, kurzcode wie `EBW`) |
| `feed_configs` | Mobilithek-Subscriptions pro CPO | UNIQUE(source, subscriptionId) |
| `stations` | Aggregierte Standorte | UNIQUE(station_code) — von Parser gesetzt |
| `charge_points` | Einzelne Ladesäulen | UNIQUE(charge_point_code), FK→stations CASCADE |
| `connectors` | Stecker je Ladepunkt | FK→charge_points CASCADE |
| `tariffs` / `tariff_instances` | Preisobjekte | UNIQUE(tariff_code), FK→stations CASCADE |
| `sync_runs` | Sync-Historie pro Feed | claimed_at, claim_owner, progress |
| `sync_queue` | Durable Job-Queue | ON CONFLICT skip, advisory-lock |
| `webhook_deliveries` | Audit der eingegangenen Push-Payloads | FK→feed_configs |
| `raw_feed_payloads` | Komprimierte Roh-Payloads (Retention `RAW_FEED_PAYLOAD_RETENTION_DAYS`) | gzip-blob |
| `app_secrets` | DB-gespeicherte Secrets als Alternative zu env-Var | KMS-relevant in Zukunft |
| `station_overrides` | Admin-Korrekturen (Adresse, Hidden, Notes) | FK→stations |

Migrationen:
- `001`–`002`: Kern-Schema + Hardening
- `003*`: zwei Files mit gleichem Prefix (Sync-Run-Claims + Tariff-Instances) — historisch parallel gemerged, alphabetisch geordnet (`sync_run_claims` < `tariff_instances`). **Nicht umbenennen ohne DB-Migration-Audit.**
- `004`–`009`: Queue, Progress, Retention, FK-Indexe (Performance)

---

## 5. Wichtige Invarianten

1. **Server-only-Daten landen nie im Browser.** Alle DB-Calls nur via `lib/server/*` oder `@adhoc/shared`.
2. **Admin-Routes haben zwei Schutzschichten.** Middleware *und* `requireAdmin()` in der Route. Eine reicht nicht.
3. **`urlOverride` in Feeds ist allowlist-geprüft.** Nur HTTPS auf erlaubte Mobilithek-Hosts (`m2m.mobilithek.info`).
4. **Webhook-Secrets werden timing-safe verglichen** (`crypto.timingSafeEqual`). Niemals `===`/`!==` für Secret-Vergleiche.
5. **`MOBILITHEK_FORWARD_SECRET` ist pflicht.** Ohne diesen ist der interne Webhook-Endpoint geschlossen (503).
6. **Public-DB-Queries dürfen Admin-Daten nicht leaken.** Felder wie `lastErrorMessage`, `cursorState` gehören in den Admin-Layer.
7. **CPO-IDs sind aus dem Mobilithek-Payload exakt zu übernehmen** (`EBW`, nicht `enbw`). Parser setzt sie, Admin muss sie matchen.

---

## 6. Wichtige Dateien (Hot Spots)

| Bereich | Datei |
|---|---|
| DATEX-II/AFIR-Parser | [`packages/shared/src/mobilithek/parser.ts`](../packages/shared/src/mobilithek/parser.ts) |
| Sync-Orchestrierung | [`packages/shared/src/ingest/index.ts`](../packages/shared/src/ingest/index.ts) |
| Domain-Typen (Zod) | [`packages/shared/src/domain/types.ts`](../packages/shared/src/domain/types.ts) |
| Public-DB-Queries | [`packages/shared/src/db/public.ts`](../packages/shared/src/db/public.ts) |
| Admin-DB-Queries | [`packages/shared/src/db/admin.ts`](../packages/shared/src/db/admin.ts) |
| Admin-Auth-Middleware | [`apps/web/lib/supabase/middleware.ts`](../apps/web/lib/supabase/middleware.ts) |
| Admin-API-Guard | [`apps/web/lib/supabase/require-admin.ts`](../apps/web/lib/supabase/require-admin.ts) |
| Edge Webhook | [`apps/web/netlify/edge-functions/mobilithek-webhook.ts`](../apps/web/netlify/edge-functions/mobilithek-webhook.ts) |
| Cron Sync | [`apps/web/netlify/functions/ingest-sync.mts`](../apps/web/netlify/functions/ingest-sync.mts) |
