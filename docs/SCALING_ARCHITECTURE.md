# Scaling-Architektur: Cloudflare-Edge fuer Kartenpunkte und Mobilithek-Feeds

Stand: 2026-04-27

Diese Datei beschreibt das Zielbild fuer eine deutlich guenstigere und performantere
Produktionsarchitektur der Adhoc Plattform. Sie ist keine reine Hosting-Preisliste,
sondern eine technische Entscheidungsgrundlage fuer hohe Kartenlast, stark wachsende
Feed-Anzahlen und eine spaetere kommerzielle Nutzung.

Kurzentscheidung: **Cloudflare + bestehendes Postgres/PostGIS** ist der bevorzugte
erste Zielpfad. Postgres bleibt die Master-Datenbank. Cloudflare uebernimmt die
kritischen Public-Traffic-Pfade, Webhooks und die CDN-nahe Auslieferung vorberechneter
Kartenpunkt-Daten.

---

## 1. Zielbild

Die Plattform muss mittelfristig nicht nur einzelne Admin- und Test-Workflows
bedienen, sondern sehr viele gleichzeitige Nutzer auf einer Karte:

- 10.000 gleichzeitige Nutzer sollen Kartenpunkte schnell und zuverlaessig sehen.
- Mobilithek-Feeds werden in Anzahl, Payload-Groesse und Update-Frequenz deutlich
  wachsen.
- Public APIs muessen kommerziell nutzbar, beobachtbar und kostenkontrollierbar
  sein.
- Feed-Ingest, Admin-UI und Public-Kartenlast duerfen sich nicht gegenseitig
  blockieren.

Der wichtigste Architekturwechsel ist deshalb:

```text
Nicht:
Karte oeffnet -> API liest alle Stationen aus Postgres -> App filtert -> Antwort

Sondern:
Karte oeffnet -> Cloudflare/CDN liefert vorberechnete Tile-/Bounds-Daten
              -> Postgres wird nur bei Cache-Miss oder Detailabruf benoetigt
```

Postgres/PostGIS bleibt die fachliche Wahrheit fuer Stationen, Ladepunkte, Preise,
Status, Feed-Konfigurationen, Sync-Runs und Admin-Daten. Die Karte bekommt jedoch
eine eigene, edge-faehige Auslieferungsschicht.

---

## 2. Warum Netlify nicht das Ziel fuer hohe Kartenlast ist

Netlify ist fuer kleine bis mittlere Next.js-Projekte bequem, passt aber fuer dieses
Lastprofil nur bedingt:

- Viele Kartenbewegungen erzeugen sehr viele API-Requests. Bei Netlify werden
  Requests, Bandbreite und Compute als Plattformverbrauch relevant.
- Mobilithek-Push hatte bereits einen Sonderfall: gzip-komprimierte JSON-Payloads
  mussten ueber eine Edge Function vorverarbeitet werden, weil normale Functions den
  Raw-Body in dieser Kombination nicht robust genug bekamen.
- Scheduled Functions eignen sich fuer einfache Cron-Workloads, aber Feed-Ingest mit
  vielen CPOs, grossen Static-Payloads und haeufigen Dynamic-Updates braucht
  langfristig Queue-, Retry- und Backpressure-Mechanismen.
- Die aktuell kritische Karten-API profitiert wenig davon, nur auf einen anderen
  Serverless-Anbieter zu wechseln. Entscheidend ist, dass Kartenpunkte nicht pro
  Nutzer live in der App-Schicht aus allen Stationsdaten berechnet werden.

Netlify kann kurzfristig weiter funktionieren. Es sollte aber nicht die Architektur
sein, auf der 10.000 parallele Karten-Nutzer und stark wachsender Feed-Traffic
abgesichert werden.

---

## 3. Empfohlene Architektur

### Zielkomponenten

