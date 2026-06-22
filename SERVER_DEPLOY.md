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

### Percorsi host portabili per la build Valhalla

Il percorso host usato dal container temporaneo di build viene risolto da Docker Compose con `${PWD}`:

```yaml
VALHALLA_STAGING_BUILD_HOST_TILE_DIR: ${PWD}/data/valhalla.next
```

Non impostare questa variabile nel file `.env`: un valore relativo come `./data/valhalla.next` verrebbe passato a `docker run -v` e interpretato come nome di volume. Avvia i comandi dalla directory che contiene il relativo `docker-compose.yml`; in questo modo il percorso assoluto viene calcolato automaticamente e il deploy resta portabile tra server diversi.
