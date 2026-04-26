# Ad-Hoc Ladepreise Deutschland

Route-first Monorepo mit:

- `apps/web`: Next.js 16 Public Site, Public APIs und Admin-Backend
- `apps/ingest`: Worker-/Ingest-Entry für Mobilithek-Fixtures und spätere Reconciliation-Jobs
- `packages/shared`: gemeinsame Domainlogik, Demo-Daten, Parser und Store

## Start

```bash
pnpm install
pnpm dev
```

Die Website läuft dann unter `http://localhost:3000`.

## Routing und Geocoding

Die Public Route-Ansicht nutzt echte OSM-basierte Provider:

- `VALHALLA_URL`: optionaler eigener Valhalla-Server. Wird bevorzugt und ist fuer echte `truck`-Routen erforderlich.
- `OSRM_URL`: optionaler OSRM-Endpunkt fuer `auto`. Default: `https://router.project-osrm.org`
- `NOMINATIM_URL`: optionaler Geocoding-Endpunkt. Default: `https://nominatim.openstreetmap.org`
- `OSM_GEOCODER_USER_AGENT`: eigener User-Agent fuer Nominatim/OSM-Geocoding. Fuer Produktion setzen.

Ohne `VALHALLA_URL` werden PKW-Routen ueber OSRM berechnet. LKW-Routing liefert dann bewusst einen klaren Fehler statt einer synthetischen Demo-Route.

## Wichtige Routen

- `/` Public route-first UI
- `/admin` Feed- und Sync-Konsole
- `/api/public/routes/plan`
- `/api/public/routes/candidates`
- `/api/public/stations/:id`

## Checks

```bash
pnpm test
pnpm build
pnpm ingest:sync
```

## Fixtures

Die offiziellen Mobilithek-Beispielpayloads liegen unter `db/fixtures/`.

## Livebetrieb

### 1. Datenbank migrieren

Fuehre fuer Supabase/Postgres das Schema aus:

```bash
psql "$DATABASE_URL" -f db/migrations/001_supabase_mobilithek_ingestion.sql
```

Voraussetzungen:

- `postgis` muss verfuegbar sein
- `pgcrypto` muss verfuegbar sein

### 2. Pflicht-Umgebungsvariablen

Mindestens setzen:

```bash
APP_DATA_SOURCE=db
DATABASE_URL=postgresql://...
MOBILITHEK_USER_AGENT=AdhocPlattform/1.0
```

Optional:

```bash
SUPABASE_DB_URL=postgresql://...
MOBILITHEK_BASE_URL=https://m2m.mobilithek.info
MOBILITHEK_USE_FIXTURES=0
VALHALLA_URL=https://...
OSRM_URL=https://router.project-osrm.org
NOMINATIM_URL=https://nominatim.openstreetmap.org
OSM_GEOCODER_USER_AGENT=...
```

### 3. Mobilithek-Credentials pro Feed-Ref

Wenn ein Feed im Admin z. B. `credentialRef=ENBW` hat, erwartet die App:

```bash
ENBW_CLIENT_CERT="-----BEGIN CERTIFICATE-----..."
ENBW_CLIENT_KEY="-----BEGIN PRIVATE KEY-----..."
```

oder alternativ:

```bash
ENBW_CERT_P12_BASE64=...
ENBW_CERT_PASSWORD=...
```

Fuer Webhook-Feeds mit `webhookSecretRef=ENBW`:

```bash
ENBW_WEBHOOK_SECRET=...
```

Globaler Fallback ohne Ref:

```bash
MOBILITHEK_CLIENT_CERT=...
MOBILITHEK_CLIENT_KEY=...
MOBILITHEK_CERT_P12_BASE64=...
MOBILITHEK_CERT_PASSWORD=...
MOBILITHEK_WEBHOOK_SECRET=...
```

#### Tesla-Credentials

Die Tesla-Feeds verwenden `credentialRef=TESLA`. Entsprechend:

```bash
TESLA_CLIENT_CERT="-----BEGIN CERTIFICATE-----..."
TESLA_CLIENT_KEY="-----BEGIN PRIVATE KEY-----..."
```

oder alternativ als P12:

```bash
TESLA_CERT_P12_BASE64=...
TESLA_CERT_PASSWORD=...
```

Das Zertifikat ist das Mobilithek-Teilnehmerzertifikat, das beim Registrierungsprozess
fuer die Tesla-Subscription ausgestellt wurde. Kein separates Tesla-spezifisches Zertifikat.

### 4. Deployment

Es werden zwei laufende Komponenten benoetigt:

- `apps/web`: Next.js App fuer Public-APIs und Admin
- `apps/ingest`: Scheduler-Worker

Builds:

```bash
pnpm --filter web build
pnpm --filter ingest build
```

#### Railway-Deployment

Empfohlene Konfiguration auf Railway:

**Service 1 — `web`**

```
Root Directory: apps/web
Build Command:  cd ../.. && pnpm install --frozen-lockfile && pnpm --filter web build
Start Command:  node .next/standalone/server.js
```

Pflicht-Env-Vars (im Railway-Service setzen):

