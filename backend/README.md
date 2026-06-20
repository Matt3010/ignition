# Motorcycle Road Context Backend

Backend TypeScript per un assistente stradale audio per motociclisti. Riceve campioni GPS periodici dall'app iOS, esegue map matching con Valhalla, recupera limiti/contesto strada e restituisce alert statici rilevanti da PostgreSQL/PostGIS.

## Architettura

- `src/http`: Fastify, validazione Zod, OpenAPI, Swagger UI, errori normalizzati.
- `src/application`: use case `GetRoadContextUseCase` e porte applicative.
- `src/domain`: modelli, geodesia, parsing maxspeed, confidence, cache TTL, trace sessione in memoria.
- `src/infrastructure/valhalla`: client e provider map matching Valhalla.
- `src/infrastructure/repositories`: repository PostGIS e log import.
- `src/mock`: provider solo per test isolati; vietato in produzione.
- `migrations`: schema PostgreSQL/PostGIS.
- `scripts`: migrazioni, import alert OSM, download OSM, build tile Valhalla.

Il backend non salva permanentemente i campioni GPS utente. Mantiene solo una trace breve in memoria per sessione, configurata da `SESSION_TRACE_TTL_SECONDS`.

## Requisiti

- Node.js LTS 20+ o 22+
- Docker e Docker Compose
- PostgreSQL/PostGIS per modalità reale
- Tile Valhalla già costruite o volume Valhalla popolato

Compatibile con Linux, macOS, ARM64 e Raspberry Pi 4/5. Le immagini Compose usano `platform: linux/arm64/v8`.

## Installazione

```bash
cd backend
npm install
cp .env.example .env
npm run build
npm test
```

## Sviluppo Locale

```bash
npm run dev
```

Endpoint principali:

- `POST /api/v1/road-context`
- `GET /health`
- `GET /ready`
- `GET /api/v1/config`
- `GET /documentation`

## Modalità Reale

Il flusso operativo usa Valhalla, PostgreSQL/PostGIS e dati OpenStreetMap locali. `npm run test:drive` e `npm run test:drive:real` avviano guida reale simulata, non fixture alert.

Esempio API:

```bash
curl -X POST http://127.0.0.1:3000/api/v1/road-context \
  -H 'content-type: application/json' \
  -H 'x-road-context-scenario: limit70' \
  -d '{
    "latitude": 45.0,
    "longitude": 11.0,
    "speedKmh": 72.5,
    "course": 0,
    "horizontalAccuracyMeters": 6.0,
    "timestamp": "2026-06-17T20:30:00Z",
    "sessionId": "550e8400-e29b-41d4-a716-446655440000"
  }'
```

## Docker Compose Reale

```bash
cp .env.example .env
make up
make migrate
```

Servizi:

- `backend`: Fastify API
- `postgres`: PostgreSQL 16 + PostGIS
- `valhalla`: Valhalla con volume tile persistente

Il servizio reale richiede tile Valhalla nel volume configurato. `force_rebuild` è disattivato: il container non ricostruisce automaticamente dataset grandi.

## PostgreSQL/PostGIS

Migrazione principale:

- `road_alerts`: alert statici georiferiti con `geometry Point SRID 4326`
- `data_imports`: audit degli import

Comandi:

```bash
make migrate
```

La ricerca alert usa `ST_DWithin` e `ST_DistanceSphere`, filtra record inattivi/scaduti, considera direzione/bearing/roadId e ordina per distanza.

## Importazione Dati

`make seed` non inserisce fixture: importa alert statici dal file OSM locale `${OSM_DATA_DIR}/${OSM_REGION}.alerts.osm` generato da `npm run osm:download`. In fallback legge `${OSM_DATA_DIR}/${OSM_REGION}.osm`.

Formati supportati:

- CSV
- GeoJSON
- OSM XML `.osm` reale filtrato da estratto OSM

Import OSM reale:

```bash
OSM_REGION=italy \
DATABASE_URL=postgres://road:road@127.0.0.1:5433/road_context \
npm run import:osm-alerts
```

Oppure file esplicito:

```bash
DATABASE_URL=postgres://road:road@127.0.0.1:5433/road_context \
npm run import:osm-alerts -- --file data/osm/italy.alerts.osm
```

