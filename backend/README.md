# Motorcycle Road Context Backend

Backend TypeScript per un assistente stradale audio per motociclisti. Riceve campioni GPS periodici dall'app iOS, esegue map matching con Valhalla, recupera limiti/contesto strada e restituisce alert statici rilevanti da PostgreSQL/PostGIS.

## Architettura

- `src/http`: Fastify, validazione Zod, OpenAPI, Swagger UI, errori normalizzati.
- `src/application`: use case `GetRoadContextUseCase` e porte applicative.
- `src/domain`: modelli, geodesia, parsing maxspeed, confidence, cache TTL, trace sessione in memoria.
- `src/infrastructure/valhalla`: client e provider map matching Valhalla.
- `src/infrastructure/repositories`: repository PostGIS e log import.
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

`make seed` non inserisce fixture: importa gli alert statici dai file `${OSM_DATA_DIR}/<regione>.alerts.osm` generati da `npm run osm:download` per tutte le regioni elencate in `OSM_REGIONS`.

Formati supportati:

- CSV
- GeoJSON
- OSM XML `.osm` reale filtrato da estratto OSM

Import OSM reale:

```bash
OSM_REGIONS=italy,france \
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

Per una o più regioni Geofabrik:

```bash
OSM_REGIONS=italy,france,switzerland npm run osm:download
```

Il download produce, per ogni regione configurata:

- `${OSM_DATA_DIR}/<regione>.osm.pbf` per Valhalla
- `${OSM_DATA_DIR}/<regione>.alerts.osm` filtrato per import alert statici

Costruire tile Valhalla:

```bash
OSM_DATA_DIR=./data/osm \
VALHALLA_TILE_DIR=./data/valhalla \
OSM_REGIONS=italy,france \
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

Il servizio `osm-refresh` esegue `npm run osm:refresh:loop`. Se le tile non esistono ancora, esegue automaticamente un bootstrap immediato; altrimenti rispetta `OSM_REFRESH_RUN_ON_START` e poi attende `OSM_REFRESH_INTERVAL_SECONDS`, default `432000`, tra un ciclo e il successivo. Ogni refresh scarica e valida il nuovo estratto, ricostruisce le tile in staging, le attiva mantenendo stabile il mount di Valhalla, attende che `/status` torni healthy, importa gli alert e applica rollback delle tile se una fase critica fallisce.
Gli stessi eventi visibili con `docker compose logs -f osm-refresh` vengono salvati anche in `reports/osm-refresh/osm-refresh.log`; all'avvio il file viene ruotato se supera `OSM_REFRESH_LOG_MAX_BYTES`, mantenendo fino a `OSM_REFRESH_LOG_MAX_FILES` copie.

```bash
OSM_REFRESH_RUN_ON_START=true docker compose --profile maintenance up -d osm-refresh
```

Il maintenance dipende da PostgreSQL healthy e dalla sola creazione del container Valhalla, non dalla sua health. Questo evita il deadlock del primo avvio quando le tile non sono ancora presenti. I timeout sono configurabili con `VALHALLA_HEALTH_TIMEOUT_SECONDS` e `VALHALLA_HEALTH_INTERVAL_SECONDS`; `OSM_REFRESH_LOCK_STALE_SECONDS` controlla il recupero dei lock orfani.

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

Vedere `.env.example`. Le più importanti (il provider reale, host del container, riavvio Valhalla e import alert sono ora fissi e non configurabili):

- `DATABASE_URL`
- `VALHALLA_BASE_URL`
- `VALHALLA_TIMEOUT_MS`
- `ALERT_SEARCH_RADIUS_METERS`
- `GENERIC_ALERT_SEARCH_RADIUS_METERS` (default `10000`, used for unfiltered map markers)
- `ALERT_BEHIND_MIN_ANGLE_DEGREES`
- `ALERT_BEHIND_IMMEDIATE_ANGLE_DEGREES`
- `ALERT_BEHIND_MIN_SPEED_KMH`
- `ALERT_BEHIND_MAX_GPS_ACCURACY_METERS`
- `ALERT_BEHIND_MIN_DISTANCE_INCREASE_METERS`
- `SESSION_TRACE_TTL_SECONDS`
- `MAX_GPS_ACCURACY_METERS`
- `MAX_SAMPLE_AGE_SECONDS`
- `MAX_SAMPLE_FUTURE_SECONDS`
- `OSM_REGIONS`
- `OSM_DATA_DIR`
- `VALHALLA_TILE_DIR`
- `OSM_REFRESH_INTERVAL_SECONDS`
- `OSM_REFRESH_RUN_ON_START`

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

## GitHub Actions

Il repository include un solo workflow in `.github/workflows`:

