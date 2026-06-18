# Motorcycle Road Context Backend

Backend TypeScript per un assistente stradale audio per motociclisti. Riceve campioni GPS periodici dall'app iOS, esegue map matching con Valhalla, recupera limiti/contesto strada e restituisce alert statici rilevanti da PostgreSQL/PostGIS.

## Architettura

- `src/http`: Fastify, validazione Zod, OpenAPI, Swagger UI, errori normalizzati.
- `src/application`: use case `GetRoadContextUseCase` e porte applicative.
- `src/domain`: modelli, geodesia, parsing maxspeed, confidence, cache TTL, trace sessione in memoria.
- `src/infrastructure/valhalla`: client e provider map matching Valhalla.
- `src/infrastructure/repositories`: repository PostGIS e log import.
- `src/mock`: provider deterministico senza PostgreSQL e senza Valhalla.
- `migrations`: schema PostgreSQL/PostGIS.
- `scripts`: migrazioni, seed, import alert, download OSM, build tile Valhalla.

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
- `GET /api/v1/tile-prefetch/status`
- `GET /documentation`

## Modalità Mock

La modalità mock non richiede PostgreSQL o Valhalla:

```bash
ROAD_CONTEXT_PROVIDER=mock npm run dev
```

Con Docker:

```bash
make mock-up
```

Scenari debug supportati via header `x-road-context-scenario` fuori produzione:

- `limit50`
- `limit70`
- `lowConfidence`
- `matchedFalse`
- `timeout`
- `httpError`
- `slow`
- `nullLimit`
- `parallelRoad`
- `staleData`

Esempio:

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
make seed
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
make seed
```

La ricerca alert usa `ST_DWithin` e `ST_DistanceSphere`, filtra record inattivi/scaduti, considera direzione/bearing/roadId e ordina per distanza.

## Importazione Dati

Formati supportati:

- CSV
- GeoJSON
- dati OSM esportati/convertiti in GeoJSON compatibile, ad esempio con tag `highway=speed_camera`, `maxspeed`, `direction`, `bearing`, `roadId`

Esempi in `tests/fixtures/alerts.csv` e `tests/fixtures/alerts.geojson`.

```bash
npm run import:alerts -- --file tests/fixtures/alerts.geojson --source fixture --version 2026-06-18
```

Lo script valida coordinate/tipi, normalizza tipi alert, converte `maxspeed` anche da mph, fa upsert e registra l'import in `data_imports`. Non cancella dati validi.

## OpenStreetMap e Valhalla

Scaricare un estratto regionale, per esempio Nord-Est/Veneto:

```bash
OSM_EXTRACT_URL=https://download.geofabrik.de/europe/italy/nord-est-latest.osm.pbf \
OSM_REGION=veneto \
npm run osm:download
```

Per sviluppo o test non serve partire da una regione intera. Si può ritagliare una bounding box piccola e costruire tile solo per quella zona:

```bash
OSM_EXTRACT_URL=https://download.geofabrik.de/europe/italy/nord-est-latest.osm.pbf \
OSM_REGION=veneto-test \
OSM_BBOX=11.80,45.35,12.10,45.55 \
npm run osm:bbox
```

`OSM_BBOX` usa il formato `minLon,minLat,maxLon,maxLat`. Lo script usa `osmium` se installato, altrimenti prova il container `ghcr.io/osmcode/osmium-tool`. Questo evita di compilare tile per aree grandi, ma Valhalla richiede comunque tile locali già costruite: non è pensato per scaricare dati OSM a ogni richiesta GPS.

Per scaricare solo la bbox richiesta, senza prima scaricare un estratto regionale:

```bash
OSM_REGION=bbox-test \
OSM_BBOX=10.995,44.995,11.010,45.010 \
npm run osm:bbox:direct
```

Questo usa l'endpoint pubblico OpenStreetMap `/api/0.6/map`, adatto solo a bbox piccole. Per aree più grandi usare estratti regionali Geofabrik + `npm run osm:bbox`.

Costruire tile Valhalla:

```bash
OSM_DATA_DIR=./data/osm \
VALHALLA_TILE_DIR=./data/valhalla \
OSM_REGION=veneto \
npm run valhalla:build
```

## Prefetch Tile Operativo

In modalità reale il backend usa sempre il prefetch tile. Quando riceve un campione GPS garantisce prima il chunk corrente, poi chiama Valhalla; dopo la risposta accoda in background i chunk successivi davanti alla moto.

Il prefetch operativo usa lo stesso flusso reale dei test a chunk:

```txt
GPS ricevuto
  -> ensure bbox corrente
  -> download OSM bbox se manca
  -> conversione PBF se manca
  -> build tile Valhalla se manca
  -> riavvio opzionale Valhalla sul chunk corrente
  -> map matching Valhalla
  -> risposta API
  -> prefetch asincrono dei chunk di lookahead
