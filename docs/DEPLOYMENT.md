# Deployment

> Stand: 2026-05-05.

Dieses Dokument beschreibt, wie die Adhoc Plattform produktiv deployed wird. Für Architektur → [`ARCHITECTURE.md`](./ARCHITECTURE.md), für Security-Pflichten → [`SECURITY.md`](./SECURITY.md), für Feed-Onboarding → [`FEEDS.md`](./FEEDS.md).

---

## 1. Komponenten-Übersicht

| Komponente | Hosting | Zweck |
|---|---|---|
| `apps/web` | **Netlify** (primär) oder **Railway** | Public-Site + APIs + Admin-UI |
| `apps/web/netlify/edge-functions/mobilithek-webhook.ts` | Netlify Edge | Empfängt Mobilithek-Pushes, gzip-Decode, Forward |
| `apps/web/netlify/functions/ingest-sync.mts` | Netlify Scheduled (jede Minute) | Pull-Cron für Mobilithek-Feeds |
| `apps/web/netlify/functions/ingest-sync-background.mts` | Netlify Background | Lange laufender Sync (Backfill) |
| `apps/web/netlify/functions/mobilithek-webhook.mts` | Netlify Function | Legacy-Webhook-Fallback |
| `apps/ingest` | Railway-Cron oder lokal | Alternative Cron-Quelle (statt Netlify) |
| `apps/mobilithek-gateway` | Cloudflare Worker | Primärer `/map-stations`-Cache + Push-Webhook-Forwarder |
| Postgres + PostGIS | Supabase | Master-DB |
| Auth | Supabase Auth | Admin-Login |

---

## 2. Postgres / Supabase

### 2.1 Bootstrapping

```bash
psql "$DATABASE_URL" -f db/schema.sql
```

oder migrationsweise:

```bash
for f in db/migrations/*.sql; do psql "$DATABASE_URL" -f "$f"; done
```

Voraussetzungen:
- `postgis` Extension verfügbar
- `pgcrypto` Extension verfügbar

### 2.2 Connection-Tuning (`DATABASE_URL`)

- Supabase Pooler-URL (`*.pooler.supabase.com:6543`) verwenden, nicht den Direct-Connect-Port 5432.
- `?sslmode=require` ist Pflicht.
- `PG_POOL_MAX=4` auf Nano-Tier — höher = Pool-Starvation in Tile-Endpoints.

---

## 3. Supabase Auth (einmaliges Setup)

1. Im Supabase-Projekt: **Authentication → Providers** → Email aktivieren, "Confirm email" auf Wunsch deaktivieren (nur ein User).
2. **Authentication → Users → Add user** → Email + Password setzen.
3. In Netlify (oder Railway) folgende env-Vars setzen:
   ```
   NEXT_PUBLIC_SUPABASE_URL=https://<project>.supabase.co
   NEXT_PUBLIC_SUPABASE_ANON_KEY=eyJ...
   ADMIN_EMAILS=admin@example.com
   ```
4. Deployen → `/login` aufrufen → einloggen → Redirect auf `/admin`.

Weitere Admins: einfach in Supabase anlegen + Email zu `ADMIN_EMAILS` (Komma-Liste) ergänzen.

---

## 4. Netlify (primärer Deploy-Pfad)

### 4.1 Build-Config (`netlify.toml`)

Bereits committed:

```toml
[build]
  base = "apps/web"
  command = "cd ../.. && pnpm install --frozen-lockfile && pnpm --filter web build"
  publish = ".next"

[functions]
  directory = "netlify/functions"
  node_bundler = "esbuild"

[[edge_functions]]
  path = "/api/admin/mobilithek/webhook/*"
  function = "mobilithek-webhook"

[[edge_functions]]
  path = "/api/mobilithek/webhook"
  function = "mobilithek-webhook"
```

### 4.2 Pflicht-Env-Vars

```
APP_DATA_SOURCE=db
DATABASE_URL=postgres://...

NEXT_PUBLIC_SUPABASE_URL=...
NEXT_PUBLIC_SUPABASE_ANON_KEY=...
ADMIN_EMAILS=admin@example.com

MOBILITHEK_BASE_URL=https://m2m.mobilithek.info
MOBILITHEK_USER_AGENT=AdhocPlattform/1.0
MOBILITHEK_FORWARD_SECRET=<32+ random chars; auch im Cloudflare-Worker spiegeln, sobald Push-Feeds aktiv werden>

OSM_GEOCODER_USER_AGENT=AdhocPlattform/1.0 contact@example.com
```