- `ci.yml`: esegue su push, pull request e avvio manuale i controlli statici, i test ordinari, PostgreSQL/PostGIS reale e una build/map-matching Valhalla reale su Monaco. La pubblicazione GHCR dipende da tutti questi job.

Il precedente `integration.yml` è stato rimosso per evitare duplicazioni: tutti i controlli automatici, inclusi quelli reali, sono concentrati nella CI principale.

I test live restano esclusi dalla suite locale normale e vengono abilitati esplicitamente tramite:

```bash
RUN_DB_INTEGRATION=1 DATABASE_URL=postgres://road:road@127.0.0.1:5432/road_context \
  npm run test:postgis

RUN_VALHALLA_INTEGRATION=1 VALHALLA_BASE_URL=http://127.0.0.1:8002 \
  npm run test:valhalla
```

Il job Valhalla scarica e valida dati OSM reali, costruisce e impacchetta tile reali, avvia Valhalla, esegue i test full-stack, i guasti infrastrutturali e di rete, quindi prova un refresh completo prima di consentire la pubblicazione GHCR.

## Multiple OSM regions

The maintenance pipeline can download and build multiple Geofabrik extracts in one refresh.
Set a comma-separated list:

```env
OSM_REGIONS=italy,france,switzerland
```

On the first bootstrap and every scheduled refresh the service:

1. downloads every configured extract;
2. creates one filtered alert file per region;
3. builds one Valhalla tile set from all PBF files in a single command;
4. imports all alert files in one atomic synchronization, so alerts from one region are not deactivated while another region is imported.

`OSM_REGIONS` is the only region configuration. Custom extract URLs are intentionally unsupported so every configured area follows the same reproducible Geofabrik workflow.

## Immagine Docker pubblicata da GitHub Actions

Solo dopo che `Backend checks`, `Swift syntax`, `PostgreSQL/PostGIS integration` e `Valhalla real map matching` sono passati, il workflow CI pubblica automaticamente un'immagine multi-architettura su GitHub Container Registry:

```text
ghcr.io/<owner>/<repository>:latest
```

Sono pubblicati anche i tag della branch, `sha-<commit>` e i tag SemVer quando viene creato un tag Git come `v1.2.3`. L'immagine supporta `linux/amd64` e `linux/arm64` e viene usata sia dal backend sia dal servizio `osm-refresh`.

Per effettuare il deploy senza compilare i sorgenti:

```bash
cp .env.registry.example .env
# modifica IGNITION_IMAGE con il percorso reale del package GHCR
docker compose -f docker-compose.registry.yml pull
docker compose -f docker-compose.registry.yml up -d
```

Il file `docker-compose.registry.yml` usa soltanto immagini precompilate: l'immagine Ignition pubblicata dal workflow, PostGIS e Valhalla. Non richiede Node.js né il repository completo sulla macchina di destinazione; servono soltanto il file Compose, il file `.env` e Docker.

Se il package GHCR è privato, prima del pull è necessario autenticarsi:

```bash
echo "$GHCR_TOKEN" | docker login ghcr.io -u <github-user> --password-stdin
```

Per un deploy pubblico, imposta la visibilità del package su `Public` nelle impostazioni del package GitHub.


## Bootstrap automatico Valhalla

I file Compose inclusi nel progetto eseguono il servizio one-shot `valhalla-init` prima di Valhalla. Il servizio usa la configurazione versionata nell'immagine (`/app/docker/valhalla/valhalla.json`) e inizializza automaticamente `data/valhalla/valhalla.json` quando il file è assente, vuoto o non valido. Un file valido già presente viene mantenuto.

Non è necessario copiare manualmente `valhalla.json` sul server. Dopo la pubblicazione della nuova immagine è sufficiente eseguire `docker compose pull` e `docker compose up -d`.

### Resume della build tile

`valhalla:build` divide la pipeline Valhalla in fasi con checkpoint persistenti
nella directory di staging. Un riavvio riprende dall'ultima fase completata e
non elimina `valhalla.next`. Le tile attive vengono sostituite solo dopo build,
health check e import alert completati.

### Percorsi host portabili per la build Valhalla

Il percorso host usato dal container temporaneo di build viene risolto da Docker Compose con `${PWD}`:

```yaml
VALHALLA_STAGING_BUILD_HOST_TILE_DIR: ${PWD}/data/valhalla.next
```

Non impostare questa variabile nel file `.env`: un valore relativo come `./data/valhalla.next` verrebbe passato a `docker run -v` e interpretato come nome di volume. Avvia i comandi dalla directory che contiene il relativo `docker-compose.yml`; in questo modo il percorso assoluto viene calcolato automaticamente e il deploy resta portabile tra server diversi.

### Retry senza nuovo download OSM