Il parser OSM importa solo dati statici realmente presenti:

- `highway=speed_camera` o relation `enforcement=maxspeed` -> `fixedSpeedCamera`
- `highway=construction` o `construction=*` -> `roadWorks`
- `hazard=*` -> `roadHazard`

Converte `maxspeed`, anche `mph`, fa upsert e registra l'import in `data_imports` con `bbox`, `file_path` e `deactivated_count`. Non inventa alert: se OSM non contiene autovelox/lavori/pericoli nell'estratto, l'import produce 0 record.

Per default l'import OSM fa invalidation sull'area coperta dai record importati: gli alert `source=osm` attivi nella stessa area ma assenti nel nuovo estratto vengono marcati `active=false`. Questo evita dati vecchi quando OSM cambia. Per disattivare temporaneamente:

```bash
OSM_ALERT_DEACTIVATE_STALE=false npm run import:osm-alerts
```

Per rimuovere dal DB locale vecchi alert non OSM creati da fixture o seed precedenti:

```bash
DATABASE_URL=postgres://road:road@127.0.0.1:5433/road_context \
npm run alerts:purge-non-osm
```

## OpenStreetMap e Valhalla

Il flusso principale usa un estratto OSM stabile, non bbox scaricate durante la guida. Di default scarica Italia completa da Geofabrik:

```bash
npm run osm:download
```

Preset supportati: `italy`, `france`, `germany`, `spain`, `switzerland`, `austria`, `slovenia`, `croatia`.

Per un altro stato o una macro-regione Geofabrik:

```bash
OSM_EXTRACT_PRESET=france OSM_REGION=france npm run osm:download
```

Oppure URL esplicito:

```bash
OSM_REGION=custom \
OSM_EXTRACT_URL=https://download.geofabrik.de/europe/monaco-latest.osm.pbf \
npm run osm:download
```

Il download produce:

- `${OSM_DATA_DIR}/${OSM_REGION}.osm.pbf` per Valhalla
- `${OSM_DATA_DIR}/${OSM_REGION}.alerts.osm` filtrato per import alert statici

Costruire tile Valhalla:

```bash
OSM_DATA_DIR=./data/osm \
VALHALLA_TILE_DIR=./data/valhalla \
OSM_REGION=italy \
npm run valhalla:build
```

Flusso completo consigliato:

```bash
npm run osm:download
npm run valhalla:build
docker compose up -d postgres valhalla
DATABASE_URL=postgres://road:road@127.0.0.1:5433/road_context npm run migrate
DATABASE_URL=postgres://road:road@127.0.0.1:5433/road_context npm run import:osm-alerts
docker compose up -d backend
```

Aggiornamento automatico ogni 24 ore:

```bash
docker compose --profile maintenance up -d osm-refresh
```

Il servizio `osm-refresh` esegue `npm run osm:refresh:loop`: dorme `OSM_REFRESH_INTERVAL_SECONDS` secondi, default `86400`, poi scarica il nuovo estratto, ricostruisce le tile in staging, importa gli alert e riavvia Valhalla. Per eseguire un refresh anche all'avvio:

```bash
OSM_REFRESH_RUN_ON_START=true docker compose --profile maintenance up -d osm-refresh
```

Refresh manuale:

```bash
DATABASE_URL=postgres://road:road@127.0.0.1:5433/road_context npm run osm:refresh
```

## Test Di Guida Continuo

Test di guida reale: GPS simulato lungo una route Valhalla, provider reali, PostGIS e tile già preparate. `npm run test:drive` è reale quanto `npm run test:drive:real`. Non invia scenari debug e fallisce se `/ready` non è pronto.

```bash
DATABASE_URL=postgres://road:road@127.0.0.1:5433/road_context \
VALHALLA_BASE_URL=http://127.0.0.1:8002 \
DRIVE_SOAK_START_LAT=45.45 \
DRIVE_SOAK_START_LON=11.90 \
npm run test:drive:real
```

Comando equivalente:

```bash
npm run test:drive
```

Il test stampa eventi leggibili durante la guida:

- route Valhalla caricata o fallback a simulazione libera;
- fermata e ripartenza;
- svolte e inversioni;
- cambio strada;
- limite corrente e superamento limite;
- alert piu vicino;
- strada non agganciata o confidence bassa.

Quando lo interrompi con `Ctrl-C`, stampa il riepilogo finale con km percorsi, tempo guida simulato, velocita media, velocita massima, match rate, fermate, svolte, cambi strada, superamenti limite, alert e latenze.

Ogni run salva anche file di debug:

- `reports/drive-soak/*.jsonl`: eventi uno per riga, inclusi campioni GPS, strada, limite, alert, confidence e latenza.
- `reports/drive-soak/*.summary.json`: riepilogo finale con breakdown per strada, limite, alert e unmatched.
- `reports/drive-soak/*.geojson`: LineString percorso + punti campione con contesto strada.
- `reports/drive-soak/*.gpx`: traccia GPX apribile in strumenti GIS/navigazione.

Per cambiare directory:

```bash
DRIVE_SOAK_REPORT_DIR=/tmp/drive-report npm run test:drive:real
```

Per ottenere il vecchio formato JSON machine-readable:

```bash
DRIVE_SOAK_OUTPUT=json npm run test:drive:real
```

Per smoke test finito:

```bash
DRIVE_SOAK_MAX_ITERATIONS=100 \
DRIVE_SOAK_DELAY_MS=0 \
DRIVE_SOAK_MIN_MATCH_RATE=0.7 \
npm run test:drive:real
```

Per non partire sempre dalla stessa strada, lascia attivo il jitter di partenza o cambiane il raggio:

```bash
DATABASE_URL=postgres://road:road@127.0.0.1:5433/road_context \
VALHALLA_BASE_URL=http://127.0.0.1:8002 \
DRIVE_SOAK_DELAY_MS=0 \
DRIVE_SOAK_START_JITTER_METERS=1000 \
DRIVE_SOAK_MAX_ITERATIONS=300 \
npm run test:drive:real
```

`DRIVE_SOAK_START_JITTER_METERS` sposta la partenza entro quel raggio e poi il warm-up cerca una strada agganciabile. Con `DRIVE_SOAK_SEED` fisso il punto resta deterministico; senza seed cambia a ogni run.

Se il backend reale è già avviato:

```bash
DRIVE_SOAK_REAL=true \
DRIVE_SOAK_BASE_URL=http://127.0.0.1:3000 \
npm run test:drive
```

Coordinate configurabili:

- `DRIVE_SOAK_START_LAT`
- `DRIVE_SOAK_START_LON`
- `DRIVE_SOAK_START_JITTER_METERS`
- `DRIVE_SOAK_ROUTE_TARGET_METERS`
- `DRIVE_SOAK_MIN_LAT`
- `DRIVE_SOAK_MAX_LAT`
- `DRIVE_SOAK_MIN_LON`
- `DRIVE_SOAK_MAX_LON`

Queste coordinate devono cadere dentro le tile Valhalla preparate.

Per Raspberry Pi è consigliato costruire le tile su una macchina più potente e trasferire `VALHALLA_TILE_DIR` sul Raspberry, evitando build pesanti direttamente sul dispositivo.

Aggiornamenti periodici: configurare `OSM_UPDATE_CRON`, scaricare nuovo estratto, ricostruire tile offline, poi sostituire il volume Valhalla durante una finestra controllata.

## Confidence

La confidence finale è normalizzata tra 0 e 1 e considera:

- distanza tra punto GPS e segmento;
- accuratezza GPS;
- coerenza del course rispetto al bearing strada;
- continuità con il segmento precedente;
- qualità del risultato Valhalla;
- penalità per alternative vicine su strade parallele.

La logica di continuità vive in memoria e riduce oscillazioni tra carreggiate parallele, complanari e rampe.

## Limiti di Velocità

Il backend usa il dato OSM/Valhalla quando disponibile:

- numerico;
- `km/h` o `kph`;
- `mph`, convertito in km/h;
- impliciti italiani `IT:urban`, `IT:rural`, `IT:trunk`, `IT:motorway`;
- limiti condizionali semplici quando il valore è interpretabile.

