# Next Steps

## Stato

- Backend reale usa Valhalla/PostGIS/OSM per guida e map matching.
- `npm run test:drive` usa provider reali.
- Alert mock/fixture rimossi dal flusso operativo.
- Import OSM statico implementato per `fixedSpeedCamera`, `roadWorks`, `roadHazard`.

## Piano

1. [done] Trovare e testare una bbox OSM con dati reali piu ricchi.
   - Cercare elementi OSM reali con `highway=speed_camera`, `enforcement=maxspeed`, `highway=construction`, `hazard=*`.
   - Scaricare bbox piccola.
   - Importare alert OSM in PostGIS.
   - Verificare conteggi DB e test guida reale.
2. [done] Migliorare mapping OSM alert.
   - Supportare relation enforcement complete (`device`, `from`, `to`).
   - Derivare bearing/direzione quando presenti.
   - Aggiungere test su esempi OSM reali.
3. [done] Aggiungere invalidation DB alert per bbox.
   - Tracciare source/version/bbox.
   - Disattivare alert OSM non piu presenti nel nuovo estratto della stessa bbox.
4. [done] Rendere prefetch produzione piu robusto.
   - Lock file anti rebuild concorrenti.
   - Stato dettagliato ultimo download/build/import.
   - Retry/timeout osservabili.
5. [done] Estendere test guida reale.
   - Route piu lunghe e variate.
   - Export GPX/GeoJSON percorso.
   - Report per strada, limite, alert, unmatched.
6. [done] Preparare Raspberry.
   - Tile preparate offline.
   - Volume Valhalla persistente.
   - Smoke test ARM64.
7. [done] Pulizia finale e hardening repo.
   - Ignorare report/artifact generati.
   - Rimuovere compose mock operativo.
   - Vietare provider mock in produzione.
   - Test/lint/build finali.

## Comandi Base

```bash
cd "/Users/matteoscanferla/Desktop/cartella senza nome 2/backend"

docker compose -f docker-compose.yml up -d postgres valhalla

DATABASE_URL=postgres://road:road@127.0.0.1:5433/road_context npm run migrate

DATABASE_URL=postgres://road:road@127.0.0.1:5433/road_context \
VALHALLA_BASE_URL=http://127.0.0.1:8002 \
npm run test:drive
```

## Step 1 - Risultato

Bbox reale usata:

- Regione: `prefetch-44p970000-11p000000`
- Bbox: `10.990000,44.960000,11.010000,44.980000`
- File OSM: `data/osm/prefetch-44p970000-11p000000.osm`
- Tile Valhalla: `data/valhalla-prefetch/prefetch-44p970000-11p000000`

Import OSM:

```json
{
  "source": "osm",
  "elementsScanned": 2906,
  "records": 1,
  "upserted": 1
}
```

Alert reale importato:

```txt
fixedSpeedCamera, lat 44.9646356, lon 10.9995592, limite 50, source osm
```

Smoke test guida reale:

- Partenza: `44.9646356,10.9995592`
- Strada iniziale: `SP44`
- Autovelox rilevato: `fixedSpeedCamera a 0 m`
- Distanza simulata: `1.026 km`
- Campioni: `80`
- Match rate: `95%`
- Superamenti limite: `9`
- Alert totali restituiti: `80`
- Fallimenti: `0`

Report:

- Eventi: `reports/drive-soak/drive-2026-06-18T21-28-16-976Z-1781818096976.jsonl`
- Riepilogo: `reports/drive-soak/drive-2026-06-18T21-28-16-976Z-1781818096976.summary.json`

## Step 2 - Risultato

Parser OSM migliorato:

- relation `enforcement=maxspeed` legge membri `device`, `from`, `to`, `via`;
- bearing calcolato da `from -> to`, con fallback `from -> device` o `device -> to`;
- direction impostata a `forward` quando il bearing e derivabile;
- supporto base per relation con member way `from/to`;
- relation diverse sullo stesso device non vengono piu schiacciate;
- mapping esteso per `speed_camera=yes`, `camera:type=speed`, `highway=roadworks`, `hazard:conditional`.

Reimport bbox reale:

```json
{
  "source": "osm",
  "file": "data/osm/prefetch-44p970000-11p000000.osm",
  "elementsScanned": 2906,
  "records": 5,
  "upserted": 5
}
```

DB dopo reimport:

- autovelox OSM `44.9646356,10.9995592`, limite `50`, bearing `59.1`;
- stesso device OSM, direzione opposta, bearing `218.7`;
- altri autovelox enforcement OSM nella bbox/area importata.

Smoke guida reale dopo step 2:

- Partenza: `44.9646356,10.9995592`
- Campioni: `30`
- Match rate: `100%`
- Alert restituiti: `48`
- Alert piu vicino: `0 m`
- Fallimenti: `0`

Verifica:

- `npm test`: `40 passed`
- `npm run lint`: ok
- `npm run build`: ok

## Step 3 - Risultato

DB import metadata:

- Migrazione `0002_import_metadata.sql`.
- `data_imports` ora registra:
  - `bbox`
  - `file_path`
  - `deactivated_count`

Invalidation OSM:

- `npm run import:osm-alerts` calcola bbox da `<bounds>` OSM o dai nodi.
- Dopo upsert, disattiva alert `source=osm` ancora attivi dentro quella bbox se non presenti nel nuovo file.
- Default attivo.
- Disattivabile con `OSM_ALERT_DEACTIVATE_STALE=false`.

Verifica reale:

```json
{
  "source": "osm",
  "file": "data/osm/prefetch-44p970000-11p000000.osm",
  "bbox": "10.990000,44.960000,11.010000,44.980000",
  "elementsScanned": 2906,
  "records": 5,
  "upserted": 5,
  "deactivated": 1
}
```

