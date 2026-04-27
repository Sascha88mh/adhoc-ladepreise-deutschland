# Mobilithek-Feeds: Onboarding, Betrieb, Troubleshooting

> Diese Datei ist die **einzige Wahrheit** für das Einrichten, Betreiben und Debuggen von
> Mobilithek-Datenfeeds (AFIR Static/Dynamic). Alle Agents, die Feeds einpflegen oder
> Probleme diagnostizieren, lesen zuerst hier. Codepfade und Tabellen ändern sich — wenn
> etwas nicht zur hier beschriebenen Realität passt, **diesen Text aktualisieren**.

---

## 1. Architektur in 60 Sekunden

```
                 ┌────────────────────────────┐
                 │ Netlify Scheduled Function │  (jede Minute)
                 │ ingest-sync.mts            │
                 └──────────────┬─────────────┘
                                │ runDueFeedCycle()
                                ▼
                   ┌─────────────────────────┐
                   │  feed_configs (DB)      │◄────── Admin-UI (/api/admin/feeds/*)
                   └──────────────┬──────────┘
                                  │ shouldRunFeed()
                                  ▼
                   ┌─────────────────────────┐
                   │  runFeedAction          │
                   │  (pro Feed, begrenzt     │
                   │   parallel, Timeout +    │
                   │   DB-Claim)              │
                   └──┬──────────────────────┘
                      │
        ┌─────────────┼──────────────────────┐
        ▼             ▼                      ▼
   Mobilithek   parse (parser.ts)      DB-Schreibphase
   HTTP-Call    Static → Catalog       stations, charge_points,
   (mTLS)       Dynamic → Updates      tariffs, availability_snapshots,
                                        price_snapshots, raw_feed_payloads
```

Push-Feeds laufen parallel dazu ueber einen separaten Eingang:

```
Mobilithek Push
  POST /api/admin/mobilithek/webhook/:feedId
      │
      ▼
Netlify Edge Function mobilithek-webhook.ts
  liest Raw-Body, entpackt gzip, normalisiert JSON
      │ x-mobilithek-forward-secret
      ▼
Next Route /api/internal/mobilithek/webhook?feedId=...
      │
      ▼
processFeedWebhook() → runFeedAction(feedId, "webhook")
```

Wichtige Module:

| Zweck                        | Datei                                                          |
| ---------------------------- | -------------------------------------------------------------- |
| HTTP-Client + mTLS + Agent   | [packages/shared/src/mobilithek/client.ts](../packages/shared/src/mobilithek/client.ts) |
| DATEX-II/AFIR-Parser         | [packages/shared/src/mobilithek/parser.ts](../packages/shared/src/mobilithek/parser.ts) |
| Ingest-Orchestrierung        | [packages/shared/src/ingest/index.ts](../packages/shared/src/ingest/index.ts) |
| Feed-CRUD (DB)               | [packages/shared/src/db/admin.ts](../packages/shared/src/db/admin.ts) |
| Scheduled Function           | [apps/web/netlify/functions/ingest-sync.mts](../apps/web/netlify/functions/ingest-sync.mts) |
| Push Webhook Edge Function   | [apps/web/netlify/edge-functions/mobilithek-webhook.ts](../apps/web/netlify/edge-functions/mobilithek-webhook.ts) |
| Interner Webhook-Forward     | [apps/web/app/api/internal/mobilithek/webhook/route.ts](../apps/web/app/api/internal/mobilithek/webhook/route.ts) |
| DB-Schema / Migrationen      | [db/schema.sql](../db/schema.sql), [db/migrations/](../db/migrations/) |

---

## 2. Zwei Feed-Typen, drei Modi

Mobilithek bietet pro Subscription **genau einen** Typ und Modus:

| Feld  | Werte          | Bedeutung                                                                 |
| ----- | -------------- | ------------------------------------------------------------------------- |
| type  | `static`       | Voller Katalog aller Standorte. Selten (täglich/mehrtägig) via Pull.      |
|       | `dynamic`      | Nur Änderungen an Status/Preisen.                                         |
| mode  | `pull`         | Wir holen (HTTP GET). Jede paar Minuten.                                  |
|       | `push`         | Mobilithek pusht per Webhook. Kein automatischer Pull; Pull-404 ist normal bei echten Push-only-Feeds. |
|       | `hybrid`       | Push bevorzugt, regelmäßiger Pull als Sicherheitsnetz.                    |

### Intervall-Felder (zeitlich)
- `poll_interval_minutes` — nur für `static` oder `dynamic + mode=pull`. Wie oft voll pullen.
- `reconciliation_interval_minutes` — nur für `dynamic + mode=hybrid`. Wie oft als Fallback pullen, falls Pushes ausfallen.
- Bei `dynamic + mode=push`: leer lassen. `intervalMinutesFor()` gibt `null` zurück; der Cron wartet bewusst auf Webhooks.

Die Logik lebt in `intervalMinutesFor()` und `shouldRunFeed()` in
[packages/shared/src/ingest/index.ts](../packages/shared/src/ingest/index.ts).

---

## 3. Einen neuen Feed einpflegen — Schritt für Schritt

Einen Feed **korrekt** aufzunehmen heißt:
1. Subscription-ID und Modus beim CPO klären.
2. CPO-Eintrag in `cpos` sicherstellen.
3. Credentials (Client-Zertifikat) in `app_secrets` legen **oder** als Env Var setzen.
4. `feed_configs`-Row anlegen (via Admin-UI oder direkt SQL).
5. Test-Sync (dryRun) auslösen und erst bei Erfolg aktiv schalten.

### 3.1 Voraussetzungen klären (vor dem Einpflegen)

Vom CPO / Mobilithek brauchst du:

- **subscription_id** (z.B. `982312651690225664`) — numerisch, technisch. **Nicht** die menschlich sichtbare Angebots-ID aus dem Mobilithek-Portal.
- **type**: `static` oder `dynamic` (steht auf dem Subscription-Detail im Mobilithek-Portal).
- **mode**: `pull`, `push` oder `hybrid` (ebenso).
- **Bei Push-Feeds:** die Ziel-URL aus §3.6 in Mobilithek setzen und einen Testlauf im Mobilithek-Portal ausloesen.
- **URL** (nur wenn abweichend vom Standard `https://m2m.mobilithek.info`): dann in `url_override` speichern. Sonst `null` lassen, damit der Default-Base aus `client.ts` greift.
- **Client-Zertifikat**: Mobilithek nutzt mTLS auf Azure Application Gateway.
  - Entweder **PKCS#12 (.p12)** + Passwort (empfohlen, ein File),
  - oder **PEM-Paar** (`cert.pem` + `key.pem`).
  - In der Regel hat die Plattform genau **ein** Data-Consumer-Zertifikat, das für ALLE Subscriptions gilt. Dann reicht ein globaler `MOBILITHEK_*`-Secret-Eintrag — siehe 3.3.