Se il limite è assente, variabile o non affidabile, `speedLimitKmh` è `null`. I limiti impliciti vengono normalizzati solo quando arrivano come tag OSM/Valhalla esplicito.

## Sicurezza e Privacy

- Validazione Zod rigorosa.
- Payload limit configurabile.
- Rate limiting per IP/sessione.
- Helmet e CORS configurabile.
- Errori normalizzati senza stack trace in produzione.
- Query SQL parametrizzate.
- Log JSON pino con `requestId`.
- `sessionId` anonimizzato nei log.
- Coordinate complete redatte in produzione.
- Nessun salvataggio permanente del percorso GPS.

## Test

```bash
make test
make lint
make build
```

I test non richiedono servizi Internet. Coprono validazione, geodesia, maxspeed, confidence, continuità, cache, filtri alert, provider Valhalla in errore, HTTP mock, OpenAPI e query PostGIS.

## Raspberry Pi

Procedura consigliata: preparare estratto OSM, tile Valhalla e import alert prima di avviare il backend. Su Raspberry conviene costruire le tile su una macchina più potente e poi trasferire `data/valhalla`.

Avvio su Raspberry:

```bash
cd ~/road-context/backend
cp .env.example .env
docker compose -f docker-compose.yml up -d --build postgres valhalla backend
docker compose -f docker-compose.yml exec backend node dist/scripts/migrate.js
```

Smoke test da host o Raspberry:

```bash
SMOKE_BASE_URL=http://127.0.0.1:3000 \
SMOKE_LAT=44.9646356 \
SMOKE_LON=10.9995592 \
npm run raspberry:smoke
```

Se lo esegui dentro container backend:

```bash
docker compose exec backend node dist/scripts/raspberry-smoke.js
```

Note Raspberry:

- Tenere `force_rebuild=false` su Valhalla.
- Usare SSD/USB affidabile per `postgres-data` e tile Valhalla se la SD e lenta.

## Variabili Principali

Vedere `.env.example`. Le più importanti:

- `ROAD_CONTEXT_PROVIDER=valhalla` per flusso reale. `mock` e consentito solo in test/non-produzione.
- `DATABASE_URL`
- `VALHALLA_BASE_URL`
- `VALHALLA_TIMEOUT_MS`
- `ALERT_SEARCH_RADIUS_METERS`
- `ALERT_DIRECTION_TOLERANCE_DEGREES`
- `ALERT_UNASSIGNED_RADIUS_METERS`
- `ALERT_UNMATCHED_RADIUS_METERS`
- `SESSION_TRACE_TTL_SECONDS`
- `CACHE_TTL_SECONDS`
- `MAX_GPS_ACCURACY_METERS`
- `OSM_EXTRACT_PRESET`
- `OSM_EXTRACT_URL`
- `OSM_REGION`
- `OSM_DATA_DIR`
- `VALHALLA_TILE_DIR`
- `OSM_REFRESH_INTERVAL_SECONDS`
- `OSM_REFRESH_RUN_ON_START`
- `OSM_REFRESH_RESTART_VALHALLA`

## Limiti Noti MVP

- I dati OpenStreetMap possono essere incompleti o non aggiornati.
- `speedLimitKmh` può essere `null`.
- Alert dinamici live non sono disponibili senza una fonte autorizzata esterna.
- L'MVP gestisce soprattutto autovelox fissi e dati statici (`fixedSpeedCamera`, `roadHazard`, `roadWorks`).
- Il parsing dei limiti condizionali è conservativo.
- La qualità del map matching dipende dalle tile Valhalla e dal dato OSM disponibile.
- Fuori dall'area dell'estratto preparato il map matching non può funzionare.

## Troubleshooting

- `ready` restituisce 503: controllare PostgreSQL, migrazioni e `/status` Valhalla.
- Nessun limite velocità: il dato OSM/Valhalla è assente o non interpretabile.
- Nessun alert: verificare raggio, direzione, `active`, `valid_until`, `road_id`.
- Valhalla timeout: aumentare `VALHALLA_TIMEOUT_MS` o verificare risorse CPU/RAM.
- Raspberry lento nella build tile: costruire tile altrove e trasferirle.
