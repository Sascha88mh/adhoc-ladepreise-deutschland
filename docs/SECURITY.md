# Security

> Stand: 2026-05-05. Bei Auth-/Webhook-/Secret-Änderungen aktualisieren.

Dieses Dokument beschreibt das Bedrohungsmodell, die getroffenen Schutzmaßnahmen und die operativen Pflichten. Code-Pfade siehe [`ARCHITECTURE.md`](./ARCHITECTURE.md#24-admin-auth-pfad).

---

## 1. Threat Model (Kurzfassung)

| Asset | Risiko | Schutz |
|---|---|---|
| Admin-Bereich (`/admin`, `/api/admin/*`) | Daten-Manipulation, Defacement, Stations-Löschung | Supabase Auth + Middleware + Route-Guard |
| Mobilithek-mTLS-Cert | Diebstahl/Missbrauch via SSRF | `urlOverride`-Allowlist + Cert nur server-seitig geladen |
| Webhook-Endpunkte | Payload-Injection, Spoofing | Timing-safe Secret-Vergleich, Forward-Secret pflicht |
| Public-Daten | Leak interner Felder (z. B. cursorState) | Strikte Trennung `db/public.ts` ↔ `db/admin.ts` |
| `.env*` / Cert-Files | Versehentliches Commiten | `.gitignore` deckt `.env*`, `*.p12`, `*.pem`, `*.key`, `certs/` |

DoS, Rate-Limiting und Supply-Chain-Risiken sind aktuell **out of scope** und werden vorgelagert (Netlify, Cloudflare) gehandhabt.

---

## 2. Authentifizierung & Autorisierung

### 2.1 Mechanismus

- **Supabase Auth** (Email + Password) ist die einzige Quelle der Wahrheit für Admin-Sessions.
- Sessions werden via `@supabase/ssr` als HTTP-only Cookies gehalten und in der Next-Middleware bei jedem Request refreshed.
- **Allowlist via `ADMIN_EMAILS` env-Var** (Komma-Liste): Nur Emails aus dieser Liste haben Admin-Rechte, **selbst wenn** ein Supabase-User existiert. Kein Sign-up offen.

### 2.2 Schichten (Defense in Depth)

```
1. Middleware (apps/web/middleware.ts)
   └─ updateAdminSession() in lib/supabase/middleware.ts
       ├─ matcht /admin, /admin/:path*, /api/admin/:path*, /login
       ├─ blockt API-Routes mit 401-JSON
       └─ redirect Pages auf /login?next=...

2. Route-Guard (apps/web/lib/supabase/require-admin.ts)
   └─ requireAdmin() in jeder Admin-API-Route
       ├─ 503 wenn Supabase-env fehlt
       ├─ 401 wenn keine Session
       └─ 403 wenn Email nicht in ADMIN_EMAILS

3. Server-Component-Guard
   └─ /admin/page.tsx ruft requireAdmin() vor dem Rendern auf
       └─ redirect("/login?next=/admin") bei Fail
```

Wenn die Middleware versehentlich nicht läuft (z. B. fehlerhafte `matcher`-Config), schließt der Route-Guard die Lücke. Wenn der Route-Guard fehlt, blockt die Middleware. Eine der beiden Schichten reicht — beide sind Pflicht.

### 2.3 User-Provisioning

- User wird **manuell im Supabase-Dashboard** angelegt (Auth → Users → Add user → Email + Password).
- `ADMIN_EMAILS=admin@example.com` muss die Email enthalten (lowercased Match, Whitespace-tolerant).
- Bei Bedarf weitere Admins: Komma-Liste, z. B. `ADMIN_EMAILS=alice@x.de,bob@x.de`.
- **Reset/Disable**: User in Supabase löschen oder Email aus `ADMIN_EMAILS` entfernen — beides reicht.

### 2.4 Logout

- Browser: Logout-Button im AdminHeader → `supabase.auth.signOut()` + `POST /api/auth/logout` (server-side cookie-clear) + Redirect.

---

## 3. Webhook-Sicherheit

### 3.1 Schichten

> Hinweis: Aktuell laufen alle Feeds im Pull-Mode — dieser Pfad ist „armed but unused", er greift erst, sobald ein Push-/Hybrid-Feed aktiviert wird.

```
Mobilithek
   └─→ Cloudflare Worker `apps/mobilithek-gateway` (primär)
        └─ setzt Header  x-mobilithek-forward-secret: <FORWARD_SECRET>
              └─→ POST /api/internal/mobilithek/webhook
                   ├─ FAIL CLOSED wenn MOBILITHEK_FORWARD_SECRET unset (503)
                   ├─ timingSafeEqualStrings()-Check
                   └─→ processFeedWebhook(feedId, payload, x-webhook-secret)
                        └─ pro-Feed-Secret-Check (timing-safe) wenn webhookSecretRef gesetzt
```

Der Netlify Edge Function als alternativer Eingang ist in `netlify.toml` konfiguriert, wird aber nicht angesprochen, solange Mobilithek auf den Cloudflare-Worker zeigt.

### 3.2 Pflicht-Konfiguration

- `MOBILITHEK_FORWARD_SECRET` **muss** in der App-Env (Netlify) gesetzt sein — sonst antwortet der interne Endpoint mit `503 "Webhook endpoint not configured"`. Truthy-Bypass wurde entfernt.
- Cloudflare-Worker (`apps/mobilithek-gateway`) braucht denselben Wert (`wrangler secret put MOBILITHEK_FORWARD_SECRET`), **bevor** der erste Push-Feed aktiviert wird. Solange alle Feeds Pull-Mode haben, schadet eine Diskrepanz nicht — wird aber zum Show-Stopper, sobald jemand auf Push umschaltet.
- Pro Feed mit `webhookSecretRef` muss die referenzierte env-Var (z. B. `ENBW_WEBHOOK_SECRET`) gesetzt sein.
- Beide Secrets werden **timing-safe** verglichen (`node:crypto.timingSafeEqual`) — kein Leak via String-Vergleich-Timing.

### 3.3 Public-Webhook-Endpoint

`/api/admin/mobilithek/webhook/[feedId]` (alter Pfad) und `/api/mobilithek/webhook` wurden entfernt — sie wurden in der Praxis von der Edge Function und einem `force=true`-Redirect in `netlify.toml` shadowed und waren tot. Der einzige produktive Eingang ist die **Edge Function**, die intern auf `/api/internal/mobilithek/webhook` weiterleitet.

---

## 4. SSRF-Härtung

`feed_configs.urlOverride` (admin-konfigurierbar) erlaubt es, statt der Default-Mobilithek-URL eine explizite zu nutzen — historisch ohne Validierung.

**Härtung (`apps/web/app/api/admin/feeds/route.ts` + `[id]/route.ts`):**

```ts
const ALLOWED_FEED_HOSTS = new Set(["m2m.mobilithek.info"]);
const urlOverrideSchema = z.string().nullable().refine((value) => {
  if (!value) return true;
  const url = new URL(value);
  return url.protocol === "https:" && ALLOWED_FEED_HOSTS.has(url.hostname);
});
```

**Erweiterung:** Wenn ein zweiter Mobilithek-Host (z. B. Test-Endpoint) unterstützt werden soll, das Set explizit erweitern. Niemals `.includes()`-Substring-Matching benutzen.

---

## 5. Secrets Management

### 5.1 Speicherorte

| Secret | Wo | Format |
|---|---|---|
| Supabase Anon Key | env (`NEXT_PUBLIC_SUPABASE_ANON_KEY`) | Public — Browser darf sehen |
| Supabase URL | env (`NEXT_PUBLIC_SUPABASE_URL`) | Public |
| `DATABASE_URL` | env (Server-only) | Postgres-Connection-String mit Passwort |
| Mobilithek mTLS Cert | `MOBILITHEK_CERT_P12_PATH` → File aus `certs/` | P12 + Passwort |
| Pro-Feed Cert (CPO-ref) | env oder DB-Tabelle `app_secrets` | PEM oder P12-Base64 |
| `MOBILITHEK_FORWARD_SECRET` | env in **Netlify, Cloudflare-Worker, App** | identischer String, mind. 32 Zeichen Random |
| `ADMIN_EMAILS` | env (App) | Komma-Liste |

### 5.2 Regeln

- **Niemals committen.** `.gitignore` deckt `.env*`, `certs/`, `*.p12`, `*.pem`, `*.key`. `.env.example` ist die einzige getrackte env-Datei (nur Keys, keine Werte).
- **Rotation** bei Verdacht auf Leak: User in Supabase rotieren, `MOBILITHEK_FORWARD_SECRET` neu generieren und an allen drei Stellen synchron deployen.
- **Cert-Reset**: P12 lokal neu erzeugen lassen (Mobilithek-Portal), in `certs/` ablegen, redeploy.

---

## 6. Hardening-Checks (CI/PR-Review)

Bei jedem PR diese Checks mental abklopfen:

- [ ] Neue Admin-API-Route? → `requireAdmin()` als erstes Statement.
- [ ] Neuer fetch() mit User-Input im Host? → Allowlist nötig.
- [ ] Neuer Secret-Vergleich? → `timingSafeEqualStrings()` aus shared.
- [ ] Neue env-Var? → in `apps/web/.env.example` dokumentiert.
- [ ] Neue Public-Query? → keine `error_message`/`cursor_state`/`*_admin_*`-Felder selektiert.
- [ ] Neuer Webhook? → Forward-Secret + per-feed-Secret + timing-safe.

---

## 7. Vergangene Findings (Changelog)

| Datum | Finding | Status |
|---|---|---|
| 2026-05-05 | Admin-Bereich komplett ohne Auth | Behoben (Supabase + Middleware + Guard) |
| 2026-05-05 | SSRF via `urlOverride` (mTLS-Cert-Missbrauch) | Behoben (Host-Allowlist) |
| 2026-05-05 | `MOBILITHEK_FORWARD_SECRET` fail-open wenn unset | Behoben (fail-closed 503) |
| 2026-05-05 | Webhook-Secret-Vergleich nicht timing-safe | Behoben (`timingSafeEqualStrings`) |

---

## 8. Incident Response (Quick Reference)

| Symptom | Erste Maßnahme |
|---|---|
| Admin-Login funktioniert nicht | Prüfe `NEXT_PUBLIC_SUPABASE_*` und `ADMIN_EMAILS` env-Vars |
| Webhook 401 nach Deploy | `MOBILITHEK_FORWARD_SECRET` an allen 3 Stellen synchron? |
| Webhook 503 | env-Var fehlt — siehe oben |
| Stationsdaten plötzlich falsch | `sync_runs` für betroffenen Feed prüfen, ggf. `terminate` + neuer Sync |
| Verdacht auf Cert-Leak | Mobilithek-Portal: Cert revoke, neues P12 erzeugen, deployen |