```text
Browser / Karte
  -> Cloudflare CDN / Worker
  -> gecachte Tile- oder Bounds-Responses
  -> nur bei Cache-Miss zu Postgres/PostGIS

Mobilithek Push
  -> Cloudflare Worker Webhook Gateway
  -> normalisiert gzip/JSON + prueft Secrets
  -> interner Ingest-Endpunkt oder Queue
  -> Postgres/PostGIS
  -> betroffene Map-Caches/Tiles invalidieren oder neu erzeugen

Mobilithek Pull / Reconciliation
  -> Scheduler / Worker / Cron-Service
  -> runDueFeedCycle()
  -> Postgres/PostGIS
  -> Tile-/Cache-Rebuild

Station-Klick
  -> gezielte Detail-API fuer genau eine Station
  -> Postgres oder kurzer Detail-Cache
```

### Rolle von Cloudflare

Cloudflare ist im Zielbild nicht nur CDN vor einer bestehenden App, sondern die
Traffic-Schicht fuer alles, was extrem oft, global oder raw-body-sensitiv ist:

- **Workers** fuer Public Map API, Mobilithek Webhook Gateway und kleine
  Edge-Transformations.
- **CDN Cache / Cache API** fuer haeufig abgefragte Tile- und Bounds-Responses.
- **R2** fuer vorberechnete, versionierte JSON- oder Vector-Tile-Dateien.
- **KV** fuer kleine, haeufig gelesene Metadaten wie aktive Tile-Versionen,
  Cache-Manifeste oder leichte Feature-Flags.
- **Queues** spaeter fuer entkoppelten Feed-Ingest und Cache-Rebuild-Jobs.
- **mTLS Bindings** fuer externe mTLS-Requests, falls Mobilithek-Pull langfristig
  aus Workers heraus erfolgen soll.

Relevante Quellen:

- [Cloudflare Workers Pricing](https://developers.cloudflare.com/workers/platform/pricing/)
- [Cloudflare Workers mTLS bindings](https://developers.cloudflare.com/workers/runtime-apis/bindings/mtls/)

### Rolle von Postgres/PostGIS

Postgres bleibt die Master-Datenbank und wird nicht durch Cloudflare D1 ersetzt.
Gruende:

- Das bestehende Schema nutzt PostGIS fuer Stations-Geometrien.
- Feed-Ingest, Parser, Tarife, Status-Snapshots und Admin-Funktionen sind bereits
  auf Postgres ausgelegt.
- Fuer Karten-Queries sind raeumliche Indizes und materialisierte Sichten deutlich
  passender als eine einfache Edge-Datenbank.

Postgres muss aber anders genutzt werden:

- Karten-Bounds und Route-Korridore sollten DB-seitig ueber PostGIS gefiltert werden.
- Haeufige Kartenantworten sollten nicht bei jedem Nutzer neu aus relationalen
  Tabellen zusammengesetzt werden.
- Fuer Kartenpunkte sollten kompakte Read-Modelle entstehen, die nur die Marker-
  und Filterdaten enthalten.

### Bestehender Ansatz im Repo

`apps/mobilithek-gateway` ist bereits ein Cloudflare-Worker-Ansatz fuer
Mobilithek-Push-Payloads. Dieser Worker liest den Raw-Body, dekomprimiert gzip,
normalisiert JSON und leitet die Anfrage an den internen Webhook weiter. Das ist
der richtige Einstieg fuer die Migration weg von Netlify Edge Functions.

---

## 4. Google-Maps-Prinzip fuer Ladepunkte

Google Maps wirkt bei POIs sofort, weil die Karte nicht bei jeder Bewegung eine
grosse Live-Datenbankabfrage fuer alle sichtbaren Objekte ausloest. Das uebertragbare
Prinzip:

- **Tiles:** Die Welt wird in kleine Kacheln pro Zoomstufe zerlegt.
- **Vorberechnung:** Labels, POIs, Cluster und sichtbare Details werden passend zur
  Zoomstufe vorbereitet.
- **CDN-nahe Auslieferung:** Haeufige Kacheln liegen nahe am Nutzer.
- **Level of Detail:** Weit herausgezoomt werden weniger, aggregierte oder geclusterte
  Punkte angezeigt; Details kommen erst beim Hineinzoomen.
- **Detailabruf bei Interaktion:** Vollstaendige Daten werden erst geladen, wenn der
  Nutzer eine Station anklickt oder eine Ergebnisliste oeffnet.

Fuer die Adhoc Plattform heisst das:

```text
Zoom 5-8:
  grobe Cluster je Region oder Tile

Zoom 9-12:
  reduzierte Marker mit Anbieter, Preisband, Leistung, Verfuegbarkeit

Zoom 13+:
  konkrete Stationen mit kompaktem Marker-Payload

Station-Klick:
  vollstaendige Station-Details, Ladepunkte, Stecker, Preise, Status
```

Detaildaten gehoeren nicht in jedes Karten-Tile. Tiles sollen klein, stabil cachebar
und schnell parsebar bleiben.

---

## 5. Aktueller Engpass

Die Public-Karten-Route `/api/public/stations/map` nutzte urspruenglich die
gemeinsame Stationslogik und filterte in der App-Schicht. Vereinfacht:

```text
Request mit bounds/filters
  -> listMapStations()
  -> stationRecords()
  -> listStationRecordsDb()
  -> App filtert sichtbare Stationen und Filter
```

Das war fuer kleine Datenmengen gut wartbar, aber fuer grosse Last problematisch:

- Jede Kartenbewegung kann DB- und App-Arbeit ausloesen.
- Die App kann mehr Stationsdaten laden, als fuer den sichtbaren Kartenausschnitt
  benoetigt werden.
- Filterung, Sortierung und Tarifzusammenfassung passieren zu spaet im Request-Pfad.
- 10.000 parallele Nutzer wuerden dieselben Regionen immer wieder berechnen lassen.

Der erste Umbau verschiebt den raeumlichen Ausschnitt bereits in die DB:
`listStationRecordsInBoundsDb()` nutzt PostGIS-Bounds, bevor die App-Schicht die
restlichen Filter auf das reduzierte Ergebnis anwendet. Das gilt fuer die freie
Kartenansicht und fuer Routenkandidaten, deren DB-Vorauswahl auf Route-Bounds plus
Korridor begrenzt wird. Der weitere Zielpfad ist:

- PostGIS filtert per Bounds, Tile oder Route-Korridor.
- Kompakte Read-Models enthalten nur Marker-relevante Felder.
- Worker/CDN liefern vorberechnete oder kurz gecachte Antworten.
- Detaildaten bleiben in einer separaten API.

---

## 6. Migrationsphasen

### Phase 1: Cloudflare Webhook Gateway produktiv machen

Ziel: Netlify Edge Function fuer Mobilithek-Push ersetzen.

- `apps/mobilithek-gateway` als produktiven Cloudflare Worker deployen.
- Mobilithek-Push-URLs auf den Worker umstellen.
- `MOBILITHEK_FORWARD_SECRET` im Worker und in der App setzen.
- gzip-POSTs gegen Feed-ID-URLs testen.
- Netlify Edge Function zunaechst als Fallback dokumentieren, danach entfernen.

Erfolgskriterium:

- Mobilithek gzip Push liefert stabil `200`.
- Der interne Webhook bleibt ohne Forward-Secret geschuetzt.
- Webhook-Verarbeitung ist nicht mehr von Netlify Edge Functions abhaengig.

### Phase 2: DB-seitige Karten-Bounds-Queries einfuehren

Ziel: Die Karten-API darf nicht mehr alle StationRecords laden und danach in der
App-Schicht filtern.

- Neue DB-Query fuer sichtbare Stationsmarker mit Bounds-Filter ueber PostGIS.
  Status: erster Schritt umgesetzt ueber `listStationRecordsInBoundsDb()` fuer
  Kartenansicht und Routenkandidaten.
- Nur Marker-Felder ausliefern: ID, Koordinaten, Name, CPO, Leistung, Ladepunktzahl,
  grobe Verfuegbarkeit, bestes Preis-Summary, Freshness.
- Bestehende Detail-API fuer vollstaendige Station-Daten beibehalten.
- Response-Groesse und Query-Zeit messen.

Erfolgskriterium:

- `/api/public/stations/map` liest nur die Stationen im sichtbaren Ausschnitt.
- DB-Query nutzt raeumliche Indizes.
- Ergebnis ist deutlich kleiner als ein kompletter Stationsdump.

### Phase 3: Edge-Cache fuer Bounds- oder Tile-Responses

Ziel: Haeufige Kartenansichten sollen ohne DB-Hit beantwortet werden.

- Cache-Key nach Zoom/Tile oder normalisierten Bounds bilden.
  Status: erster Schritt umgesetzt. Die Karten-API bietet einen GET-Pfad mit
  kurzen Cache-Headern; der Client rundet Bounds nach aussen, damit aehnliche
  Kartenbewegungen dieselbe URL verwenden koennen.
- Filtergruppen in den Cache-Key aufnehmen, aber nur fuer stabile, haeufige Filter.
- Kurze TTL fuer statusnahe Daten nutzen.
- Versionierte Cache-Keys verwenden, damit Feed-Syncs betroffene Tiles gezielt
  invalidieren oder durch neue Versionen ersetzen koennen.

Empfohlener v1-Cache-Key:

```text
map:v1:z{zoom}:x{x}:y{y}:filters:{filterHash}:dataVersion:{version}
```

Erfolgskriterium:

- Kartenpunkte laden bei Cache-Hit ohne DB-Zugriff.
- Cache-Hit-Ratio ist messbar.
- Cache-Invalidierung nach Feed-Sync aktualisiert betroffene Tiles oder schaltet auf
  eine neue Datenversion um.

### Phase 4: Vorberechnete Map Tiles in R2/KV

Ziel: Kartenpunkte wie statische Assets ausliefern, nicht wie dynamische API-Daten.

- Tile-Dateien nach Feed-Sync oder periodisch erzeugen.
- R2 speichert groessere JSON- oder Vector-Tile-Dateien.
- KV speichert Manifest und aktive Tile-Version.
- Worker liest zuerst Manifest, dann Tile-Datei, und setzt CDN-Cache-Header.
- Level-of-detail je Zoomstufe definieren.

Erfolgskriterium:

- Die haeufigsten Karten-Requests treffen nur Cloudflare Cache/R2.
- Postgres bleibt fuer Ingest, Admin, Suche und Detaildaten zustaendig.
- Lastspitzen auf der Karte skalieren hauptsaechlich ueber Cloudflare.

### Phase 5: Kommerzieller Betrieb und Monitoring

Ziel: Die Plattform wird betreibbar, abrechenbar und belastbar.

- Rate Limits fuer Public APIs definieren.
- Observability fuer Worker, Cache-Hit-Ratio, DB-Query-Zeiten, Feed-Latenz und
  Webhook-Fehler einrichten.
- Lasttests mit realistischen Kartenbewegungen fahren.
- Kostenwarnungen und Budgets fuer Cloudflare, Postgres und optional Hosting setzen.
- Kommerzielle API-Nutzung spaeter ueber eigene API-Keys, Quotas und Terms absichern.

Erfolgskriterium:

- Lasttest-Ziel: 10.000 parallele Karten-Nutzer mit schnellen Marker-Responses.
- Feed-Ingest bleibt auch bei Kartenlast stabil.
- Kosten und Fehlerbilder sind im Betrieb sichtbar.

---

## 7. V1-Entscheidungen

Diese Entscheidungen gelten fuer die erste Umsetzung:

- Cloudflare Worker ersetzt Netlify Edge Function fuer gzip-Webhooks.
- `/api/public/stations/map` wird zuerst auf DB-seitige Bounds-Queries umgestellt.
- Danach kommt eine Tile- oder Bounds-Cache-Schicht vor die DB.
- Kartenpunkte erhalten kurze, versionierte Cache-Keys nach Zoom/Tile/Filtergruppe.
- Detaildaten bleiben separat und werden nicht in jedes Tile gepackt.
- Postgres/PostGIS bleibt die Master-Datenbank.
- Hetzner ist eine spaetere Kosten-/Performance-Option, aber kein erster
  Migrationsschritt.

---

## 8. Risiken und offene Punkte

### Next.js auf Cloudflare vs. Node-App separat

Es gibt zwei realistische Betriebsmodelle:

1. **Next.js-App separat betreiben, Cloudflare davor.**
   - Geringere Migrationstiefe.
   - Bestehende Node/Postgres-Logik kann bleiben.
   - Cloudflare uebernimmt Webhooks, Map-Cache und CDN.

2. **Next.js mit Cloudflare/OpenNext migrieren.**
   - Mehr Edge-Naehe.
   - Mehr Anpassungsrisiko durch Runtime-Unterschiede.
   - Muss separat auf Next.js-Kompatibilitaet, Postgres-Zugriff und Bundle-Groesse
     geprueft werden.

Empfehlung fuer v1: Next.js nicht sofort vollstaendig migrieren. Zuerst die
lastkritischen Pfade zu Cloudflare verschieben.

### Status- und Preisfrische

Live-Status und Preise koennen haeufig wechseln. Tiles duerfen deshalb nicht so
lange gecacht werden, dass Nutzer falsche Verfuegbarkeit oder Preise sehen.

Empfehlung:

- Static-Daten und Standort-Metadaten laenger cachen.
- Dynamic-Status und Preis-Summaries kurz cachen oder versioniert nach Sync
  aktualisieren.
- Detail-API kann frischere Daten liefern als die Kartenmarker.

### Cache-Invalidierung

Cache-Invalidierung darf nicht versuchen, alle denkbaren Bounds zu loeschen.
Stabiler ist ein versioniertes Manifest:

```text
activeMapVersion = 2026-04-27T12:30:00Z
tileKey = map:v1:z12:x2199:y1342:filters:default:dataVersion:activeMapVersion
```

Nach einem Feed-Sync wird eine neue Version fuer betroffene Tiles erzeugt oder die
globale aktive Version umgeschaltet.

### Datenbanklast

Auch mit Cloudflare bleibt Postgres kritisch fuer:

- Feed-Ingest und Upserts.
- Admin-UI.
- Detailabrufe.
- Cache-Miss-Pfade.

Deshalb braucht Postgres:

- raeumliche Indizes fuer Bounds-/Tile-Queries,
- kompakte Read-Models fuer Marker,
- Pooling,
- langsame Query-Logs,
- spaeter eventuell Read Replica fuer Public-Leseverkehr.

### Observability

Vor kommerzieller Nutzung muessen folgende Kennzahlen sichtbar sein:

- Worker Requests, Fehlerquote und Latenz.
- Cache-Hit-Ratio fuer Kartenpunkte.
- R2/KV Operationen und Kosten.
- Postgres Query-Zeiten und Connection-Auslastung.
- Feed-Sync-Dauer, Fehlerquote und letzte erfolgreiche Updates.
- Webhook-Latenz und Payload-Groessen.

---

## 9. Spaetere Kostenoption: Hetzner + Cloudflare

Falls maximale Preis/Leistung wichtiger wird als minimaler Betriebsaufwand, ist
**Hetzner + Cloudflare** eine sinnvolle spaetere Option:

- Hetzner kann Node-App, Ingest-Worker, Redis/Queue oder sogar Postgres sehr guenstig
  betreiben.
- Cloudflare bleibt fuer CDN, Edge-Worker, Schutz und Karten-Auslieferung davor.
- Der Betriebsaufwand steigt: Updates, Backups, Monitoring, Security-Hardening und
  Hochverfuegbarkeit liegen staerker beim Team.

Quelle fuer Traffic-Rahmenbedingungen:

- [Hetzner Traffic Docs](https://docs.hetzner.com/robot/general/traffic/)

Diese Option ist kein erster Schritt. Sie wird erst relevant, wenn die Cloudflare-
und Postgres-Architektur steht und die laufenden Kosten oder Performance-Anforderungen
eine eigene Server-Infrastruktur rechtfertigen.

---

## 10. Akzeptanzkriterien fuer die spaetere Umsetzung

Die Architektur gilt als erfolgreich umgesetzt, wenn:

- Kartenpunkte bei Cache-Hit ohne DB-Zugriff ausgeliefert werden.
- Mobilithek gzip Push ueber Cloudflare Worker stabil `200` liefert.
- Feed-Syncs betroffene Tiles aktualisieren oder ueber Versionierung sichtbar
  erneuern.
- Die Detail-API weiter gezielt einzelne Stationen laden kann.
- 10.000 parallele Karten-Nutzer schnelle Marker-Responses erhalten.
- Feed-Ingest, Admin-UI und Public-Karte unter Last getrennt beobachtbar bleiben.
- Kostenpfade fuer Worker, R2/KV, DB und Hosting messbar sind.