### 3.2 CPO-Row sicherstellen

`stations.cpo_id` ist FK auf `cpos.id` (TEXT). Wenn der CPO noch nicht existiert:

```sql
INSERT INTO cpos (id, name, country_code)
VALUES ('vaylens', 'Vaylens', 'DE')
ON CONFLICT (id) DO NOTHING;
```

> Konvention: `cpo.id` ist lowercase-slug (`tesla`, `vaylens`, `enbw`, `eaaze`).
> Er muss mit der externalIdentifier im Mobilithek-Payload übereinstimmen, sonst
> produziert der Parser einen anderen CPO als du erwartest.

### 3.3 Credentials ablegen

**Ein Mobilithek-Account = ein Zertifikat für ALLE Feeds.** Tesla, Vaylens,
EnBW, EAAZE etc. nutzen denselben `MOBILITHEK_CERT_P12_BASE64` +
`MOBILITHEK_CERT_PASSWORD`. Nur wenn ein CPO ausnahmsweise ein eigenes Cert
ausstellt (bisher kein Fall), braucht es einen per-CPO Override.

**Aktuelles Zertifikat (Stand April 2026):**

| Was            | Wert                                                                              |
| -------------- | --------------------------------------------------------------------------------- |
| `.p12`-Datei   | `certs/mobilithek.p12` (lokal im Repo, via `.gitignore` ausgeschlossen)           |
| Passphrase     | `j2&AYtZwm$cs`                                                                    |
| Herkunft       | Mobilithek-Portal → Account → m2m-Zertifikat, Passwort kam per SMS bei Ausstellung |
| Ablage Prod    | Supabase `app_secrets` (Keys `MOBILITHEK_CERT_P12_BASE64`, `MOBILITHEK_CERT_PASSWORD`) |
| Ablage Dev     | optional `.env.local` mit denselben Var-Namen                                      |

> Passwort enthält `&` und `$` — in Shell/SQL **immer single-quoten**
> (`'j2&AYtZwm$cs'`), sonst interpretiert die Shell `$cs` als leere Variable
> und du siehst später „wrong password"-Fehler beim P12-Parsen.

Wenn das Zertifikat abläuft oder rotiert wird: neues `.p12` nach
`certs/mobilithek.p12` legen, diese Tabelle aktualisieren, Schritt unten
(Base64 → `app_secrets` UPSERT) erneut ausführen.

**Reihenfolge der Auflösung** (in `resolveCredentialValue` / `buildAgent`, [client.ts](../packages/shared/src/mobilithek/client.ts)):

1. `env[{REF}_{SUFFIX}]` — z.B. `VAYLENS_CERT_P12_BASE64`
2. `env[MOBILITHEK_{SUFFIX}]` — globaler Env-Fallback
3. `app_secrets[{REF}_{SUFFIX}]` — DB-spezifisch
4. `app_secrets[MOBILITHEK_{SUFFIX}]` — DB-global
5. lokal `MOBILITHEK_CERT_P12_PATH` oder Default `certs/mobilithek.p12` — nur für Local Dev / Test-Syncs

`{REF}` ist `feed_configs.credential_ref` uppercased, nicht-alphanumerisch → `_`. Beispiele:

| credential_ref | → REF      |
| -------------- | ---------- |
| `vaylens`      | `VAYLENS`  |
| `Tesla`        | `TESLA`    |
| `ionity-eu`    | `IONITY_EU` |
| `null`         | (nur MOBILITHEK_-Fallback greift) |

`{SUFFIX}` ist einer von:

| Suffix             | Inhalt                                              |
| ------------------ | --------------------------------------------------- |
| `CERT_P12_BASE64`  | Base64-encoded PKCS#12-Bundle (empfohlen)           |
| `CERT_PASSWORD`    | Passphrase für das P12-Bundle                       |
| `CLIENT_CERT`      | PEM-Text (mit echten Zeilenumbrüchen, oder `\n`-escaped) |
| `CLIENT_KEY`       | PEM-Text des privaten Schlüssels                    |
| `WEBHOOK_SECRET`   | Shared Secret für Push-Webhooks                     |

**Ein Cert für alle Feeds (Normalfall):**

```sql
INSERT INTO app_secrets (key, value, description) VALUES
  ('MOBILITHEK_CERT_P12_BASE64',
   '<base64-Inhalt-der-.p12>',
   'Global Mobilithek data-consumer cert, used by all feeds without a per-CPO override'),
  ('MOBILITHEK_CERT_PASSWORD',
   '<passphrase>',
   'Passphrase for MOBILITHEK_CERT_P12_BASE64')
ON CONFLICT (key) DO UPDATE SET value = EXCLUDED.value, updated_at = now();
```

**Per-CPO Cert (nur wenn nötig):**

```sql
INSERT INTO app_secrets (key, value, description) VALUES
  ('VAYLENS_CERT_P12_BASE64', '<base64>', 'Vaylens-specific data-consumer cert'),
  ('VAYLENS_CERT_PASSWORD',   '<pass>',   'Passphrase for Vaylens cert')
ON CONFLICT (key) DO UPDATE SET value = EXCLUDED.value, updated_at = now();
```

Base64-Encoding einer `.p12`-Datei lokal:

```sh
base64 -i consumer-cert.p12 | pbcopy     # macOS
base64 -w0 consumer-cert.p12 | xclip     # Linux
```

> **Wichtig:** Ohne gültiges Zertifikat wirft `buildAgent` jetzt **sofort** einen
> sprechenden Fehler (`Kein Mobilithek-Client-Zertifikat für Feed "X" konfiguriert`).
> Früher gab es einen kryptischen 400 von Azure. Wenn du diesen Fehler siehst:
> Credentials fehlen, nicht Netzwerk / Cert-Validität. Lokal reicht jetzt auch
> die Repo-Datei `certs/mobilithek.p12` (bzw. `MOBILITHEK_CERT_P12_PATH`), sofern
> die Passphrase als `MOBILITHEK_CERT_PASSWORD` oder via `app_secrets` verfügbar ist.

