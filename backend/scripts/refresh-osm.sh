#!/usr/bin/env bash
set -euo pipefail

OSM_REGION="${OSM_REGION:-italy}"
OSM_DATA_DIR="${OSM_DATA_DIR:-./data/osm}"
VALHALLA_TILE_DIR="${VALHALLA_TILE_DIR:-./data/valhalla}"
VALHALLA_STAGING_TILE_DIR="${VALHALLA_STAGING_TILE_DIR:-${VALHALLA_TILE_DIR}.next}"
VALHALLA_STAGING_BUILD_HOST_TILE_DIR="${VALHALLA_STAGING_BUILD_HOST_TILE_DIR:-${VALHALLA_BUILD_HOST_TILE_DIR:-}}"
VALHALLA_PREVIOUS_TILE_DIR="${VALHALLA_PREVIOUS_TILE_DIR:-${VALHALLA_TILE_DIR}.previous}"
VALHALLA_FAILED_TILE_DIR="${VALHALLA_FAILED_TILE_DIR:-${VALHALLA_TILE_DIR}.failed}"
VALHALLA_CONTAINER_NAME="${VALHALLA_CONTAINER_NAME:-road-context-valhalla}"
OSM_REFRESH_RESTART_VALHALLA="${OSM_REFRESH_RESTART_VALHALLA:-true}"
OSM_REFRESH_IMPORT_ALERTS="${OSM_REFRESH_IMPORT_ALERTS:-true}"
OSM_REFRESH_LOCK_TIMEOUT_SECONDS="${OSM_REFRESH_LOCK_TIMEOUT_SECONDS:-3600}"