Il record stale di test e stato rimosso dal DB dopo verifica.

Verifica:

- `npm test`: `41 passed`
- `npm run lint`: ok
- `npm run build`: ok

## Step 4 - Risultato

Prefetch produzione piu robusto:

- Lock directory atomica per regione: `.prefetch-lock-*`.
- Attesa lock configurabile con `TILE_PREFETCH_LOCK_TIMEOUT_SECONDS`.
- Retry configurabili per download OSM, import alert, build Valhalla e restart Valhalla:
  - `TILE_PREFETCH_RETRIES`
  - `TILE_PREFETCH_RETRY_DELAY_SECONDS`
- Eventi JSON osservabili:
  - `*_attempt`
  - `*_failed`
  - `tile_prefetch_lock_wait`
  - `tile_prefetch_lock_timeout`
- Metadata `prefetch-meta.json` esteso con ultimo import:
  - `lastImport.status`
  - `lastImport.at`
  - `lastImport.records`
  - `lastImport.upserted`
  - `lastImport.deactivated`
  - `lastImport.file`
  - `lastImport.bbox`
- Endpoint `GET /api/v1/tile-prefetch/status` espone ora ultimo bbox, tile dir, download/build time e import OSM.

Verifica dry-run:

```json
{
  "event": "tile_prefetch_dry_run",
  "lockTimeoutSeconds": 300,
  "retries": 2
}
```

Verifica prefetch reale su tile fresco:

```json
{
  "source": "osm",
  "file": "data/osm/prefetch-44p970000-11p000000.osm",
  "bbox": "10.990000,44.960000,11.010000,44.980000",
  "records": 5,
  "upserted": 5,
  "deactivated": 0
}
```

Metadata scritto:

```json
{
  "lastImport": {
    "status": "success",
    "records": 5,
    "upserted": 5,
    "deactivated": 0
  }
}
```

Verifica:

- `npm test`: `41 passed`
- `npm run lint`: ok
- `npm run build`: ok

## Step 5 - Risultato

Test guida reale esteso:

- `DRIVE_SOAK_ROUTE_TARGET_METERS` controlla lunghezza target route Valhalla.
- Default guida reale portato a `1800 m`.
- Route candidate ora provano distanze multiple attorno al target.
- Summary finale include:
  - `topStrade`
  - `limiti`
  - `alertPerTipo`
  - `unmatchedSamples`
  - path report generati
- Console finale mostra:
  - top strade per km/campioni/superamenti/alert;
  - limiti visti e over per limite;
  - alert per tipo.

Export aggiunti:

- `.geojson`: LineString percorso + punti campione con contesto strada.
- `.gpx`: traccia apribile in strumenti GIS/navigazione.

Smoke guida reale:

- Partenza: `44.9646356,10.9995592`
- Target route: `1800 m`
- Campioni: `35`
- Match rate: `100%`
- Strade viste: `SP44`, `Via Donismonda`
- Alert: `fixedSpeedCamera`
- GeoJSON features: `36`
- GPX generato: sì

Report:

- Eventi: `reports/drive-soak/drive-2026-06-18T22-04-19-689Z-1781820259689.jsonl`
- Riepilogo: `reports/drive-soak/drive-2026-06-18T22-04-19-689Z-1781820259689.summary.json`
- GeoJSON: `reports/drive-soak/drive-2026-06-18T22-04-19-689Z-1781820259689.geojson`
- GPX: `reports/drive-soak/drive-2026-06-18T22-04-19-689Z-1781820259689.gpx`

Verifica:

- `npm test`: `41 passed`
- `npm run lint`: ok
- `npm run build`: ok

## Step 6 - Risultato

Preparazione Raspberry:

- Script packaging tile Valhalla:
  - `scripts/package-valhalla-tiles.sh`
  - comando `npm run valhalla:package`
  - produce `.tar.gz` + manifest JSON con `sha256` e `bytes`
- Smoke test Raspberry:
  - `scripts/raspberry-smoke.ts`
  - comando `npm run raspberry:smoke`
  - controlla `/health`, `/ready`, `/api/v1/config`, `/api/v1/tile-prefetch/status`, `POST /api/v1/road-context`
- README aggiornato con procedura:
  - build tile offline;
  - pacchetto tile;
  - copia su Raspberry;
  - extract nel bind mount Valhalla;
  - Compose;
  - migrate;
  - smoke test.

Verifica package:

```json
{
  "region": "prefetch-44p970000-11p000000",
  "sha256": "f5e09875c2a40435140f7c6edc15df2c54a2d4ca2479f3a4417d03d18f57201e",
  "bytes": 8547
}
```

Smoke reale su server locale:

- `/health`: `ok`
- `/ready`: `ready=true`
- database: `up`
- Valhalla: `up`
- road context: risposta valida
- alert OSM reali presenti, `fixedSpeedCamera` a `0 m`

Verifica:

- `npm test`: `41 passed`
- `npm run lint`: ok
- `npm run build`: ok

## Step 7 - Risultato

Pulizia repo:

- `.gitignore` aggiornato:
  - `reports/`
  - `dist-artifacts/`
  - `.prefetch-lock-*/`
- `docker-compose.mock.yml` rimosso.
- Target `mock-up` rimosso dal Makefile.
- `ROAD_CONTEXT_PROVIDER=mock` ora fallisce in produzione.
- Mock rimane solo per test isolati.

Verifica:

- `npm test`: `42 passed`
- `npm run lint`: ok
- `npm run build`: ok