### 3.4 Feed-Row anlegen

Präferiert: Admin-UI (`/admin`). Per SQL:

```sql
INSERT INTO feed_configs (
  source, cpo_id, name, type, mode, subscription_id,
  url_override, poll_interval_minutes, reconciliation_interval_minutes,
  is_active, ingest_catalog, ingest_prices, ingest_status,
  credential_ref, webhook_secret_ref, notes
) VALUES (
  'mobilithek',
  'vaylens',
  'Vaylens Static AFIR',
  'static',
  'pull',
  '982312651690225664',
  NULL,              -- url_override: NULL = Default m2m.mobilithek.info verwenden
  1440,              -- täglich
  NULL,
  false,             -- IMMER erst is_active=false; erst nach erfolgreichem Test aktivieren
  true, true, false, -- ingestCatalog, ingestPrices, ingestStatus
  'vaylens',         -- credential_ref: nur nötig, wenn NICHT MOBILITHEK_* reicht
  NULL,
  'Initial onboarding — cert via MOBILITHEK_CERT_P12_BASE64'
);
```

**Dos & Don'ts:**

- ✅ `url_override = NULL` lassen, **es sei denn** der Provider nennt explizit einen Nicht-Standard-Host. Der Default in `client.ts` ist `https://m2m.mobilithek.info` (gem. OpenAPI-Spec). Frühere Migrationen haben `mobilithek.info:8443` gespeichert — das ist der alte Host mit einer anderen Azure-Regel-Kette und sollte schrittweise umgestellt werden.
- ✅ `credential_ref` leer lassen, wenn der globale `MOBILITHEK_*`-Secret reicht.
- ❌ Niemals die sichtbare Angebots-ID aus dem Mobilithek-Portal als `subscription_id` eintragen — das ist eine andere Zahl. Siehe EAAZE-Einträge im Repo mit Notiz „Sichtbare Angebots-ID als Platzhalter…".
- ✅ Neue Feeds `is_active = false` erstellen und per Admin-UI „Test-Sync" grün bekommen, dann aktivieren.
- ✅ Push-only Dynamic-Feeds sind ein Sonderfall: Admin-UI „Sync/Test" darf keinen Pull erzwingen. Erfolgsmeldung ist sinngemaess `Push-only Dynamic-Feed: kein Pull-Endpunkt, wartet auf Mobilithek-Webhook`. Der echte Test passiert ueber den Mobilithek-Push-Test in §3.6.

### 3.5 Test-Sync

In Admin-UI: „Test" auf dem Feed → erwartet `Verbindung und Zugangsdaten erfolgreich geprüft`. Oder per API:

```sh
curl -X POST https://adhoc.../api/admin/feeds/<feed-id>/sync
```

Bei Fehlern die `sync_runs`-Zeile lesen — `message` ist immer aussagekräftig.

### 3.6 Push-Webhook fuer Dynamic-Feeds einrichten

**Standard-Ziel-URL fuer Mobilithek:**

```text
https://adhoc-plattform.netlify.app/api/admin/mobilithek/webhook/<feed-id>
```

Beispiel EnBW Dynamic:

```text
https://adhoc-plattform.netlify.app/api/admin/mobilithek/webhook/472eae23-52f2-4f7c-a25e-7f45ce509b45
```

**Wichtig:** Diese URL nimmt die interne `feed_configs.id` (`uuid`), nicht die Mobilithek-Angebots-ID
und nicht zwingend die Subscription-ID. Alternativ kann `/api/mobilithek/webhook?subscriptionId=<id>`
verwendet werden, wenn die Subscription-ID eindeutig ist; fuer Agenten ist die Feed-ID-URL robuster.

**Warum Edge Function?**
Mobilithek sendet Dynamic-Push-Payloads gzip-komprimiert mit `Content-Type: application/json`.
Normale Netlify Functions bekommen diesen Body in dieser Kombination als bereits beschädigten
UTF-8-String (`\u001f�\b...`) und koennen ihn nicht mehr gunzippen. Die Netlify Edge Function
bekommt den Raw-Body vorher, entpackt gzip und leitet normales JSON intern weiter.

Der Mobilithek-Portal-Test kann nur einen `testRequest` ohne echte
`aegiEnergyInfrastructureStatusPublication` senden. Dieser Test beweist dann nur, dass der
Transport funktioniert; er erzeugt bewusst keine Live-Statusdaten im Frontend.

**Pflicht-Env in Netlify:**

| Variable | Zweck |
|---|---|
| `MOBILITHEK_FORWARD_SECRET` | Shared Secret zwischen Edge Function und internem Next-Endpunkt. Muss in Netlify gesetzt sein. |

Nach Setzen oder Aendern von `MOBILITHEK_FORWARD_SECRET` immer einen Production-Deploy ausloesen,
damit Edge Function und Next Route denselben Wert sehen.

**Live-Checks nach jedem neuen Push-Feed:**

```sh
# Healthcheck: muss netlify-edge-function melden
curl -i https://adhoc-plattform.netlify.app/api/mobilithek/webhook

# Mobilithek-artiger gzip-Test gegen Feed-ID-URL: muss 200 liefern
printf '{"messageContainer":{"payload":[]}}' | gzip | \
  curl -i -X POST \
    'https://adhoc-plattform.netlify.app/api/admin/mobilithek/webhook/<feed-id>' \
    -H 'Content-Type: application/json' \
    -H 'Content-Encoding: gzip' \
    --data-binary @-

# Interner Endpunkt ohne Forward-Secret: muss 401 liefern
curl -i -X POST \
  'https://adhoc-plattform.netlify.app/api/internal/mobilithek/webhook?feedId=<feed-id>' \
  -H 'Content-Type: application/json' \
  --data-binary '{"messageContainer":{"payload":[]}}'
```

Erwartung:

| Check | Erfolg |
|---|---|
| GET `/api/mobilithek/webhook` | `200` und `{"ok":true,"runtime":"netlify-edge-function"}` |
| gzip POST auf `/api/admin/mobilithek/webhook/<feed-id>` | `200` und `{"ok":true,"feedId":"..."}` |
| POST auf `/api/internal/mobilithek/webhook?...` ohne Secret | `401 Invalid forward secret` |