absolute_path() { case "$1" in /*) printf '%s\n' "$1" ;; *) printf '%s/%s\n' "$(pwd)" "$1" ;; esac; }
json_escape() { node -e "process.stdout.write(JSON.stringify(process.argv[1]).slice(1,-1))" "$1"; }

VALHALLA_TILE_DIR="$(absolute_path "$VALHALLA_TILE_DIR")"
VALHALLA_STAGING_TILE_DIR="$(absolute_path "$VALHALLA_STAGING_TILE_DIR")"
VALHALLA_PREVIOUS_TILE_DIR="$(absolute_path "$VALHALLA_PREVIOUS_TILE_DIR")"
VALHALLA_FAILED_TILE_DIR="$(absolute_path "$VALHALLA_FAILED_TILE_DIR")"
LOCK_DIR="$(dirname "$VALHALLA_TILE_DIR")/.osm-refresh-lock-$OSM_REGION"
TILE_SNAPSHOT_READY=false

acquire_lock() {
  mkdir -p "$(dirname "$LOCK_DIR")"
  local started now elapsed
  started="$(date +%s)"
  while ! mkdir "$LOCK_DIR" 2>/dev/null; do
    now="$(date +%s)"; elapsed=$((now - started))
    if [[ "$elapsed" -ge "$OSM_REFRESH_LOCK_TIMEOUT_SECONDS" ]]; then
      echo "{\"event\":\"osm_refresh_lock_timeout\",\"region\":\"$OSM_REGION\",\"lockDir\":\"$(json_escape "$LOCK_DIR")\",\"waitedSeconds\":$elapsed}" >&2
      exit 75
    fi
    sleep 5
  done
  trap 'rm -rf "$LOCK_DIR"' EXIT
}

require_container_control() {
  if [[ "$OSM_REFRESH_RESTART_VALHALLA" != "true" ]]; then
    echo '{"event":"osm_refresh_invalid_configuration","reason":"OSM_REFRESH_RESTART_VALHALLA must be true for an atomic tile switch"}' >&2
    exit 64
  fi
  docker inspect "$VALHALLA_CONTAINER_NAME" >/dev/null
}

stop_valhalla() {
  docker stop "$VALHALLA_CONTAINER_NAME" >/dev/null
}

start_valhalla() {
  docker start "$VALHALLA_CONTAINER_NAME" >/dev/null
}

clear_directory() {
  local directory="$1"
  mkdir -p "$directory"
  find "$directory" -mindepth 1 -maxdepth 1 -exec rm -rf -- {} + || return 1
}

move_directory_contents() {
  local source="$1" destination="$2"
  mkdir -p "$source" "$destination"
  while IFS= read -r -d '' entry; do
    mv -- "$entry" "$destination/" || return 1
  done < <(find "$source" -mindepth 1 -maxdepth 1 -print0)
}

snapshot_current_tiles() {
  clear_directory "$VALHALLA_PREVIOUS_TILE_DIR"
  mkdir -p "$VALHALLA_TILE_DIR"
  # Hard-link files where possible: this preserves a rollback copy without
  # duplicating the large tile payload on the same filesystem.
  cp -al "$VALHALLA_TILE_DIR/." "$VALHALLA_PREVIOUS_TILE_DIR/" || return 1
  TILE_SNAPSHOT_READY=true
}

activate_staging_tiles() {
  TILE_SNAPSHOT_READY=false
  [[ -f "$VALHALLA_STAGING_TILE_DIR/valhalla.json" ]] || {
    echo "Missing staged valhalla.json in $VALHALLA_STAGING_TILE_DIR" >&2
    return 1
  }
  [[ -d "$VALHALLA_STAGING_TILE_DIR/valhalla_tiles" ]] || {
    echo "Missing staged valhalla_tiles in $VALHALLA_STAGING_TILE_DIR" >&2
    return 1
  }
  clear_directory "$VALHALLA_FAILED_TILE_DIR" || return 1
  snapshot_current_tiles || return 1
  clear_directory "$VALHALLA_TILE_DIR" || return 1
  move_directory_contents "$VALHALLA_STAGING_TILE_DIR" "$VALHALLA_TILE_DIR" || return 1
  rmdir "$VALHALLA_STAGING_TILE_DIR" 2>/dev/null || true
}

rollback_tiles() {
  echo "{\"event\":\"osm_refresh_rollback_started\",\"region\":\"$OSM_REGION\"}" >&2
  clear_directory "$VALHALLA_FAILED_TILE_DIR"
  move_directory_contents "$VALHALLA_TILE_DIR" "$VALHALLA_FAILED_TILE_DIR"
  move_directory_contents "$VALHALLA_PREVIOUS_TILE_DIR" "$VALHALLA_TILE_DIR"
  start_valhalla || true
  echo "{\"event\":\"osm_refresh_rollback_finished\",\"region\":\"$OSM_REGION\"}" >&2
}

echo "{\"event\":\"osm_refresh_started\",\"region\":\"$OSM_REGION\",\"tileDir\":\"$(json_escape "$VALHALLA_TILE_DIR")\"}"
acquire_lock
require_container_control
npm run osm:download
rm -rf "$VALHALLA_STAGING_TILE_DIR"
VALHALLA_TILE_DIR="$VALHALLA_STAGING_TILE_DIR" \
  VALHALLA_BUILD_HOST_TILE_DIR="$VALHALLA_STAGING_BUILD_HOST_TILE_DIR" \
  npm run valhalla:build

stop_valhalla
if ! activate_staging_tiles; then
  if [[ "$TILE_SNAPSHOT_READY" == "true" ]]; then
    rollback_tiles
  else
    start_valhalla || true
  fi
  echo "{\"event\":\"osm_refresh_failed\",\"phase\":\"tile_activation\",\"region\":\"$OSM_REGION\"}" >&2
  exit 1
fi
if ! start_valhalla; then
  rollback_tiles
  echo "{\"event\":\"osm_refresh_failed\",\"phase\":\"valhalla_start\",\"region\":\"$OSM_REGION\"}" >&2
  exit 1
fi

if [[ "$OSM_REFRESH_IMPORT_ALERTS" == "true" ]]; then
  if ! npm run import:osm-alerts; then
    stop_valhalla || true
    rollback_tiles
    echo "{\"event\":\"osm_refresh_failed\",\"phase\":\"alert_import\",\"region\":\"$OSM_REGION\"}" >&2
    exit 1
  fi
fi

rm -rf "$VALHALLA_PREVIOUS_TILE_DIR" "$VALHALLA_FAILED_TILE_DIR"
echo "{\"event\":\"osm_refresh_finished\",\"region\":\"$OSM_REGION\",\"tileDir\":\"$(json_escape "$VALHALLA_TILE_DIR")\",\"restartedValhalla\":true}"
