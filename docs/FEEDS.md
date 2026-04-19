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
                   │  (pro Feed, parallel,    │
                   │   mit Timeout + Lock)    │
                   └──┬──────────────────────┘
                      │
        ┌─────────────┼──────────────────────┐
        ▼             ▼                      ▼
   Mobilithek   parse (parser.ts)      DB-Schreibphase
   HTTP-Call    Static → Catalog       stations, charge_points,
   (mTLS)       Dynamic → Updates      tariffs, availability_snapshots,
                                        price_snapshots, raw_feed_payloads
```

Wichtige Module:

| Zweck                        | Datei                                                          |
| ---------------------------- | -------------------------------------------------------------- |
| HTTP-Client + mTLS + Agent   | [packages/shared/src/mobilithek/client.ts](../packages/shared/src/mobilithek/client.ts) |
| DATEX-II/AFIR-Parser         | [packages/shared/src/mobilithek/parser.ts](../packages/shared/src/mobilithek/parser.ts) |
| Ingest-Orchestrierung        | [packages/shared/src/ingest/index.ts](../packages/shared/src/ingest/index.ts) |
| Feed-CRUD (DB)               | [packages/shared/src/db/admin.ts](../packages/shared/src/db/admin.ts) |
| Scheduled Function           | [apps/web/netlify/functions/ingest-sync.mts](../apps/web/netlify/functions/ingest-sync.mts) |
| DB-Schema / Migrationen      | [db/schema.sql](../db/schema.sql), [db/migrations/](../db/migrations/) |

---

## 2. Zwei Feed-Typen, drei Modi

Mobilithek bietet pro Subscription **genau einen** Typ und Modus:

| Feld  | Werte          | Bedeutung                                                                 |
| ----- | -------------- | ------------------------------------------------------------------------- |
| type  | `static`       | Voller Katalog aller Standorte. Selten (täglich/mehrtägig) via Pull.      |
|       | `dynamic`      | Nur Änderungen an Status/Preisen.                                         |
| mode  | `pull`         | Wir holen (HTTP GET). Jede paar Minuten.                                  |
|       | `push`         | Mobilithek pusht per Webhook. Reconciliation-Pull dient als Fallback.    |
|       | `hybrid`       | Push bevorzugt, regelmäßiger Pull als Sicherheitsnetz.                    |

### Intervall-Felder (zeitlich)
- `poll_interval_minutes` — nur für `static` oder `dynamic + mode=pull`. Wie oft voll pullen.
- `reconciliation_interval_minutes` — nur für `dynamic + mode=push|hybrid`. Wie oft als Fallback pullen, falls Pushes ausfallen.

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

### 3.5 Test-Sync

In Admin-UI: „Test" auf dem Feed → erwartet `Verbindung und Zugangsdaten erfolgreich geprüft`. Oder per API:

```sh
curl -X POST https://adhoc.../api/admin/feeds/<feed-id>/sync
```

Bei Fehlern die `sync_runs`-Zeile lesen — `message` ist immer aussagekräftig.

---

## 4. Was bei jedem Sync passiert

Sequenz in `runFeedAction` ([ingest/index.ts](../packages/shared/src/ingest/index.ts)):

1. **Lock:** `pg_try_advisory_lock(hash(feedId))`. Wenn belegt → eigenes `sync_runs`-Entry
   mit `status=failed, message="Feed wird bereits verarbeitet (Lock belegt)"`, dann Exit.
   (Seit Migration 002: Lock-Kollisionen sind im Admin-UI sichtbar, nicht mehr stumm.)
2. **Run-Row:** `INSERT INTO sync_runs status='running'`.
3. **HTTP-Call** (Static: `GET /mobilithek/api/v1.0/publication/{subId}`, Dynamic: `GET /mobilithek/api/v1.0/subscription?subscriptionID={subId}` mit `If-Modified-Since`).
   - Gzip verpflichtend (Accept-Encoding). axios dekomprimiert automatisch.
   - 204 / 304 → als „keine Änderung" behandelt, kein Fehler.
4. **Raw-Payload persistieren** (`raw_feed_payloads`):
   - Bei > `RAW_PAYLOAD_MAX_BYTES` (Default 512 KB) wird nur eine **strukturelle Zusammenfassung** gespeichert (`__truncated=true`, Kopf/Fuß-Preview, Size). Vaylens' ~40 MB Payloads würden sonst die jsonb-Spalte sprengen.
5. **Parse** (`parseStaticMobilithekPayload` / `parseDynamicMobilithekPayload`).
6. **Upsert** in `stations`, `charge_points`, `connectors`, `tariffs*`, bzw. Deltas in `availability_snapshots`, `price_snapshots`.
7. **`feed_configs` updaten** (`last_success_at`, `last_delta_count`, `cursor_state.lastModified`, Fehler-Counter zurücksetzen).
8. **`sync_runs` finalisieren** (`status='success'`, `finished_at`, `message`, `delta_count`).

Bei Exception in 3–6: `markFeedFailure` setzt `last_error_message`, `consecutive_failures++`,
`sync_runs.status='failed'`. Der Error wird zurückgegeben (und von `runDueFeedCycle` geloggt).

---

## 5. Der Netlify-Cron (jede Minute)

[apps/web/netlify/functions/ingest-sync.mts](../apps/web/netlify/functions/ingest-sync.mts) ruft `runDueFeedCycle()` auf. Eigenschaften:

- **Parallel.** Alle fälligen Feeds werden via `Promise.allSettled` gleichzeitig angestoßen. Ein hängendes Vaylens kann Tesla nicht mehr blockieren.
- **Hard Timeout pro Feed:** `FEED_RUN_TIMEOUT_MS` (Default 90 s). Nach Ablauf wird der konkrete Feed abgebrochen (Timeout-Fehler landet in `sync_runs`), der Cycle läuft weiter.
- **Top-Level Try/Catch:** Selbst eine geworfene Exception aus `runDueFeedCycle` killt die Netlify-Invocation nicht — damit der nächste Cron-Tick nicht ausgesetzt wird.
- **Stuck-Run Cleanup:** Vor jedem Cycle werden `sync_runs` mit `status='running'` und `started_at < now() - 5m` auf `failed` gesetzt.

**Env-Knöpfe:**

| Variable                  | Default     | Zweck                                                  |
| ------------------------- | ----------- | ------------------------------------------------------ |
| `FEED_RUN_TIMEOUT_MS`     | `90000`     | Max. Laufzeit eines Einzel-Feeds im Cycle              |
| `MOBILITHEK_TIMEOUT_MS`   | `60000`     | axios-Timeout pro HTTP-Request                         |
| `RAW_PAYLOAD_MAX_BYTES`   | `524288`    | Ab dieser Größe wird der Raw-Payload zusammengefasst    |
| `MOBILITHEK_BASE_URL`     | `https://m2m.mobilithek.info` | Override für Staging/Testing             |
| `MOBILITHEK_USE_FIXTURES` | _(unset)_   | `=1` verwendet die Fixtures aus `db/fixtures/`          |
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
2. `SELECT status, started_at, message FROM sync_runs WHERE feed_id = '<id>' ORDER BY started_at DESC LIMIT 20;` — siehst du Lock-busy-Einträge? Dann hängt eine andere Invocation fest.
3. `SELECT id, status, started_at FROM sync_runs WHERE status='running' AND started_at < now() - interval '10 minutes';` → sollten automatisch gecleaned werden, sonst manuell via `DELETE /api/admin/sync-runs`.