Optional je nach Feed (siehe [`FEEDS.md`](./FEEDS.md)):

```
TESLA_CLIENT_CERT=...    TESLA_CLIENT_KEY=...
ENBW_CLIENT_CERT=...     ENBW_CLIENT_KEY=...
ENBW_WEBHOOK_SECRET=...
```

Vollständige Liste mit Defaults: [`apps/web/.env.example`](../apps/web/.env.example).

### 4.3 Scheduled Functions

`apps/web/netlify/functions/ingest-sync.mts` läuft jede Minute (in der Datei deklariert). Nach Deploy automatisch aktiv. Lokales Testen via Admin-Console-Sync-Button.

---

## 5. Railway (Alternative für `web` + `ingest`)

Wenn Netlify nicht passt — minimale Konfig:

**Service `web`:**
```
Root Directory: apps/web
Build:  cd ../.. && pnpm install --frozen-lockfile && pnpm --filter web build
Start:  node .next/standalone/server.js
```

**Service `ingest` (Cron):**
```
Root Directory: apps/ingest
Build:  cd ../.. && pnpm install --frozen-lockfile && pnpm --filter ingest build
Start:  node dist/index.js sync
Cron Schedule:  * * * * *
```

Gleicher env-Var-Satz wie Netlify (oben).

Einmalig nach erstem Deployment Tesla-Feeds seeden:

```bash
APP_DATA_SOURCE=db DATABASE_URL=... pnpm --filter ingest bootstrap:tesla
```

---

## 6. Cloudflare Worker (`apps/mobilithek-gateway`)

Der Worker erfüllt zwei Aufgaben:

1. **Cache vor `GET /map-stations`** — primärer Browser-Endpoint für die Karte, reduziert Netlify-Function-Verbrauch drastisch.
2. **Webhook-Forwarder** für Push-Feeds (steht bereit, aktuell ohne aktiven Verkehr, weil alle Feeds Pull-Mode haben).

### 6.1 Erstdeploy / Update

```bash
cd apps/mobilithek-gateway
pnpm install
pnpm typecheck
pnpm deploy
```

### 6.2 Secrets / Variables

In `wrangler.toml` als `[vars]` oder via `wrangler secret put`:

| Name | Wert |
|---|---|
| `UPSTREAM_WEBHOOK_URL` | `https://<netlify-domain>/api/internal/mobilithek/webhook` |
| `MAP_STATIONS_UPSTREAM_URL` | Netlify-Endpoint für Map-Stations (siehe `MAP_STATIONS_UPSTREAM_URL` im App-Code) |
| `MOBILITHEK_FORWARD_SECRET` | **Identischer String wie in Netlify-Env.** Pflicht, sobald der erste Push-Feed aktiviert wird. |

### 6.3 Push-Feed aktivieren (Zukunft)

Sobald in `/admin` ein Feed mit `mode: "push"` oder `"hybrid"` angelegt wird:

1. `MOBILITHEK_FORWARD_SECRET` im Worker per `wrangler secret put` mit Netlify-Wert synchronisieren.
2. Mobilithek-Subscription im Portal auf
   ```
   https://adhoc-mobilithek-gateway.sas-wilms.workers.dev/webhook/<feedId>
   ```
   umstellen.
3. Test-Push aus dem Mobilithek-Portal triggern → in DB `webhook_deliveries` prüfen.

---

## 7. Deploy-Checkliste

Vor jedem Production-Deploy:

- [ ] `pnpm -r build` lokal grün
- [ ] `cd apps/web && npx tsc --noEmit` grün
- [ ] `cd packages/shared && npx tsc --noEmit` grün
- [ ] Wenn env-Vars geändert: in Netlify-UI **und** Cloudflare-Worker synchronisiert
- [ ] Wenn Auth/Middleware geändert: nach Deploy `/admin` ohne Login erreicht 302 → `/login`?
- [ ] Wenn Webhook-Code geändert: Test-Push aus Mobilithek-Portal erzeugt `webhook_deliveries`-Eintrag?

---

## 8. Lokales Setup

```bash
pnpm install
cp apps/web/.env.example apps/web/.env.local
# .env.local mit lokalen Werten füllen (Supabase, DATABASE_URL etc.)
pnpm dev
```

Lokal ohne echtes Mobilithek-Cert: `MOBILITHEK_USE_FIXTURES=1` setzen, dann werden `db/fixtures/*.json` als Payload-Quelle genutzt.

Admin-User für lokale Entwicklung: gleicher Supabase-User wie produktiv (oder eigenes Test-Projekt anlegen).
