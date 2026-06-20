#!/usr/bin/env bash
set -euo pipefail

OSM_REGION="${OSM_REGION:-italy}"
OSM_DATA_DIR="${OSM_DATA_DIR:-./data/osm}"
VALHALLA_TILE_DIR="${VALHALLA_TILE_DIR:-./data/valhalla}"
VALHALLA_STAGING_TILE_DIR="${VALHALLA_STAGING_TILE_DIR:-${VALHALLA_TILE_DIR}.next}"
VALHALLA_STAGING_BUILD_HOST_TILE_DIR="${VALHALLA_STAGING_BUILD_HOST_TILE_DIR:-${VALHALLA_BUILD_HOST_TILE_DIR:-}}"
VALHALLA_PREVIOUS_TILE_DIR="${VALHALLA_PREVIOUS_TILE_DIR:-${VALHALLA_TILE_DIR}.previous}"
VALHALLA_CONTAINER_NAME="${VALHALLA_CONTAINER_NAME:-road-context-valhalla}"
OSM_REFRESH_RESTART_VALHALLA="${OSM_REFRESH_RESTART_VALHALLA:-true}"
OSM_REFRESH_IMPORT_ALERTS="${OSM_REFRESH_IMPORT_ALERTS:-true}"
OSM_REFRESH_LOCK_TIMEOUT_SECONDS="${OSM_REFRESH_LOCK_TIMEOUT_SECONDS:-3600}"

absolute_path() {
  case "$1" in
    /*) printf '%s\n' "$1" ;;
    *) printf '%s/%s\n' "$(pwd)" "$1" ;;
  esac
}

json_escape() {
  node -e "process.stdout.write(JSON.stringify(process.argv[1]).slice(1,-1))" "$1"
}

VALHALLA_TILE_DIR="$(absolute_path "$VALHALLA_TILE_DIR")"
VALHALLA_STAGING_TILE_DIR="$(absolute_path "$VALHALLA_STAGING_TILE_DIR")"
VALHALLA_PREVIOUS_TILE_DIR="$(absolute_path "$VALHALLA_PREVIOUS_TILE_DIR")"
LOCK_DIR="$(dirname "$VALHALLA_TILE_DIR")/.osm-refresh-lock-$OSM_REGION"

acquire_lock() {
  mkdir -p "$(dirname "$LOCK_DIR")"
  local started now elapsed
  started="$(date +%s)"
  while ! mkdir "$LOCK_DIR" 2>/dev/null; do
    now="$(date +%s)"
    elapsed=$((now - started))
    if [[ "$elapsed" -ge "$OSM_REFRESH_LOCK_TIMEOUT_SECONDS" ]]; then
      echo "{\"event\":\"osm_refresh_lock_timeout\",\"region\":\"$OSM_REGION\",\"lockDir\":\"$(json_escape "$LOCK_DIR")\",\"waitedSeconds\":$elapsed}" >&2
      exit 75
    fi
    sleep 5
  done
  trap 'rm -rf "$LOCK_DIR"' EXIT
}

restart_valhalla() {
  if [[ "$OSM_REFRESH_RESTART_VALHALLA" != "true" ]]; then
    return 0
  fi
  docker restart "$VALHALLA_CONTAINER_NAME" >/dev/null
}

echo "{\"event\":\"osm_refresh_started\",\"region\":\"$OSM_REGION\",\"tileDir\":\"$(json_escape "$VALHALLA_TILE_DIR")\"}"
acquire_lock

npm run osm:download

rm -rf "$VALHALLA_STAGING_TILE_DIR"
VALHALLA_TILE_DIR="$VALHALLA_STAGING_TILE_DIR" \
  VALHALLA_BUILD_HOST_TILE_DIR="$VALHALLA_STAGING_BUILD_HOST_TILE_DIR" \
  npm run valhalla:build

if [[ "$OSM_REFRESH_IMPORT_ALERTS" == "true" ]]; then
  npm run import:osm-alerts
fi

rm -rf "$VALHALLA_PREVIOUS_TILE_DIR"
if [[ -d "$VALHALLA_TILE_DIR" ]]; then
  mv "$VALHALLA_TILE_DIR" "$VALHALLA_PREVIOUS_TILE_DIR"
fi
mv "$VALHALLA_STAGING_TILE_DIR" "$VALHALLA_TILE_DIR"

restart_valhalla

echo "{\"event\":\"osm_refresh_finished\",\"region\":\"$OSM_REGION\",\"tileDir\":\"$(json_escape "$VALHALLA_TILE_DIR")\",\"restartedValhalla\":$OSM_REFRESH_RESTART_VALHALLA}"
