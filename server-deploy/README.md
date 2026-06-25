# Ignition server deployment

Copy this entire folder to the server, for example to `~/road` or `/opt/ignition`.
No application source code, Node.js, npm, or local build is required.

## Files on the server

```text
docker-compose.yml
.env
update.sh
```

The single `.env` file configures backend, PostgreSQL, Valhalla and OSM maintenance.
Do not copy the backend development `.env` to the server.

## First installation

```bash
cp .env.example .env
nano .env
```

At minimum, verify:

```env
IGNITION_IMAGE=ghcr.io/matt3010/ignition:latest
POSTGRES_PASSWORD=replace_with_a_long_random_url_safe_password
OSM_REGIONS=italy
```

Use a URL-safe PostgreSQL password because it is inserted into `DATABASE_URL`. Letters, numbers, `-` and `_` are safe.

For a private GHCR package, authenticate with a GitHub Personal Access Token classic that has `read:packages`:

```bash
read -s GHCR_TOKEN
echo "$GHCR_TOKEN" | docker login ghcr.io -u matt3010 --password-stdin
unset GHCR_TOKEN
```

Start the stack:

```bash
docker compose up -d
```

The project initializes `valhalla.json` automatically. If no Valhalla tiles exist, the maintenance service performs the initial OSM refresh immediately even when `OSM_REFRESH_RUN_ON_START=false`.

## Updates

After GitHub Actions publishes a new image:

```bash
./update.sh
```

## Useful checks

```bash
docker compose ps
docker compose logs -f backend
docker compose logs -f osm-refresh
docker compose logs -f valhalla
docker compose logs -f postgres
```

Keep the generated `data/`, `reports/`, and Docker volumes during normal updates.

## Ripresa della build Valhalla

La directory `data/valhalla.next` è persistente. La build registra checkpoint dopo
la preparazione degli indici OSM, dopo la generazione del grafo iniziale e dopo
le fasi finali. Se `osm-refresh` viene fermato o ricreato, al riavvio riparte
dall'ultimo checkpoint completato senza cancellare lo staging.

Non vengono mai attivate tile parziali: `data/valhalla` cambia solo dopo il
completamento di tutte le fasi e il successivo health check. Se cambiano PBF,
configurazione Valhalla, immagine o piattaforma, lo staging incompatibile viene
azzerato intenzionalmente e ricostruito.

### Percorsi host portabili per la build Valhalla

Il percorso host usato dal container temporaneo di build viene risolto da Docker Compose con `${PWD}`:

```yaml
VALHALLA_STAGING_BUILD_HOST_TILE_DIR: ${PWD}/data/valhalla.next
```

Non impostare questa variabile nel file `.env`: un valore relativo come `./data/valhalla.next` verrebbe passato a `docker run -v` e interpretato come nome di volume. Avvia i comandi dalla directory che contiene il relativo `docker-compose.yml`; in questo modo il percorso assoluto viene calcolato automaticamente e il deploy resta portabile tra server diversi.

### Ripresa dopo un errore di build

La presenza di `data/valhalla.next` identifica un tentativo incompleto. Al riavvio `osm-refresh` riutilizza i PBF e gli estratti alert già validati invece di riscaricarli. Dopo un'attivazione riuscita lo staging viene rimosso, quindi il successivo aggiornamento pianificato scarica dati nuovi.

### Valhalla build metadata and progress

The OSM maintenance container generates `admins.sqlite` and `timezones.sqlite`
automatically before graph tiles are built. Both files are stored in
`data/valhalla.next`, checkpointed, validated with SQLite `PRAGMA quick_check`,
and promoted together with the tiles. Existing parsing progress is preserved; when these databases are first
introduced, only the downstream tile stages are rebuilt so the metadata is
actually embedded.

Progress is logged every 60 seconds by default. Override it in `.env` with
`VALHALLA_BUILD_PROGRESS_INTERVAL_SECONDS` using a positive integer value.
After activation, maintenance verifies that Valhalla reports `has_tiles`,
`has_admins`, and `has_timezones`; an incomplete tileset is rolled back.

Valhalla espone i flag `has_tiles`, `has_admins` e `has_timezones` solo nello status verbose. Il template abilita quindi `service_limits.status.allow_verbose` e il maintenance usa `VALHALLA_METADATA_URL` con `verbose=true` prima di importare gli alert.

The timezone support database is generated directly by the maintenance
container with Spatialite instead of invoking the optional upstream
`valhalla_build_timezones` shell wrapper. The default source is the official
`evansiroky/timezone-boundary-builder` release `2026b`. Before extraction,
Ignition resolves the SHA-256 digest published in the GitHub release metadata
and verifies the archive. A custom archive URL requires an explicit
`VALHALLA_TIMEZONE_ARCHIVE_SHA256` value.


### Download OSM resiliente

Il download degli estratti `.osm.pbf` non usa un timeout complessivo fisso: per file grandi resta attivo finché il trasferimento continua a una velocità utile. Se la connessione si interrompe, il file parziale `*.download.osm.pbf` viene conservato e il tentativo successivo riparte dal byte già scaricato tramite HTTP Range. Solo un payload completato ma non valido viene eliminato.

Un refresh fallito viene ritentato automaticamente dopo 5 minuti, con backoff progressivo fino a 1 ora; dopo un refresh riuscito torna l'intervallo pianificato normale. Non sono necessarie variabili `.env` aggiuntive.

## Automatic alert integrity recovery

The `osm-refresh` service checks the active OSM alert dataset at startup and every
`OSM_ALERT_HEALTHCHECK_INTERVAL_SECONDS` seconds (default: `300`). If PostgreSQL
contains no active alerts but the local `*.alerts.osm` files are valid, it imports
them immediately without rebuilding Valhalla. If the source files are missing, a
full OSM refresh is scheduled. Alert import also runs before the Valhalla graph
build, so a tile-build failure does not remove alert availability.