Wenn der gzip-Test stattdessen `runtime":"netlify-legacy-function-proxy"` oder `Unexpected token '\u001f'`
zeigt, greift die Edge Function nicht. Dann zuerst `netlify.toml` pruefen:

```toml
[[edge_functions]]
  path = "/api/admin/mobilithek/webhook/*"
  function = "mobilithek-webhook"

[[edge_functions]]
  path = "/api/mobilithek/webhook"
  function = "mobilithek-webhook"
```

Danach per Netlify Remote Build deployen, nicht nur lokale Artefakte hochladen:

```sh
netlify deploy --trigger --prod --site <site-id> --filter web
```

---

## 4. Was bei jedem Sync passiert

Sequenz in `runFeedAction` ([ingest/index.ts](../packages/shared/src/ingest/index.ts)):

1. **Run-Claim:** `INSERT INTO sync_runs status='running' ... ON CONFLICT DO NOTHING`.
   Migration 003 erzwingt per Unique-Index, dass pro Feed nur ein laufender Sync existiert.
   Wenn bereits ein Lauf aktiv ist, geben Scheduler und manuelle Pulls den bestehenden Lauf zurück,
   statt einen Fehler zu schreiben. Webhooks werfen in diesem Fall einen Fehler, damit der Sender
   retryen kann.
2. **HTTP-Call** (Static: `GET /mobilithek/api/v1.0/publication/{subId}`, Dynamic Pull/Hybrid: `GET /mobilithek/api/v1.0/subscription?subscriptionID={subId}` mit `If-Modified-Since`; Dynamic Push-only: kein Pull, wartet auf Webhook und wird bei manuellen Tests als Noop-Erfolg markiert).
   - Gzip verpflichtend (Accept-Encoding). axios dekomprimiert automatisch.
   - 204 / 304 → als „keine Änderung" behandelt, kein Fehler.
3. **Parse** (`parseStaticMobilithekPayload` / `parseDynamicMobilithekPayload`).
4. **Raw-Payload persistieren** (`raw_feed_payloads`) in einer kurzen DB-Transaktion:
   - Bei > `RAW_PAYLOAD_MAX_BYTES` (Default 512 KB) wird nur eine **strukturelle Zusammenfassung** gespeichert (`__truncated=true`, Kopf/Fuß-Preview, Size). Vaylens' ~40 MB Payloads würden sonst die jsonb-Spalte sprengen.
5. **Upsert** in `stations`, `charge_points`, `connectors`, `tariffs*`, bzw. Deltas in `availability_snapshots`, `price_snapshots`.
6. **`feed_configs` updaten** (`last_success_at`, `last_delta_count`, `cursor_state.lastModified`, Fehler-Counter zurücksetzen).
7. **`sync_runs` finalisieren** (`status='success'`, `finished_at`, `message`, `delta_count`).

Bei Exception während HTTP, Parse oder DB-Schreibphase: `markFeedFailure` setzt `last_error_message`, `consecutive_failures++`,
`sync_runs.status='failed'`. Der Error wird zurückgegeben (und von `runDueFeedCycle` geloggt).

---

## 5. Der Netlify-Cron (jede Minute)

[apps/web/netlify/functions/ingest-sync.mts](../apps/web/netlify/functions/ingest-sync.mts) ruft `runDueFeedCycle()` auf. Eigenschaften:

- **Begrenzt parallel.** Der Cycle arbeitet fällige Feeds mit `FEED_CYCLE_CONCURRENCY` ab
  (Default `min(PG_POOL_MAX, 4)`). Dadurch bleiben Datenbank-Pool, Netlify-Invocation und
  Mobilithek auch bei 100+ konfigurierten Feeds stabil.
- **Hard Timeout pro Feed:** `FEED_RUN_TIMEOUT_MS` (Default 90 s). Nach Ablauf wartet der Cycle
  nicht weiter auf diesen Feed und arbeitet weiter; der laufende `sync_runs`-Claim verhindert
  Doppelarbeit, bis der Lauf erfolgreich endet oder vom Stuck-Run-Cleanup freigegeben wird.
- **Durable Claim:** Überlappende Cron-Invocations erzeugen keine `failed`-Lock-Einträge mehr.
  Ein zweiter Lauf sieht die bestehende `running`-Zeile und überspringt den Feed ohne neuen
  Mobilithek-Abruf.
- **Top-Level Try/Catch:** Selbst eine geworfene Exception aus `runDueFeedCycle` killt die Netlify-Invocation nicht — damit der nächste Cron-Tick nicht ausgesetzt wird.
- **Stuck-Run Cleanup:** Vor jedem Cycle werden `sync_runs` mit `status='running'` und `started_at < now() - 5m` auf `failed` gesetzt.

**Env-Knöpfe:**

| Variable                  | Default     | Zweck                                                  |
| ------------------------- | ----------- | ------------------------------------------------------ |
| `FEED_RUN_TIMEOUT_MS`     | `90000`     | Max. Laufzeit eines Einzel-Feeds im Cycle              |
| `FEED_CYCLE_CONCURRENCY`  | `min(PG_POOL_MAX, 4)` | Max. gleichzeitige Feed-Aktionen pro Cron-Cycle |
| `MOBILITHEK_TIMEOUT_MS`   | `60000`     | axios-Timeout pro HTTP-Request                         |
| `RAW_PAYLOAD_MAX_BYTES`   | `524288`    | Ab dieser Größe wird der Raw-Payload zusammengefasst    |
| `MOBILITHEK_BASE_URL`     | `https://m2m.mobilithek.info` | Override für Staging/Testing             |
| `MOBILITHEK_USE_FIXTURES` | _(unset)_   | `=1` verwendet die Fixtures aus `db/fixtures/`          |
| `MOBILITHEK_FORWARD_SECRET` | _(unset)_ | Schuetzt `/api/internal/mobilithek/webhook`; in Produktion setzen |
| `PG_POOL_MAX`             | `10`        | Max. offene PG-Connections                             |

---

## 6. Große Payloads (Vaylens-Fall)

**Beobachtung:** Die Vaylens-Static-Subscription liefert ca. 40–80 MB (ungezippt). Das hat in der Vergangenheit zu drei Problemen geführt:

1. **axios hat die Response abgeschnitten.** Default `maxContentLength` war 10 MB → JSON-Parse-Fehler. **Gefixt** in `client.ts` (jetzt `maxContentLength: 200 MB`).
2. **jsonb-Spalte ist bei Mehr-MB-Payloads unbrauchbar.** Zeilen werden groß, Backups dauern, Queries langsam. **Gefixt** durch `RAW_PAYLOAD_MAX_BYTES`-Truncation, siehe Kapitel 4 Punkt 4.
3. **Lambda-/Function-Memory.** Ein voller Parse kopiert Daten mehrfach. Falls das knapp wird: Netlify-Function-Memory erhöhen (`NETLIFY_MEMORY=1024` / Plan abhängig).

**Regeln für neue Feeds:**

- Wenn der Provider „very large static" ankündigt: `poll_interval_minutes` großzügig setzen (≥ 1440), damit der Cron den Cycle nicht alle paar Minuten belastet.
- Bei Dynamic-Feeds mit `If-Modified-Since` ist der Netto-Traffic fast immer klein — hier ist Truncation selten nötig.
- Wenn der Parse-Schritt > 10 s dauert, `FEED_RUN_TIMEOUT_MS` in Netlify env hochdrehen — aber lieber vorher profilieren.

---

## 7. Troubleshooting-Runbook

### „400 No required SSL certificate was sent" (Azure-HTML-Body)
→ **Zertifikat fehlt** oder kommt nicht am TLS-Handshake an.
- Prüfen: welcher `credential_ref` ist gesetzt? In `app_secrets` nach `{REF}_CERT_P12_BASE64` und `MOBILITHEK_CERT_P12_BASE64` suchen.
- Seit dem Fail-Fast-Refactor wirft der Client bereits **vor** dem Request: `Kein Mobilithek-Client-Zertifikat für Feed "X" konfiguriert…`. Wenn du dennoch den Azure-400 siehst: Deployment läuft noch mit altem Code.
- Cert + Passwort sind in [§3.3 „Aktuelles Zertifikat"](#33-credentials-ablegen) dokumentiert. `.p12` liegt unter `certs/mobilithek.p12`.

### „stale seit N Std." im Admin-UI, `FEHLER: Keine`
→ Der Cycle hat den Feed nicht erreicht. Ursachen-Checkliste:
1. Netlify Function Logs von `ingest-sync`. Gibt es Invocations? Errors?
2. `SELECT status, started_at, message FROM sync_runs WHERE feed_id = '<id>' ORDER BY started_at DESC LIMIT 20;` — siehst du einen alten `running`-Eintrag? Dann hängt eine frühere Invocation fest.
3. `SELECT id, status, started_at FROM sync_runs WHERE status='running' AND started_at < now() - interval '10 minutes';` → sollten automatisch gecleaned werden, sonst manuell via `DELETE /api/admin/sync-runs`.

### „Feed wird bereits verarbeitet"
→ Ein anderer Lauf verarbeitet denselben Feed. Seit Migration 003 ist das normalerweise kein
Admin-Fehler mehr: Scheduler und manuelle Pulls bekommen den bereits laufenden `sync_runs`-Eintrag
zurück und starten keinen zweiten Mobilithek-Abruf. Wenn die Meldung bei Webhooks dauerhaft
auftaucht, prüfen ob ein alter `running`-Lauf hängt und `DELETE /api/admin/sync-runs` ausführen.

### `Unexpected token … in JSON`
→ Payload kam truncated an. Historisch: `maxContentLength` zu klein. Aktueller Default 200 MB; falls das überschritten wird, in `client.ts` anpassen.

### `Unexpected token '\u001f', "\u001f�\b..." is not valid JSON` beim Mobilithek-Push
→ Mobilithek hat gzip gesendet, aber die Anfrage ist nicht ueber die Edge Function gelaufen.
Das ist der alte Netlify-Function-Fallback, der gzip+`Content-Type: application/json` als
kaputten UTF-8-String sieht.

Checkliste:
1. `GET /api/mobilithek/webhook` muss `runtime = "netlify-edge-function"` liefern.
2. In `netlify.toml` muessen die zwei `[[edge_functions]]`-Regeln aus §3.6 existieren.
3. Der letzte Netlify-Deploy muss `1 edge function deployed` zeigen.
4. Danach den gzip-Test aus §3.6 erneut ausfuehren.

Nicht versuchen, den kaputten String in der Serverless Function zu reparieren: das Byte `0x8b`
ist dann bereits durch Unicode Replacement ersetzt und die gzip-Datei ist irreversibel beschaedigt.

### Push-only Dynamic-Feed liefert 404 beim Pull
→ Bei echten Push-only-Feeds ist das normal. Beispiel EnBW Dynamic:
`GET /mobilithek/api/v1.0/subscription?subscriptionID=...` lieferte `404`, waehrend der
Mobilithek-Push-Test erfolgreich ist. `mode = push`, `poll_interval_minutes = NULL`,
`reconciliation_interval_minutes = NULL` setzen und den Webhook aus §3.6 nutzen.

### Parser produziert keine/leere `catalog`-Einträge (0 Stationen verarbeitet)
→ Koordinaten oder Adresse fehlen. Zwei häufige Ursachen:

**a) `locationReference` auf Station-Ebene statt Site-Ebene (Vaylens-Muster)**

Tesla legt `locationReference` direkt auf `energyInfrastructureSite`. Vaylens legt es auf `energyInfrastructureStation` (eine Ebene tiefer). Der Parser (ab 2026-04-19) prüft automatisch beide Stellen — falls ein neuer CPO weiterhin 0 Stationen liefert, zuerst in `raw_feed_payloads.__preview_head` prüfen ob `locationReference` in der Payload existiert und auf welcher Ebene.

```sql
SELECT payload->>'__preview_head' FROM raw_feed_payloads rfp
JOIN feed_configs fc ON fc.id = rfp.feed_id
WHERE fc.name ILIKE '%<cpo>%' ORDER BY rfp.id DESC LIMIT 1;
```

**b) `locLocationExtensionG` hat falsch-benanntes Adress-Feld**

Der Parser sucht `FacilityLocation` (Großbuchstabe) und `facilityLocation` (klein). Wenn ein CPO einen anderen Key verwendet, muss `resolveLocationRef` in [parser.ts](../packages/shared/src/mobilithek/parser.ts) erweitert werden.

### Test-Sync grün, produktiver Sync schreibt keine Stationen
→ Fast immer: `is_active = false` oder `ingest_catalog = false` und/oder der CPO existiert nicht in `cpos`. FK-Constraint würde sonst werfen.

---

