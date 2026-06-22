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

Il flusso operativo usa Valhalla, PostgreSQL/PostGIS e dati OpenStreetMap locali.

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

La ricerca alert usa `ST_DWithin` e `ST_DistanceSphere`, restituisce tutti i record nel raggio (anche non operativi o non più presenti nell’ultimo import), esclude soltanto quelli confermati dietro al veicolo e ordina per distanza.

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

- `highway=speed_camera`, `enforcement=maxspeed` e `enforcement=average_speed` -> `fixedSpeedCamera`
- le equivalenti forme lifecycle (`disused:*`, `abandoned:*`, `removed:*`, `demolished:*`, `razed:*`) vengono importate, normalizzate e marcate `notOperational`, conservando i tag OSM originali
- `enforcement=traffic_signals` -> `redLightCamera`
- `traffic_signals=red_light_camera` -> `redLightCamera` (anche senza `enforcement=*`)
- `enforcement=access` -> `accessControl`
- `enforcement=maxweight` -> `weightControl`
- altri `enforcement=*` -> `genericEnforcement`
- `highway=construction`, `highway=roadworks` o `roadworks=yes` -> `roadWorks`
- `hazard=*` -> `roadHazard`

Converte `maxspeed`, anche `mph`, fa upsert e registra l'import in `data_imports` con `bbox`, `file_path` e `deactivated_count`. Non inventa alert: se OSM non contiene autovelox/lavori/pericoli nell'estratto, l'import produce 0 record.

Per default l'import OSM fa invalidation sull'area coperta dai record importati: gli alert `source=osm` attivi nella stessa area ma assenti nel nuovo estratto vengono marcati `active=false`. Questo evita dati vecchi quando OSM cambia. Per disattivare temporaneamente:

```bash
OSM_ALERT_DEACTIVATE_STALE=false npm run import:osm-alerts
```

Per rimuovere dal DB locale vecchi alert non OSM creati da fixture o seed precedenti:

```bash
DATABASE_URL=postgres://road:road@127.0.0.1:5433/road_context \
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

Il servizio `osm-refresh` esegue `npm run osm:refresh:loop`: dorme `OSM_REFRESH_INTERVAL_SECONDS` secondi, default `86400`, poi scarica e valida il nuovo estratto, ricostruisce le tile in staging, le attiva mantenendo stabile il mount di Valhalla, importa gli alert e applica rollback delle tile se una fase critica fallisce. Per eseguire un refresh anche all'avvio:

```bash
OSM_REFRESH_RUN_ON_START=true docker compose --profile maintenance up -d osm-refresh
```

Refresh manuale:

```bash
DATABASE_URL=postgres://road:road@127.0.0.1:5433/road_context npm run osm:refresh
```

Per Raspberry Pi è consigliato costruire le tile su una macchina più potente e trasferire `VALHALLA_TILE_DIR` sul Raspberry, evitando build pesanti direttamente sul dispositivo.

Aggiornamenti periodici: configurare `OSM_REFRESH_INTERVAL_SECONDS`; il refresh usa staging e rollback automatico.

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
```

Il container `backend` applica automaticamente le migration tracciate prima di avviare l’API. Le migration già applicate vengono saltate e una modifica successiva a un file già eseguito viene rifiutata tramite checksum.

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
- `ALERT_BEHIND_MIN_ANGLE_DEGREES`
- `ALERT_BEHIND_IMMEDIATE_ANGLE_DEGREES`
- `ALERT_BEHIND_MIN_SPEED_KMH`
- `ALERT_BEHIND_MAX_GPS_ACCURACY_METERS`
- `ALERT_BEHIND_MIN_DISTANCE_INCREASE_METERS`
- `SESSION_TRACE_TTL_SECONDS`
- `MAX_GPS_ACCURACY_METERS`
- `MAX_SAMPLE_AGE_SECONDS`
- `MAX_SAMPLE_FUTURE_SECONDS`
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


### Protezione import OSM

Gli import con disattivazione degli alert mancanti rifiutano dataset vuoti o cali anomali. Le soglie sono configurabili con `OSM_IMPORT_MIN_RETAIN_RATIO` e `OSM_IMPORT_MIN_EXISTING_FOR_RATIO_CHECK`.