```
APP_DATA_SOURCE=db
DATABASE_URL=${{Postgres.DATABASE_URL}}
NODE_ENV=production
MOBILITHEK_USER_AGENT=AdhocPlattform/1.0
TESLA_CLIENT_CERT=...
TESLA_CLIENT_KEY=...
OSM_GEOCODER_USER_AGENT=AdhocPlattform/1.0 kontakt@example.de
```

**Service 2 — `ingest` (Cron-Service)**

```
Root Directory: apps/ingest
Build Command:  cd ../.. && pnpm install --frozen-lockfile && pnpm --filter ingest build
Start Command:  node dist/index.js sync
Cron Schedule:  * * * * *   (jede Minute)
```

Gleicher Env-Satz wie `web`.

**Einmalig nach erstem Deployment:**

```bash
# Tesla-Feeds in der DB anlegen (aus Railway-Shell oder lokal mit RAILWAY_DATABASE_URL):
APP_DATA_SOURCE=db DATABASE_URL=... pnpm --filter ingest bootstrap:tesla
```

### 5. Scheduler aktivieren

Der Worker muss mindestens jede Minute laufen:

```bash
pnpm --filter ingest sync
```

Empfehlung:

- Hosting-Cronjob jede Minute
- gleicher Env-Satz wie bei `apps/web`

### 6. Feeds im Admin anlegen

Unter `/admin` pro Mobilithek-Feed setzen:

- `cpoId`
- `type`: `static` oder `dynamic`
- `mode`: `pull`, `push` oder `hybrid`
- `subscriptionId`
- `credentialRef`
- optional `webhookSecretRef`
- `pollIntervalMinutes` bzw. `reconciliationIntervalMinutes`
- `ingestCatalog`
- `ingestPrices`
- `ingestStatus`

Empfohlene Defaults:

- Static-Feed:
  - `ingestCatalog=true`
  - `ingestPrices=true`
  - `ingestStatus=false`
- Dynamic-Feed Phase 1:
  - `ingestCatalog=false`
  - `ingestPrices=true`
  - `ingestStatus=false`
- Dynamic-Feed Phase 2:
  - `ingestCatalog=false`
  - `ingestPrices=true`
  - `ingestStatus=true`

Tesla kann alternativ direkt in der DB vorbefuellt werden:

```bash
APP_DATA_SOURCE=db DATABASE_URL=postgresql://... pnpm --filter ingest bootstrap:tesla
```

### 7. Initialer Go-Live-Ablauf

1. Web und Worker mit `APP_DATA_SOURCE=db` deployen
2. Statische Feeds im Admin anlegen
3. Pro Static-Feed einmal `Sync` ausfuehren
4. Pruefen, dass Stationen, Charge Points und Tarife in der DB liegen
5. Dynamic-Feeds anlegen
6. Pull-/Hybrid-Dynamic-Feeds einmal `Testen`, dann `Sync`; Push-only-Feeds erst per Mobilithek-Test-Push prüfen
7. Erst danach Public-Traffic auf DB-Modus verwenden

### 8. Webhooks anschliessen

Webhook-Ziel fuer neue Feeds (bevorzugt):

```text
https://<LIVE_DOMAIN>/api/admin/mobilithek/webhook/<feedId>
```

Alternativ fuer bestehende Mobilithek-Abos mit `subscriptionId`:

```text
https://<LIVE_DOMAIN>/api/mobilithek/webhook?subscriptionId=<SUBSCRIPTION_ID>
```

Header fuer geschuetzte Webhooks:

```text
x-webhook-secret: <SECRET>
```

#### Tesla Dynamic Webhook — Mobilithek-Subscription aktualisieren

Die Tesla-Dynamic-Subscription (ID `967817509746913280`) hatte bisher eine alte
Netlify-URL als Webhook-Ziel. Diese muss im Mobilithek-Portal auf die neue URL
umgestellt werden:

```text
https://<LIVE_DOMAIN>/api/mobilithek/webhook?subscriptionId=967817509746913280
```

Schritte im Mobilithek-Portal (`https://mobilithek.info`):

1. Einloggen → "Meine Subscriptions"
2. Tesla Dynamic AFIR (ID `967817509746913280`) oeffnen
3. Webhook-URL auf die neue Domain setzen
4. Speichern

Danach einen Test-Push aus dem Mobilithek-Portal ausloesen und im `/admin`
unter "Sync Runs" pruefen, ob ein `webhook`-Run erscheint.

### 9. Health-Checks vor Go-Live

Manuell pruefen:

- `/admin` zeigt Datenquelle `Supabase / Postgres`
- Feed-Tests laufen ohne Fehler
- Feed-Sync erzeugt `sync_runs`
- `/api/public/cpos` liefert echte DB-Daten
- `/api/public/stations/:id` liefert echte DB-Daten
- `/api/public/routes/candidates` nutzt DB-Stationsdaten
- Scheduler schreibt neue Runs
- Webhook aktualisiert bei `ingestStatus=true` die Statusdaten

### 10. Betriebsregeln

- Die App läuft ausschließlich mit `APP_DATA_SOURCE=db` plus `DATABASE_URL` oder `SUPABASE_DB_URL`.
- Ohne erfolgreichen initialen Static-Sync sind Public-Daten unvollstaendig
- Ohne Scheduler gibt es keine automatische Aktualisierung
- Ohne Credentials kann nur mit `MOBILITHEK_USE_FIXTURES=1` getestet werden