## 8. Wartung

- **Stuck Syncs manuell cleanen:** `DELETE /api/admin/sync-runs` → setzt alle `running`-Läufe > 5 min auf `failed`.
- **Raw-Payloads aufräumen:** Migration 002 speichert zusätzlich `payload_size_bytes` und `truncated`. Pruning-Job (noch nicht implementiert) sollte `raw_feed_payloads` > 30 Tage löschen.
- **Pool-Status:** `SELECT count(*) FROM pg_stat_activity WHERE application_name LIKE 'node%';`.

---

## 9. CPO-spezifische Besonderheiten

Dieser Abschnitt dokumentiert bekannte Abweichungen vom Standard-Verhalten für jeden CPO.

### Tesla
- Credentials: PEM-Paar (`TESLA_CLIENT_CERT` + `TESLA_CLIENT_KEY`) in `app_secrets`. **Nicht** die globale `.p12`.
- `locationReference` liegt auf `energyInfrastructureSite`-Ebene (Standard).
- Static-Interval: 1440 Min (täglich). Dynamic: Push + Fallback 5 Min.
- **`availableChargingPower` ist in der Payload auf allen Charge Points `null`.**
  Die Leistung steckt ausschließlich in `connector[i].maxPowerAtSocket` (in Watt, ÷ 1000 = kW).
  Der Parser (ab 2026-04-19) nutzt `maxPowerAtSocket` als Fallback automatisch.
  Ändert Tesla seine Payload-Struktur, hier dokumentieren.
- Alle Sites haben exakt eine `energyInfrastructureStation` → kein Aggregierungs-Problem.
- **Preise in den bisher geprüften Beispielpayloads:**
  Tesla-Static enthielt keine `energyRate`/`energyPrice`.
  Tesla-Dynamic nutzte `aegiElectricChargingPointStatus`, enthielt im geprüften Delta aber ebenfalls keine `energyRateUpdate`.
  Fazit: Tesla kann Status bereits liefern; Preislieferung ist in den vorliegenden Beispielen nicht belegt.

### Vaylens
- Credentials: globale `MOBILITHEK_CERT_P12_BASE64` + `MOBILITHEK_CERT_PASSWORD` in `app_secrets`.
- **`locationReference` liegt auf `energyInfrastructureStation`-Ebene**, nicht auf Site-Ebene. Parser fällt automatisch dorthin zurück.
- Payload-Größe: ~75 MB (Stand April 2026). Wird im Ingest-Cycle auf 512 KB Preview gekürzt, der Parser bekommt aber die volle Payload.
- Vaylens ist ein NAP (National Access Point) und liefert Daten **vieler CPOs** (enercity, iSE, …) unter einer einzigen Subscription. `cpo_id` kommt aus `externalIdentifier[0].identifier` des Operators im Feed.
- Dynamic-Feed: Push-only (kein Fallback-Interval) — läuft nur, wenn Mobilithek aktiv pusht.
- `unsupported Unicode escape sequence`: Vaylens-Payloads enthielten ungültige `\u`-Escapes. Sanitizer in `parser.ts` behebt das seit 2026-04-19 automatisch.

### EnBW / EAAZE
- Globales `MOBILITHEK_*`-Cert reicht.
- **EnBW Dynamic ist Push-only.**
  Der Pull-Endpunkt `/mobilithek/api/v1.0/subscription?subscriptionID=...` kann `404` liefern.
  Das ist kein Feed-Defekt. Entscheidend ist der Mobilithek-Push-Test auf
  `/api/admin/mobilithek/webhook/<feed-id>`.
- **Netlify-Push-URL fuer EnBW Dynamic (Stand 2026-04-26):**
  `https://adhoc-plattform.netlify.app/api/admin/mobilithek/webhook/472eae23-52f2-4f7c-a25e-7f45ce509b45`.
  Mobilithek-Angebots-ID und Abonnement-ID im Portal koennen davon abweichen; die URL verwendet die interne Feed-ID.
- **Getestetes Fehlerbild vor dem Fix:**
  Mobilithek-Testlauf antwortete `500` mit
  `Unexpected token '\u001f', "\u001f�\b..." is not valid JSON` und Diagnose
  `contentEncoding=gzip`, `runtime=netlify-legacy-function-proxy`.
  Nach dem Edge-Fix muss derselbe gzip-Test `200` liefern.
- EnBW liefert in der echten Payload `operator.externalIdentifier[0].identifier = "EBW"` und `name = "ENBW"`.
  `feed_configs.cpo_id` daher entweder leer lassen oder exakt an der Payload ausrichten; nicht blind `enbw` erzwingen.
- **Tarifidentität:**
  EnBW verwendet im Static Feed denselben rohen Tarifcode `adHoc` an sehr vielen Ladepunkten und Standorten,
  aber mit unterschiedlichen Preisformen.
  `tariff_code` ist deshalb **nicht global eindeutig** und darf nie als Primärschlüssel oder Upsert-Key behandelt werden.
  Die Plattform verwendet dafür ab 2026-04-20 `tariff_key = <scope>|<scopeCode>|<externalTariffCode>`.
  Neue CPO-Anbindungen müssen dieselbe Regel einhalten.
- **Preise im Static Feed:**
  EnBW liefert echte `energyRate`-/`energyPrice`-Daten.
  In den geprüften Payloads tauchten mehrere Preisformen auf, unter anderem:
  `0.66386555 €/kWh + 0.20 €/min ab Minute 30` und
  `0.58823529 €/kWh + 0.10 €/min ab Minute 120`.
  Das sind standort- oder ladepunktabhängige Preisformen trotz identischem externem Tarifcode.
- **Zeitlogik:**
  In den geprüften EnBW-Preisobjekten gab es keine echten Tageszeit- oder Kalenderfenster.
  `timeBasedApplicability` wurde nur sessionbezogen genutzt (`ab Minute X`).
  Echte Tag-/Nachtlogik wäre DATEX-seitig eher über `overallPeriod` zu erwarten und muss bei neuen CPOs gezielt geprüft werden.
- **Dynamic-Statusformat:**
  EnBW-Deltas nutzen in den geprüften Beispielen `aegiRefillPointStatus`, nicht `aegiElectricChargingPointStatus`.
  Parser und zukünftige Agenten müssen beide Varianten unterstützen.
  `outOfOrder` ist fachlich als `OUT_OF_SERVICE` zu behandeln.
