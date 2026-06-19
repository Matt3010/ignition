#!/usr/bin/env bash
set -euo pipefail

OSM_REGION="${OSM_REGION:-prefetch}"
OSM_BBOX="${OSM_BBOX:-}"
VALHALLA_TILE_DIR="${VALHALLA_TILE_DIR:-./data/valhalla-prefetch/$OSM_REGION}"
VALHALLA_BUILD_HOST_TILE_DIR="${VALHALLA_BUILD_HOST_TILE_DIR:-}"
VALHALLA_ACTIVE_TILE_DIR="${VALHALLA_ACTIVE_TILE_DIR:-}"
VALHALLA_HOST_TILE_DIR="${VALHALLA_HOST_TILE_DIR:-}"
VALHALLA_CONTAINER_NAME="${VALHALLA_CONTAINER_NAME:-}"
TILE_PREFETCH_RESTART_VALHALLA="${TILE_PREFETCH_RESTART_VALHALLA:-true}"
TILE_PREFETCH_FORCE="${TILE_PREFETCH_FORCE:-false}"
TILE_PREFETCH_DRY_RUN="${TILE_PREFETCH_DRY_RUN:-false}"
TILE_PREFETCH_MAX_AGE_HOURS="${TILE_PREFETCH_MAX_AGE_HOURS:-168}"
TILE_PREFETCH_IMPORT_ALERTS="${TILE_PREFETCH_IMPORT_ALERTS:-true}"
TILE_PREFETCH_RETRIES="${TILE_PREFETCH_RETRIES:-2}"
TILE_PREFETCH_RETRY_DELAY_SECONDS="${TILE_PREFETCH_RETRY_DELAY_SECONDS:-3}"
TILE_PREFETCH_LOCK_TIMEOUT_SECONDS="${TILE_PREFETCH_LOCK_TIMEOUT_SECONDS:-300}"
POSTGRES_PORT="${POSTGRES_PORT:-5433}"
OSM_BBOX_API_URL="${OSM_BBOX_API_URL:-https://api.openstreetmap.org/api/0.6/map}"
OSM_DATA_DIR="${OSM_DATA_DIR:-./data/osm}"