```

Per sviluppo host, con PostgreSQL e Valhalla in Docker:

```bash
TILE_PREFETCH_RESTART_VALHALLA=true \
ROAD_CONTEXT_PROVIDER=valhalla \
DATABASE_URL=postgres://road:road@127.0.0.1:5433/road_context \
VALHALLA_BASE_URL=http://127.0.0.1:8002 \
npm run dev
```

Stato del worker:

```bash
curl http://127.0.0.1:3000/api/v1/tile-prefetch/status
```

Prefetch manuale di una bbox:

```bash
OSM_REGION=prefetch-smoke \
OSM_BBOX=10.995,44.995,11.005,45.005 \
VALHALLA_TILE_DIR=./data/valhalla-prefetch/prefetch-smoke \
TILE_PREFETCH_RESTART_VALHALLA=false \
npm run valhalla:prefetch
```

Dry run senza rete/Docker:

```bash
OSM_REGION=smoke \
OSM_BBOX=10.990000,44.990000,11.010000,45.010000 \
TILE_PREFETCH_DRY_RUN=true \
npm run valhalla:prefetch
```

Variabili principali:

- `TILE_PREFETCH_HALF_LAT` / `TILE_PREFETCH_HALF_LON`: dimensione della bbox attorno al centro chunk.
- `TILE_PREFETCH_GRID_DEGREES`: snap della posizione per evitare rebuild ogni pochi metri.
- `TILE_PREFETCH_LOOKAHEAD_CHUNKS`: quanti chunk futuri pianificare in base al course.
- `TILE_PREFETCH_LOOKAHEAD_METERS`: distanza tra chunk futuri.
- `TILE_PREFETCH_MIN_INTERVAL_SECONDS`: anti-rebuild sullo stesso chunk.
- `TILE_PREFETCH_MAX_QUEUE`: limite della coda locale.
- `TILE_PREFETCH_RESTART_VALHALLA`: se `true`, riavvia Valhalla sul tile appena costruito.

Nota operativa: se il backend gira dentro Docker in modalità reale, il container deve avere accesso a Docker CLI/socket per costruire e riavviare Valhalla. La modalità più semplice per sviluppo è backend su host e PostgreSQL/Valhalla in Compose. Il primo ingresso in un chunk mai costruito può impiegare diversi secondi perché prepara dati reali; i chunk successivi vengono preparati in anticipo dal lookahead.

## Test Di Guida Continuo

Test mock infinito, senza Valhalla/PostGIS:

```bash
npm run test:drive
```

Test di guida reale: GPS simulato, provider reali e prefetch automatico. Usa `ROAD_CONTEXT_PROVIDER=valhalla`, PostgreSQL/PostGIS e Valhalla. Non invia scenari debug e fallisce se `/ready` non è pronto.

```bash
DATABASE_URL=postgres://road:road@127.0.0.1:5433/road_context \
VALHALLA_BASE_URL=http://127.0.0.1:8002 \
DRIVE_SOAK_START_LAT=45.45 \
DRIVE_SOAK_START_LON=11.90 \
npm run test:drive:real
```

Per smoke test finito:

```bash
DRIVE_SOAK_MAX_ITERATIONS=100 \
DRIVE_SOAK_DELAY_MS=0 \
DRIVE_SOAK_MIN_MATCH_RATE=0.7 \
npm run test:drive:real
```

Se il backend reale è già avviato:

```bash
DRIVE_SOAK_REAL=true \
DRIVE_SOAK_BASE_URL=http://127.0.0.1:3000 \
npm run test:drive
```

Coordinate configurabili:

- `DRIVE_SOAK_START_LAT`
- `DRIVE_SOAK_START_LON`
- `DRIVE_SOAK_MIN_LAT`
- `DRIVE_SOAK_MAX_LAT`
- `DRIVE_SOAK_MIN_LON`
- `DRIVE_SOAK_MAX_LON`

Queste coordinate devono cadere dentro le tile Valhalla preparate.

Test reale a chunk dinamici: scarica una bbox piccola, costruisce tile Valhalla per quel chunk, riavvia Valhalla, guida dentro il chunk, poi passa alla bbox successiva. Se `DRIVE_CHUNK_MAX_CHUNKS` non è impostato continua finché viene interrotto.

```bash
DATABASE_URL=postgres://road:road@127.0.0.1:5433/road_context \
VALHALLA_BASE_URL=http://127.0.0.1:8002 \
DRIVE_CHUNK_START_LAT=45.000 \
DRIVE_CHUNK_START_LON=11.000 \
DRIVE_CHUNK_STEP_LAT=0.006 \
DRIVE_CHUNK_HALF_LAT=0.010 \
DRIVE_CHUNK_HALF_LON=0.010 \
DRIVE_CHUNK_ITERATIONS=30 \
DRIVE_CHUNK_PAUSE_SECONDS=10 \
npm run test:drive:real:chunks
```

Per un infinito robusto su aree poco stradali lascia `DRIVE_CHUNK_MIN_MATCH_RATE` a `0`. Impostalo sopra zero solo quando vuoi fallire se una bbox non produce abbastanza match.

Smoke test finito:

```bash
DRIVE_CHUNK_MAX_CHUNKS=2 \
DRIVE_CHUNK_ITERATIONS=10 \
DRIVE_CHUNK_DELAY_MS=0 \
npm run test:drive:real:chunks
```

Dry run senza download/build:

```bash
DRIVE_CHUNK_DRY_RUN=true DRIVE_CHUNK_MAX_CHUNKS=3 npm run test:drive:real:chunks
```

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
- limiti condizionali semplici quando il valore è interpretabile.

Se il limite è assente, variabile o non affidabile, `speedLimitKmh` è `null`. Non vengono inventati limiti impliciti.

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

Procedura consigliata:

1. Build Docker multi-arch su macchina di sviluppo o direttamente sul Raspberry.
2. Preparare tile Valhalla fuori dal Raspberry se l'estratto è grande.
3. Copiare tile nel volume o bind mount configurato.
4. Avviare `docker compose up -d`.
5. Eseguire `docker compose exec backend node dist/scripts/migrate.js`.
6. Importare alert statici.

## Variabili Principali

Vedere `.env.example`. Le più importanti:

- `ROAD_CONTEXT_PROVIDER=mock|valhalla`
- `DATABASE_URL`
- `VALHALLA_BASE_URL`
- `VALHALLA_TIMEOUT_MS`
- `ALERT_SEARCH_RADIUS_METERS`
- `ALERT_DIRECTION_TOLERANCE_DEGREES`
- `SESSION_TRACE_TTL_SECONDS`
- `CACHE_TTL_SECONDS`
- `MAX_GPS_ACCURACY_METERS`
- `TILE_PREFETCH_HALF_LAT`
- `TILE_PREFETCH_HALF_LON`
- `TILE_PREFETCH_LOOKAHEAD_CHUNKS`
- `TILE_PREFETCH_LOOKAHEAD_METERS`
- `TILE_PREFETCH_RESTART_VALHALLA`

## Limiti Noti MVP

- I dati OpenStreetMap possono essere incompleti o non aggiornati.
- `speedLimitKmh` può essere `null`.
- Alert dinamici live non sono disponibili senza una fonte autorizzata esterna.
- L'MVP gestisce soprattutto autovelox fissi e dati statici (`fixedSpeedCamera`, `roadHazard`, `roadWorks`).
- Il parsing dei limiti condizionali è conservativo.
- La qualità del map matching dipende dalle tile Valhalla e dal dato OSM disponibile.
- Il prefetch runtime costruisce bbox piccole. Per copertura regionale stabile restano consigliate tile preparate offline.

## Troubleshooting

- `ready` restituisce 503: controllare PostgreSQL, migrazioni e `/status` Valhalla.
- Nessun limite velocità: il dato OSM/Valhalla è assente o non interpretabile.
- Nessun alert: verificare raggio, direzione, `active`, `valid_until`, `road_id`.
- Valhalla timeout: aumentare `VALHALLA_TIMEOUT_MS` o verificare risorse CPU/RAM.
- Raspberry lento nella build tile: costruire tile altrove e trasferirle.