- **Site-Level-Aggregierung (ab 2026-04-19):**
  EnBW-Sites haben oft mehrere `energyInfrastructureStation`-Einträge (Stand April 2026: 1333 von 2506 Sites).
  Jede `energyInfrastructureStation` entspricht einer **physischen Ladesäule** am selben Standort.
  Der Parser erzeugt ab sofort **genau einen DB-Eintrag pro `energyInfrastructureSite`** (statt einen pro `energyInfrastructureStation`),
  sobald die Site eine eigene `locationReference` mit Koordinaten und Adresse besitzt.
  Als `station_code` dient `site.idG` (z.B. `"800001256"`).
  `charge_point_count` = Summe der `numberOfRefillPoints` aller untergeordneten Stationen;
  `max_power_kw` = Maximum über alle `totalMaximumPower`-Werte.
  Die alten station-level-Codes (kurze numerische IDs wie `"10996"`) existieren nicht mehr nach dem ersten Sync.

  **Warum drei Varianten im Parser?**
  | Stil | Erkennungsmerkmal | Verhalten |
  |---|---|---|
  | EnBW/Tesla | `site.locationReference` hat Coords + Adresse | Eine DB-Station pro Site, `stationCode = site.idG` |
  | Vaylens | `site.locationReference` fehlt oder unvollständig; Location auf Station-Ebene | Jede `energyInfrastructureStation` → eigene DB-Station |

---

## 10. Bekannte Fallen für neue Agenten

> **Wichtigste Arbeitsregel:** Niemals Payload-Strukturen raten, erfinden oder aus Dokumentation kopieren.
> Stattdessen immer die echten Daten vom User anfordern:
> - „Aktuelles Datenpaket herunterladen" vom Mobilithek-Feed-Detailblatt, oder
> - einen `raw_feed_payloads`-Eintrag aus der DB extrahieren.
>
> Nur die echte Payload zeigt, wie ein CPO das Schema tatsächlich nutzt — Feldnamen,
> Verschachtelungstiefe und optionale Felder weichen regelmäßig vom offiziellen Schema ab
> (Vaylens: `locationReference` auf Station-Ebene statt Site-Ebene war ein solches Beispiel).

Zusätzliche Arbeitsregeln für Preis- und Statusfeeds:
- Niemals annehmen, dass `tariff_code` global eindeutig ist. Immer prüfen, ob derselbe externe Code an mehreren Standorten oder Ladepunkten wiederverwendet wird.
- Dynamic-Feeds nicht nur auf `aegiElectricChargingPointStatus` prüfen. Auch `aegiRefillPointStatus` und stationbezogene Statusobjekte sind schema-konform.
- `timeBasedApplicability` ist Sessionlogik, nicht automatisch Tageszeitlogik. Für Tag-/Nachtpreise gezielt nach `overallPeriod` in Preisobjekten suchen.
- Vor dem Aktivieren von `ingest_prices` immer mindestens einen echten Static- und einen echten Dynamic-Payload des CPO prüfen.

| Falle | Symptom | Lösung |
|-------|---------|--------|
| `app_secrets`-INSERT vergessen | „Kein Mobilithek-Client-Zertifikat" für Feeds ohne Netlify-Env-Var | INSERT für `MOBILITHEK_CERT_P12_BASE64` + `MOBILITHEK_CERT_PASSWORD` — Werte in §3.3 |
| `description`-Spalte fehlt in `app_secrets` | SQL-Fehler beim INSERT mit `description` | Die Spalte existiert nur wenn Migration 002 mit der aktuellen Datei lief. INSERT ohne `description` funktioniert immer |
| Alte Lock-belegt-Einträge nach Cron-Überlappung | Admin zeigt `failed` mit „Lock belegt" obwohl Mobilithek ok ist | Migration 003 + aktueller Code nutzen einen durable `sync_runs`-Claim. Alte Einträge bleiben historisch sichtbar, neue Scheduler-Überlappungen schreiben keinen Fehler mehr. |
| `0 Stationen verarbeitet` bei neuem CPO | Feed sync grün, aber keine Marker auf Karte | `locationReference` prüfen — ist sie auf Site- oder Station-Ebene? Troubleshooting §7 |
| Testlauf wirkt wie echter Sync | `last_success_at`/`last_delta_count` sehen grün aus, aber `stations` bleibt unverändert | Nur `kind = manual`/Scheduler-Läufe persistieren Katalogdaten. `kind = test` ist Dry-Run und darf nicht als produktiver Erfolg interpretiert werden |
| Falsche Tarifüberschreibung bei CPOs mit wiederverwendetem Tarifcode | Preise eines Standorts überschreiben Preise eines anderen | Tarife immer über `tariff_key = scope + scopeCode + externalTariffCode` identifizieren, nie nur über `tariff_code` |
| Dynamic-Feed schreibt keine Statusänderungen obwohl Payload ok aussieht | Delta enthält `refillPointStatus`, aber DB bleibt unverändert | Prüfen, ob der Feed `aegiRefillPointStatus` statt `aegiElectricChargingPointStatus` nutzt; beide Varianten müssen geparst werden |
| Payload > 200 MB | axios-Timeout oder silent truncation | `MAX_RESPONSE_BYTES` in `client.ts` hochsetzen (aktuell 200 MB) |
| `APP_DATA_SOURCE` nicht gesetzt | DB-Fallback für Credentials wird übersprungen | Netlify Env: `APP_DATA_SOURCE=db` setzen |
| Mobilithek-Push gzip endet mit `Unexpected token '\u001f'` | Request landet in `netlify-legacy-function-proxy` statt Edge Function | `[[edge_functions]]`-Regeln in `netlify.toml` pruefen, Remote Build triggern, Healthcheck muss `runtime=netlify-edge-function` melden (§3.6/§7) |
| Interner Webhook ist von außen nutzbar | POST auf `/api/internal/mobilithek/webhook?...` liefert `200` ohne Secret | `MOBILITHEK_FORWARD_SECRET` in Netlify setzen und Production-Deploy ausloesen. Danach muss derselbe POST `401` liefern |
| Push-only Feed wird dauernd als Pull-Fehler markiert | Admin zeigt `404` auf `/subscription?subscriptionID=...` | `mode=push`, `poll_interval_minutes=NULL`, `reconciliation_interval_minutes=NULL`; manuell testen ueber Mobilithek-Push-Test, nicht Remote-Pull |
| Falsche Ladepunkt-Anzahl / Leistung (EnBW-Muster) | Frontend zeigt z.B. „2 Ladepunkte, 150 kW" statt „8 Ladepunkte, 300 kW" | Mehrere `energyInfrastructureStation` pro Site werden nicht aggregiert. Parser ab 2026-04-19 fasst alles per Site zusammen (§9 EnBW). Nach Code-Änderung Feed manuell neu synchronisieren. |
| Geister-Stationen nach Grouping-Änderung | Neue aggregierte Station erscheint korrekt, aber alte Einzel-Einträge bleiben sichtbar | `upsertStaticCatalog` nutzt Cleanup-Query mit `cpo_id = any(parsed_cpo_ids)` — nur wirksam wenn Sync mit neuem Code läuft. `feed_configs.cpo_id = null` ist korrekt; Cleanup greift dann auf geparsede CPO-IDs. Sicherstellen dass der manuelle Sync nach der Code-Änderung über die lokale Dev-Instanz läuft (nicht Netlify-Deployment mit altem Code). |
| Leistungsangaben bei Tesla = 0 oder leer | Stationen erscheinen mit 0 kW im Frontend | `availableChargingPower` ist in Tesla-Payloads generell `null`. Leistung kommt aus `connector.maxPowerAtSocket` (Watt). Parser-Fallback ab 2026-04-19 aktiv (§9 Tesla). |

