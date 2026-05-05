# Adhoc Plattform — Ad-Hoc Ladepreise Deutschland

Route-first-Plattform für Ad-Hoc-Ladepreise an deutschen Schnellladestationen. Quelldaten kommen aus Mobilithek-Feeds (DATEX-II / AFIR), werden zu Stationen, Ladepunkten und Tarifen normalisiert und über eine Public-API für Routen-, Karten- und Detailansichten ausgespielt.

## Quick Start

```bash
pnpm install
cp apps/web/.env.example apps/web/.env.local   # Werte ausfüllen
pnpm dev
```

→ http://localhost:3000

## Monorepo-Layout

```
apps/web/                Next.js 16 App: Public-Frontend, APIs, Admin-UI
apps/ingest/             CLI-Worker für Mobilithek-Sync
apps/mobilithek-gateway/ Cloudflare Worker (Webhook-Reserve)
packages/shared/         Domain-Logik (Parser, DB, Geo, Ingest)
db/                      Schema + Migrationen + Test-Fixtures
docs/                    Architektur, Security, Deployment, Feeds
```

## Dokumentation

| Dokument | Inhalt |
|---|---|
| [`docs/ARCHITECTURE.md`](./docs/ARCHITECTURE.md) | Monorepo-Aufbau, Komponenten, Datenflüsse, DB-Schema |
| [`docs/SECURITY.md`](./docs/SECURITY.md) | Auth, Webhook-Härtung, Secrets, Threat Model |
| [`docs/DEPLOYMENT.md`](./docs/DEPLOYMENT.md) | Netlify/Railway-Setup, env-Vars, Cron, Cloudflare |
| [`docs/FEEDS.md`](./docs/FEEDS.md) | Feed-Onboarding, Betrieb, Troubleshooting (Single Source of Truth) |
| [`docs/SCALING_ARCHITECTURE.md`](./docs/SCALING_ARCHITECTURE.md) | Roadmap: Edge-Skalierung für hohe Kartenlast |
| [`CLAUDE.md`](./CLAUDE.md) | Operativer Quick-Reference für Claude-Sessions |

## Häufige Befehle

```bash
pnpm dev                              # Next-Dev (apps/web)
pnpm build                            # Build aller Pakete
pnpm test                             # Tests aller Pakete
pnpm ingest:sync                      # Manueller Mobilithek-Sync
pnpm --filter ingest bootstrap:tesla  # Tesla-Feeds in DB einseeden

cd apps/web && npx tsc --noEmit       # Typecheck Web
cd packages/shared && npx tsc --noEmit
```

## Wichtige Routen

| URL | Zweck |
|---|---|
| `/` | Public Route-Planner |
| `/admin` | Admin-Konsole (Auth-geschützt) |
| `/login` | Admin-Login |
| `/api/public/stations/tiles/{z}/{x}/{y}` | Map-Tiles |
| `/api/public/routes/plan` | Routenberechnung |
| `/api/public/routes/candidates` | Stationen entlang Route |

## Beitragen

- Bei jedem PR die SECURITY-Checkliste durchgehen ([`docs/SECURITY.md`](./docs/SECURITY.md#6-hardening-checks-cipr-review)).
- Domain-Code in `packages/shared`, kein DB-Zugriff aus React-Komponenten.
- Beim Anlegen einer Admin-API-Route: `requireAdmin()` als erstes Statement.

## Lizenz

Private. Keine Verbreitung außerhalb des Projekt-Teams.