### „Feed wird bereits verarbeitet (Lock belegt)"
→ Eine parallele Invocation hält den Advisory-Lock. Normal bei überlappenden manuellen + geplanten Syncs. Wenn das dauerhaft auftritt: auf gestauete PG-Connections prüfen (Supabase Pooler-Status).

### `Unexpected token … in JSON`
→ Payload kam truncated an. Historisch: `maxContentLength` zu klein. Aktueller Default 200 MB; falls das überschritten wird, in `client.ts` anpassen.

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

### Vaylens
- Credentials: globale `MOBILITHEK_CERT_P12_BASE64` + `MOBILITHEK_CERT_PASSWORD` in `app_secrets`.
- **`locationReference` liegt auf `energyInfrastructureStation`-Ebene**, nicht auf Site-Ebene. Parser fällt automatisch dorthin zurück.
- Payload-Größe: ~75 MB (Stand April 2026). Wird im Ingest-Cycle auf 512 KB Preview gekürzt, der Parser bekommt aber die volle Payload.
- Vaylens ist ein NAP (National Access Point) und liefert Daten **vieler CPOs** (enercity, iSE, …) unter einer einzigen Subscription. `cpo_id` kommt aus `externalIdentifier[0].identifier` des Operators im Feed.
- Dynamic-Feed: Push-only (kein Fallback-Interval) — läuft nur, wenn Mobilithek aktiv pusht.
- `unsupported Unicode escape sequence`: Vaylens-Payloads enthielten ungültige `\u`-Escapes. Sanitizer in `parser.ts` behebt das seit 2026-04-19 automatisch.

### EnBW / EAAZE
- Noch nicht in Produktion. Beim Einpflegen §3 folgen; vermutlich globales `MOBILITHEK_*`-Cert ausreichend.

---

## 10. Bekannte Fallen für neue Agenten

| Falle | Symptom | Lösung |
|-------|---------|--------|
| `app_secrets`-INSERT vergessen | „Kein Mobilithek-Client-Zertifikat" für Feeds ohne Netlify-Env-Var | INSERT für `MOBILITHEK_CERT_P12_BASE64` + `MOBILITHEK_CERT_PASSWORD` — Werte in §3.3 |
| `description`-Spalte fehlt in `app_secrets` | SQL-Fehler beim INSERT mit `description` | Die Spalte existiert nur wenn Migration 002 mit der aktuellen Datei lief. INSERT ohne `description` funktioniert immer |
| Advisory Lock hängt (pgBouncer Transaction Mode) | Feed stale, FEHLER=Keine, Lock-belegt-Einträge in sync_runs | Seit 2026-04-19 `pg_try_advisory_xact_lock` — Locks lösen sich beim Commit/Rollback |
| `0 Stationen verarbeitet` bei neuem CPO | Feed sync grün, aber keine Marker auf Karte | `locationReference` prüfen — ist sie auf Site- oder Station-Ebene? Troubleshooting §7 |
| Payload > 200 MB | axios-Timeout oder silent truncation | `MAX_RESPONSE_BYTES` in `client.ts` hochsetzen (aktuell 200 MB) |
| `APP_DATA_SOURCE` nicht gesetzt | DB-Fallback für Credentials wird übersprungen | Netlify Env: `APP_DATA_SOURCE=db` setzen |

---

## 11. Änderungshistorie dieser Doku

- **2026-04-19 v2** — CPO-Besonderheiten (§9), Fallen-Tabelle (§10), Troubleshooting für Vaylens `locationReference`-Muster und `app_secrets`-Fallen.
- **2026-04-19 v1** — Initiale Fassung nach Vaylens-Onboarding und Tesla-Stale-Vorfall. Fail-Fast-Cert, Parallel-Cycle, Payload-Truncation, `app_secrets`-Migration.
