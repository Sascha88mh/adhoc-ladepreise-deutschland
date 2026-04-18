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
pnpm ingest:demo
```

## Fixtures

Die offiziellen Mobilithek-Beispielpayloads liegen unter `db/fixtures/`.