absolute_path() {
  case "$1" in
    /*) printf '%s\n' "$1" ;;
    *) printf '%s/%s\n' "$(pwd)" "$1" ;;
  esac
}

VALHALLA_TILE_DIR="$(absolute_path "$VALHALLA_TILE_DIR")"
if [[ -n "$VALHALLA_ACTIVE_TILE_DIR" ]]; then
  VALHALLA_ACTIVE_TILE_DIR="$(absolute_path "$VALHALLA_ACTIVE_TILE_DIR")"
fi
META_FILE="$VALHALLA_TILE_DIR/prefetch-meta.json"
LOCK_DIR="$(dirname "$VALHALLA_TILE_DIR")/.prefetch-lock-$OSM_REGION"

if [[ -z "$OSM_BBOX" ]]; then
  echo "Set OSM_BBOX=minLon,minLat,maxLon,maxLat" >&2
  exit 1
fi

if [[ "$TILE_PREFETCH_DRY_RUN" == "true" ]]; then
  echo "{\"event\":\"tile_prefetch_dry_run\",\"region\":\"$OSM_REGION\",\"bbox\":\"$OSM_BBOX\",\"tileDir\":\"$VALHALLA_TILE_DIR\",\"restartValhalla\":$TILE_PREFETCH_RESTART_VALHALLA,\"lockTimeoutSeconds\":$TILE_PREFETCH_LOCK_TIMEOUT_SECONDS,\"retries\":$TILE_PREFETCH_RETRIES}"
  exit 0
fi

json_escape() {
  node -e "process.stdout.write(JSON.stringify(process.argv[1]).slice(1,-1))" "$1"
}

retry_command() {
  local event="$1"
  shift
  local attempt=1
  while true; do
    echo "{\"event\":\"${event}_attempt\",\"region\":\"$OSM_REGION\",\"attempt\":$attempt,\"maxAttempts\":$TILE_PREFETCH_RETRIES}"
    if "$@"; then
      return 0
    fi
    if [[ "$attempt" -ge "$TILE_PREFETCH_RETRIES" ]]; then
      echo "{\"event\":\"${event}_failed\",\"region\":\"$OSM_REGION\",\"attempts\":$attempt}"
      return 1
    fi
    attempt=$((attempt + 1))
    sleep "$TILE_PREFETCH_RETRY_DELAY_SECONDS"
  done
}

acquire_lock() {
  mkdir -p "$(dirname "$LOCK_DIR")"
  local started now elapsed
  started="$(date +%s)"
  while ! mkdir "$LOCK_DIR" 2>/dev/null; do
    now="$(date +%s)"
    elapsed=$((now - started))
    if [[ "$elapsed" -ge "$TILE_PREFETCH_LOCK_TIMEOUT_SECONDS" ]]; then
      echo "{\"event\":\"tile_prefetch_lock_timeout\",\"region\":\"$OSM_REGION\",\"lockDir\":\"$(json_escape "$LOCK_DIR")\",\"waitedSeconds\":$elapsed}" >&2
      exit 75
    fi
    echo "{\"event\":\"tile_prefetch_lock_wait\",\"region\":\"$OSM_REGION\",\"lockDir\":\"$(json_escape "$LOCK_DIR")\",\"waitedSeconds\":$elapsed}"
    sleep 1
  done
  printf '%s\n' "$$" > "$LOCK_DIR/pid"
  date -u +"%Y-%m-%dT%H:%M:%SZ" > "$LOCK_DIR/created_at"
  trap 'rm -rf "$LOCK_DIR"' EXIT
}

has_tiles() {
  [[ -f "$VALHALLA_TILE_DIR/valhalla_tiles/tile_manifest.json" ]] ||
    find "$VALHALLA_TILE_DIR/valhalla_tiles" -name '*.gph' -print -quit 2>/dev/null | grep -q .
}

metadata_value() {
  local key="$1"
  if [[ ! -f "$META_FILE" ]]; then
    return 1
  fi
  node -e "const fs=require('fs'); const data=JSON.parse(fs.readFileSync(process.argv[1], 'utf8')); const value=data[process.argv[2]]; if (value === undefined || value === null) process.exit(1); process.stdout.write(String(value));" "$META_FILE" "$key"
}

metadata_age_hours() {
  if [[ ! -f "$META_FILE" ]]; then
    return 1
  fi
  node -e "const fs=require('fs'); const data=JSON.parse(fs.readFileSync(process.argv[1], 'utf8')); const stamp=Date.parse(data.builtAt || data.downloadedAt || ''); if (!Number.isFinite(stamp)) process.exit(1); process.stdout.write(String((Date.now() - stamp) / 36e5));" "$META_FILE"
}

is_fresh() {
  local existing_bbox age_hours
  existing_bbox="$(metadata_value bbox 2>/dev/null || true)"
  if [[ "$existing_bbox" != "$OSM_BBOX" ]]; then
    echo "{\"event\":\"tile_prefetch_invalidated\",\"region\":\"$OSM_REGION\",\"reason\":\"bbox_changed\",\"oldBbox\":\"$existing_bbox\",\"newBbox\":\"$OSM_BBOX\"}"
    return 1
  fi
  age_hours="$(metadata_age_hours 2>/dev/null || true)"
  if [[ -z "$age_hours" ]]; then
    echo "{\"event\":\"tile_prefetch_invalidated\",\"region\":\"$OSM_REGION\",\"reason\":\"missing_or_invalid_metadata\"}"
    return 1
  fi
  if ! node -e "process.exit(Number(process.argv[1]) <= Number(process.argv[2]) ? 0 : 1)" "$age_hours" "$TILE_PREFETCH_MAX_AGE_HOURS"; then
    echo "{\"event\":\"tile_prefetch_invalidated\",\"region\":\"$OSM_REGION\",\"reason\":\"expired\",\"ageHours\":$(printf '%.2f' "$age_hours"),\"maxAgeHours\":$TILE_PREFETCH_MAX_AGE_HOURS}"
    return 1
  fi
  return 0
}

write_metadata() {
  local downloaded_at="$1"
  mkdir -p "$VALHALLA_TILE_DIR"
  OSM_REGION="$OSM_REGION" \
    OSM_BBOX="$OSM_BBOX" \
    DOWNLOADED_AT="$downloaded_at" \
    OSM_BBOX_API_URL="$OSM_BBOX_API_URL" \
    VALHALLA_TILE_DIR="$VALHALLA_TILE_DIR" \
    TILE_PREFETCH_MAX_AGE_HOURS="$TILE_PREFETCH_MAX_AGE_HOURS" \
    TILE_PREFETCH_RETRIES="$TILE_PREFETCH_RETRIES" \
    TILE_PREFETCH_LOCK_TIMEOUT_SECONDS="$TILE_PREFETCH_LOCK_TIMEOUT_SECONDS" \
    META_FILE="$META_FILE" \
    node -e "const fs=require('fs'); const data={region:process.env.OSM_REGION,bbox:process.env.OSM_BBOX,downloadedAt:process.env.DOWNLOADED_AT,builtAt:new Date().toISOString(),osmSource:process.env.OSM_BBOX_API_URL,tileDir:process.env.VALHALLA_TILE_DIR,maxAgeHours:Number(process.env.TILE_PREFETCH_MAX_AGE_HOURS),retries:Number(process.env.TILE_PREFETCH_RETRIES),lockTimeoutSeconds:Number(process.env.TILE_PREFETCH_LOCK_TIMEOUT_SECONDS)}; fs.writeFileSync(process.env.META_FILE, JSON.stringify(data, null, 2) + '\n');"
}

update_import_metadata() {
  local output_file="$1"
  local status="$2"
  mkdir -p "$VALHALLA_TILE_DIR"
  IMPORT_OUTPUT_FILE="$output_file" \
    IMPORT_STATUS="$status" \
    META_FILE="$META_FILE" \
    OSM_REGION="$OSM_REGION" \
    OSM_BBOX="$OSM_BBOX" \
    VALHALLA_TILE_DIR="$VALHALLA_TILE_DIR" \
    node -e "const fs=require('fs'); const metaFile=process.env.META_FILE; let data={}; if (fs.existsSync(metaFile)) data=JSON.parse(fs.readFileSync(metaFile,'utf8')); data.region=process.env.OSM_REGION; data.bbox=process.env.OSM_BBOX; data.tileDir=process.env.VALHALLA_TILE_DIR; let parsed=null; const outputFile=process.env.IMPORT_OUTPUT_FILE; if (outputFile && fs.existsSync(outputFile)) { const lines=fs.readFileSync(outputFile,'utf8').trim().split(/\\r?\\n/).reverse(); for (const line of lines) { const text=line.trim(); if (!text.startsWith('{') || !text.endsWith('}')) continue; try { parsed=JSON.parse(text); break; } catch {} } } data.lastImport={status:process.env.IMPORT_STATUS,at:new Date().toISOString(),records:parsed?.records ?? null,upserted:parsed?.upserted ?? null,deactivated:parsed?.deactivated ?? null,file:parsed?.file ?? null,bbox:parsed?.bbox ?? null}; fs.writeFileSync(metaFile, JSON.stringify(data,null,2)+'\n');"
}

import_osm_alerts() {
  if [[ "$TILE_PREFETCH_IMPORT_ALERTS" != "true" ]]; then
    update_import_metadata "" "disabled"
    return 0
  fi
  local osm_file="$OSM_DATA_DIR/$OSM_REGION.osm"
  if [[ ! -f "$osm_file" ]]; then
    echo "{\"event\":\"osm_alert_import_skipped\",\"region\":\"$OSM_REGION\",\"reason\":\"missing_osm_xml\",\"file\":\"$osm_file\"}"
    update_import_metadata "" "skipped_missing_osm_xml"
    return 0
  fi
  local import_output
  import_output="$(mktemp)"
  if [[ -f "dist/scripts/import-osm-alerts.js" ]]; then
    import_command=(node dist/scripts/import-osm-alerts.js)
  else
    import_command=(npm run import:osm-alerts)
  fi
  if OSM_REGION="$OSM_REGION" OSM_DATA_DIR="$OSM_DATA_DIR" retry_command osm_alert_import "${import_command[@]}" | tee "$import_output"; then
    update_import_metadata "$import_output" "success"
    rm -f "$import_output"
    return 0
  fi
  update_import_metadata "$import_output" "failed"
  rm -f "$import_output"
  return 1
}

sync_active_tile_dir() {
  if [[ -z "$VALHALLA_ACTIVE_TILE_DIR" || "$VALHALLA_ACTIVE_TILE_DIR" == "$VALHALLA_TILE_DIR" ]]; then
    return 0
  fi
  local tmp_dir
  tmp_dir="${VALHALLA_ACTIVE_TILE_DIR}.tmp"
  rm -rf "$tmp_dir"
  mkdir -p "$tmp_dir"
  cp -a "$VALHALLA_TILE_DIR"/. "$tmp_dir"/
  rm -rf "$VALHALLA_ACTIVE_TILE_DIR"
  mv "$tmp_dir" "$VALHALLA_ACTIVE_TILE_DIR"
  echo "{\"event\":\"valhalla_active_tile_synced\",\"region\":\"$OSM_REGION\",\"activeTileDir\":\"$(json_escape "$VALHALLA_ACTIVE_TILE_DIR")\"}"
}

restart_valhalla() {
  if [[ -n "$VALHALLA_CONTAINER_NAME" ]]; then
    docker restart "$VALHALLA_CONTAINER_NAME" >/dev/null
    return 0
  fi
  local compose_tile_dir
  compose_tile_dir="${VALHALLA_HOST_TILE_DIR:-$VALHALLA_TILE_DIR}"
  VALHALLA_TILE_DIR="$compose_tile_dir" POSTGRES_PORT="$POSTGRES_PORT" docker compose -f docker-compose.yml up -d --force-recreate valhalla
}

acquire_lock

if [[ "$TILE_PREFETCH_FORCE" != "true" ]] && has_tiles && is_fresh; then
  age_hours="$(metadata_age_hours 2>/dev/null || echo 0)"
  import_osm_alerts
  sync_active_tile_dir
  echo "{\"event\":\"tile_prefetch_skipped\",\"region\":\"$OSM_REGION\",\"reason\":\"fresh\",\"ageHours\":$(printf '%.2f' "$age_hours"),\"maxAgeHours\":$TILE_PREFETCH_MAX_AGE_HOURS}"
  if [[ "$TILE_PREFETCH_RESTART_VALHALLA" == "true" ]]; then
    retry_command valhalla_restart restart_valhalla
  fi
  echo "{\"event\":\"tile_prefetch_finished\",\"region\":\"$OSM_REGION\",\"tileDir\":\"$VALHALLA_TILE_DIR\",\"restartedValhalla\":$TILE_PREFETCH_RESTART_VALHALLA}"
  exit 0
fi

echo "{\"event\":\"tile_prefetch_started\",\"region\":\"$OSM_REGION\",\"bbox\":\"$OSM_BBOX\",\"tileDir\":\"$VALHALLA_TILE_DIR\"}"
downloaded_at="$(date -u +"%Y-%m-%dT%H:%M:%SZ")"
retry_command osm_bbox_download env OSM_REGION="$OSM_REGION" OSM_BBOX="$OSM_BBOX" npm run osm:bbox:direct
rm -rf "$VALHALLA_TILE_DIR"
retry_command valhalla_build env OSM_REGION="$OSM_REGION" VALHALLA_TILE_DIR="$VALHALLA_TILE_DIR" VALHALLA_BUILD_HOST_TILE_DIR="$VALHALLA_BUILD_HOST_TILE_DIR" npm run valhalla:build
write_metadata "$downloaded_at"
import_osm_alerts
sync_active_tile_dir

if [[ "$TILE_PREFETCH_RESTART_VALHALLA" == "true" ]]; then
  retry_command valhalla_restart restart_valhalla
fi

echo "{\"event\":\"tile_prefetch_finished\",\"region\":\"$OSM_REGION\",\"tileDir\":\"$VALHALLA_TILE_DIR\",\"restartedValhalla\":$TILE_PREFETCH_RESTART_VALHALLA}"