Se una build Valhalla viene interrotta o fallisce dopo la preparazione dei dati OSM, la directory di staging `data/valhalla.next` rimane presente. Al tentativo successivo il maintenance valida e riutilizza i file `<regione>.osm.pbf` e `<regione>.alerts.osm`, evitando di scaricare e filtrare nuovamente gli stessi dati. Un aggiornamento periodico completato rimuove invece lo staging e il ciclo successivo scarica normalmente gli estratti aggiornati.

Gli eventi principali sono `osm_download_completed`, `osm_download_reused`, `osm_alert_extraction_completed`, `osm_alerts_reused` e `osm_region_prepared`.

### Valhalla support databases and progress

Before graph tile construction, the maintenance build creates and checkpoints
`timezones.sqlite` and automatically evaluates a candidate `admins.sqlite` in the staging
directory. Both candidates are validated with SQLite `PRAGMA quick_check`, not only by
filename or header. Administrative metadata is accepted only when the generated database
contains admin rows and the builder reports no missing relation members, degenerate
relations, GEOS topology failures, or `admin_access.admin_id` insertion errors. Otherwise
`admins.sqlite` is removed, a structured JSON event and a readable `[INFO]` message are
printed by `osm-refresh`, and the tile build continues without administrative metadata.
No application setting or environment variable is required. If support databases change
inside an older resumable staging build, only the downstream `build` and
`enhance/cleanup` phases are invalidated; the expensive `initialize/constructedges`
checkpoint is preserved.

While a stage is running, `valhalla_build_progress` is emitted every
`VALHALLA_BUILD_PROGRESS_INTERVAL_SECONDS` seconds (default: `60`) with elapsed
time, staging size, file count, graph tile count, and manifest tile count when
available. Stage completion also emits `valhalla_build_warning_summary` so OSM
data-quality warnings remain visible without being mistaken for fatal failures.
After activation, the Valhalla `/status` response must report `has_tiles` and
`has_timezones` as true; otherwise the deployment is rolled back before alerts are
imported. `has_admins` is logged but is optional because regional OSM extracts can contain
incomplete administrative boundary relations. Routing and map matching remain available
when it is false.

Valhalla espone i flag `has_tiles`, `has_admins` e `has_timezones` solo nello status verbose. Il template abilita quindi `service_limits.status.allow_verbose` e il maintenance usa `VALHALLA_METADATA_URL` con `verbose=true` prima di importare gli alert.

### Timezone database build dependencies

`valhalla_build_timezones` from the upstream Valhalla runtime image is not used
because that wrapper expects build-time utilities such as `pkg-config` that are
not guaranteed to be present in runtime images. Ignition downloads the pinned
timezone-boundary-builder archive and creates `timezones.sqlite` directly with
`spatialite_tool` and `spatialite`. The runtime image contains the required
packages, while CI installs `spatialite-bin`, `sqlite3`, and `unzip` explicitly.
The default source is the official `evansiroky/timezone-boundary-builder`
release `2026b`. Ignition resolves the SHA-256 digest published by GitHub for
`timezones-with-oceans.shapefile.zip`, verifies the downloaded archive, and only
then imports it. The release can be pinned differently with
`VALHALLA_TIMEZONE_RELEASE`. A custom `VALHALLA_TIMEZONE_ARCHIVE_URL` is accepted
only when `VALHALLA_TIMEZONE_ARCHIVE_SHA256` is also provided.

The selected release, URL, and digest are persisted in
`.build-state/timezones.source`. Changing any of them regenerates only the
timezone database and invalidates the downstream `build` and
`enhance/cleanup` stages, preserving the expensive parsing and
`constructedges` checkpoint.


### Download OSM resiliente

Il download degli estratti `.osm.pbf` non usa un timeout complessivo fisso: per file grandi resta attivo finché il trasferimento continua a una velocità utile. Se la connessione si interrompe, il file parziale `*.download.osm.pbf` viene conservato e il tentativo successivo riparte dal byte già scaricato tramite HTTP Range. Solo un payload completato ma non valido viene eliminato.

Un refresh fallito viene ritentato automaticamente dopo 5 minuti, con backoff progressivo fino a 1 ora; dopo un refresh riuscito torna l'intervallo pianificato normale. Non sono necessarie variabili `.env` aggiuntive.

### Alert dataset availability

The API distinguishes the global alert dataset state from the absence of nearby alerts:

- `available`: at least one currently usable alert exists.
- `empty`: the latest OSM import completed successfully and legitimately produced zero records.
- `unavailable`: the import never completed, failed, or its metadata is inconsistent with the active dataset.

An empty `alerts` or `genericAlerts` array with `alertsStatus: "available"` only means that no alerts were found around the requested position. The self-healing loop does not repeatedly reimport a legitimate `empty` dataset, while it repairs `unavailable` states when a valid local extract exists.