---

## 11. Änderungshistorie dieser Doku

- **2026-04-26 v7** — Static-Pull-Stabilität und Skalierung:
  1. `sync_runs`-Claim statt Advisory-Lock: pro Feed kann nur noch ein `running`-Lauf existieren.
     Überlappende Cron-Invocations schreiben keine `failed`-Lock-Einträge mehr.
  2. Static-Payloads werden erst nach erfolgreichem Run-Claim von Mobilithek geladen.
     Dadurch erzeugt ein überfälliger großer Static-Feed keine parallelen 40–80-MB-Abrufe.
  3. `FEED_CYCLE_CONCURRENCY` begrenzt die parallelen Feed-Aktionen pro Cron-Cycle
     (Default `min(PG_POOL_MAX, 4)`) für 100+ konfigurierte Feeds.
- **2026-04-26 v6** — Mobilithek-Push-Feeds produktionsfest dokumentiert:
  1. **Netlify Edge Webhook-Pfad** (§1, §3.6, §7, §10): gzip+`application/json` muss ueber `apps/web/netlify/edge-functions/mobilithek-webhook.ts` laufen; normaler Netlify-Function-Fallback kann gzip irreversibel beschaedigen.
  2. **Forward-Secret** (§3.6, §5, §10): `MOBILITHEK_FORWARD_SECRET` schuetzt den internen `/api/internal/mobilithek/webhook`-Forward. Ohne Secret muss dieser Endpunkt `401` liefern.
  3. **Push-only Dynamic-Regeln** (§2, §3.4, §4, §7, §9 EnBW, §10): kein automatischer Pull/Reconciliation fuer `mode=push`; Pull-404 ist bei EnBW Dynamic erwartbar, Mobilithek-Push-Test ist massgeblich.
  4. **Top-Level-`payload`-Envelope**: Mobilithek-Testpushes koennen ohne `messageContainer` kommen. Dynamic-Parser muss sowohl `messageContainer.payload` als auch top-level `payload` akzeptieren.
  5. **Status-Frische**: Jeder Status-Push muss `last_status_update_at` und Stations-Aggregation aktualisieren, auch wenn sich der Statuswert nicht geaendert hat. Sonst wirkt das Frontend stale.
  6. **Live-Runbook fuer neue Feeds** (§3.6): Healthcheck, gzip-Test, interner 401-Test und Remote-Build-Hinweis ergaenzt.
- **2026-04-20 v5** — Preis-/Statuslogik für neue CPOs geschärft:
  1. **Tarifinstanzen statt globalem Tarifcode** (§9 EnBW, §10): `tariff_code` darf nicht mehr als global eindeutiger Schlüssel verstanden werden; neue Regel ist `tariff_key = scope + scopeCode + externalTariffCode`.
  2. **Dynamic-Statusvarianten dokumentiert** (§9 Tesla, §9 EnBW, §10): Tesla-Beispiele nutzen `aegiElectricChargingPointStatus`, EnBW-Beispiele `aegiRefillPointStatus`; beide sind zu unterstützen.
  3. **Preisbefunde festgehalten** (§9 Tesla, §9 EnBW): Tesla-Beispielpayloads ohne Preise, EnBW-Static mit echten standortabhängigen Preisformen und sessionbezogener Minutenlogik.
- **2026-04-19 v4** — Zwei Parser-Bugs gefixt und dokumentiert:
  1. **Tesla `maxPowerAtSocket`-Fallback** (§9 Tesla, §10): `availableChargingPower` ist in Tesla-Payloads generell `null`; Leistung jetzt aus `connector.maxPowerAtSocket` gezogen.
  2. **EnBW Site-Level-Aggregierung** (§9 EnBW, §10): Parser gibt jetzt exakt eine DB-Station pro `energyInfrastructureSite` zurück (statt eine pro `energyInfrastructureStation`), wenn die Site eigene Koordinaten + Adresse hat. Station-Code = `site.idG`. Betrifft 1333 von 2506 EnBW-Sites mit mehreren Ladesäulen.
  3. **Cleanup-Robustheit** (§10): `upsertStaticCatalog` löscht jetzt stale Stationen auch wenn `feed_configs.cpo_id = null`, indem geparsede CPO-IDs als Scope verwendet werden.
  4. **Charge-Point-Details im Frontend**: Neues `chargePoints: ChargePointDetail[]`-Feld in `StationDetail` (domain/types.ts), DB-Query `loadChargePointRowsDb` (db/public.ts), aufklappbare UI-Sektion im Station-Drawer.
- **2026-04-19 v3** — §10: Arbeitsregel „echte Payload anfordern" ergänzt.
- **2026-04-19 v2** — CPO-Besonderheiten (§9), Fallen-Tabelle (§10), Troubleshooting für Vaylens `locationReference`-Muster und `app_secrets`-Fallen.
- **2026-04-19 v1** — Initiale Fassung nach Vaylens-Onboarding und Tesla-Stale-Vorfall. Fail-Fast-Cert, Parallel-Cycle, Payload-Truncation, `app_secrets`-Migration.
