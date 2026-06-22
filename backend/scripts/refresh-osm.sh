#!/usr/bin/env bash
set -euo pipefail

OSM_REGIONS="${OSM_REGIONS:-italy}"
OSM_REGION_LABEL="${OSM_REGIONS//,/+}"
OSM_DATA_DIR="${OSM_DATA_DIR:-./data/osm}"
VALHALLA_TILE_DIR="${VALHALLA_TILE_DIR:-./data/valhalla}"
VALHALLA_STAGING_TILE_DIR="${VALHALLA_STAGING_TILE_DIR:-${VALHALLA_TILE_DIR}.next}"
VALHALLA_STAGING_BUILD_HOST_TILE_DIR="${VALHALLA_STAGING_BUILD_HOST_TILE_DIR:-${VALHALLA_BUILD_HOST_TILE_DIR:-}}"
VALHALLA_PREVIOUS_TILE_DIR="${VALHALLA_PREVIOUS_TILE_DIR:-${VALHALLA_TILE_DIR}.previous}"
VALHALLA_FAILED_TILE_DIR="${VALHALLA_FAILED_TILE_DIR:-${VALHALLA_TILE_DIR}.failed}"
VALHALLA_CONTAINER_NAME="${VALHALLA_CONTAINER_NAME:-road-context-valhalla}"
OSM_REFRESH_LOCK_TIMEOUT_SECONDS="${OSM_REFRESH_LOCK_TIMEOUT_SECONDS:-3600}"
OSM_REFRESH_LOCK_STALE_SECONDS="${OSM_REFRESH_LOCK_STALE_SECONDS:-7200}"
VALHALLA_HEALTH_URL="${VALHALLA_HEALTH_URL:-http://127.0.0.1:8002/status}"
VALHALLA_HEALTH_TIMEOUT_SECONDS="${VALHALLA_HEALTH_TIMEOUT_SECONDS:-120}"
VALHALLA_HEALTH_INTERVAL_SECONDS="${VALHALLA_HEALTH_INTERVAL_SECONDS:-2}"

absolute_path() { case "$1" in /*) printf '%s\n' "$1" ;; *) printf '%s/%s\n' "$(pwd)" "$1" ;; esac; }
json_escape() { node -e "process.stdout.write(JSON.stringify(process.argv[1]).slice(1,-1))" "$1"; }

VALHALLA_TILE_DIR="$(absolute_path "$VALHALLA_TILE_DIR")"
VALHALLA_STAGING_TILE_DIR="$(absolute_path "$VALHALLA_STAGING_TILE_DIR")"
VALHALLA_PREVIOUS_TILE_DIR="$(absolute_path "$VALHALLA_PREVIOUS_TILE_DIR")"
VALHALLA_FAILED_TILE_DIR="$(absolute_path "$VALHALLA_FAILED_TILE_DIR")"
LOCK_DIR="$(dirname "$VALHALLA_TILE_DIR")/.osm-refresh-lock"
TILE_SNAPSHOT_READY=false

lock_is_stale() {
  local owner_file="$LOCK_DIR/owner" owner_pid="" owner_host="" owner_started="0" now age
  if [[ -f "$owner_file" ]]; then
    IFS=' ' read -r owner_pid owner_host owner_started < "$owner_file" || true
  fi
  now="$(date +%s)"
  if [[ "$owner_started" =~ ^[0-9]+$ ]]; then age=$((now - owner_started)); else age=0; fi
  if [[ -n "$owner_pid" && "$owner_host" == "$(hostname)" ]] && ! kill -0 "$owner_pid" 2>/dev/null; then
    return 0
  fi
  [[ "$age" -ge "$OSM_REFRESH_LOCK_STALE_SECONDS" ]]
}

remove_stale_lock() {
  local tombstone="${LOCK_DIR}.stale.$$.$RANDOM"
  if mv "$LOCK_DIR" "$tombstone" 2>/dev/null; then
    rm -rf "$tombstone"
    echo "{\"event\":\"osm_refresh_stale_lock_removed\",\"region\":\"$OSM_REGION_LABEL\"}" >&2
  fi
}

acquire_lock() {
  mkdir -p "$(dirname "$LOCK_DIR")"
  local started now elapsed
  started="$(date +%s)"
  while ! mkdir "$LOCK_DIR" 2>/dev/null; do
    if lock_is_stale; then
      remove_stale_lock
      continue
    fi
    now="$(date +%s)"; elapsed=$((now - started))
    if [[ "$elapsed" -ge "$OSM_REFRESH_LOCK_TIMEOUT_SECONDS" ]]; then
      echo "{\"event\":\"osm_refresh_lock_timeout\",\"region\":\"$OSM_REGION_LABEL\",\"lockDir\":\"$(json_escape "$LOCK_DIR")\",\"waitedSeconds\":$elapsed}" >&2
      exit 75
    fi
    sleep 5
  done
  printf '%s %s %s\n' "$$" "$(hostname)" "$(date +%s)" > "$LOCK_DIR/owner"
  trap 'rm -rf "$LOCK_DIR"' EXIT
}

require_container_control() {
  docker inspect "$VALHALLA_CONTAINER_NAME" >/dev/null
}

stop_valhalla() {
  local running
  running="$(docker inspect -f '{{.State.Running}}' "$VALHALLA_CONTAINER_NAME")"
  if [[ "$running" == "true" ]]; then
    docker stop "$VALHALLA_CONTAINER_NAME" >/dev/null
  fi
}

start_valhalla() {
  docker start "$VALHALLA_CONTAINER_NAME" >/dev/null
}

wait_for_valhalla_health() {
  local started now elapsed
  started="$(date +%s)"
  while true; do
    if curl -fsS --max-time 5 "$VALHALLA_HEALTH_URL" >/dev/null 2>&1; then
      echo "{\"event\":\"valhalla_health_ready\",\"region\":\"$OSM_REGION_LABEL\",\"waitedSeconds\":$(( $(date +%s) - started ))}"
      return 0
    fi
    now="$(date +%s)"
    elapsed=$((now - started))
    if [[ "$elapsed" -ge "$VALHALLA_HEALTH_TIMEOUT_SECONDS" ]]; then
      echo "{\"event\":\"valhalla_health_timeout\",\"region\":\"$OSM_REGION_LABEL\",\"url\":\"$(json_escape "$VALHALLA_HEALTH_URL")\",\"waitedSeconds\":$elapsed}" >&2
      return 1
    fi
    sleep "$VALHALLA_HEALTH_INTERVAL_SECONDS"
  done
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
  echo "{\"event\":\"osm_refresh_rollback_started\",\"region\":\"$OSM_REGION_LABEL\"}" >&2
  clear_directory "$VALHALLA_FAILED_TILE_DIR"
  move_directory_contents "$VALHALLA_TILE_DIR" "$VALHALLA_FAILED_TILE_DIR"
  move_directory_contents "$VALHALLA_PREVIOUS_TILE_DIR" "$VALHALLA_TILE_DIR"
  if start_valhalla && wait_for_valhalla_health; then
    echo "{\"event\":\"osm_refresh_rollback_finished\",\"region\":\"$OSM_REGION_LABEL\",\"healthy\":true}" >&2
  else
    echo "{\"event\":\"osm_refresh_rollback_finished\",\"region\":\"$OSM_REGION_LABEL\",\"healthy\":false}" >&2
    return 1
  fi
}

echo "{\"event\":\"osm_refresh_started\",\"region\":\"$OSM_REGION_LABEL\",\"tileDir\":\"$(json_escape "$VALHALLA_TILE_DIR")\"}"
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
  echo "{\"event\":\"osm_refresh_failed\",\"phase\":\"tile_activation\",\"region\":\"$OSM_REGION_LABEL\"}" >&2
  exit 1
fi
if ! start_valhalla; then
  rollback_tiles || true
  echo "{\"event\":\"osm_refresh_failed\",\"phase\":\"valhalla_start\",\"region\":\"$OSM_REGION_LABEL\"}" >&2
  exit 1
fi
if ! wait_for_valhalla_health; then
  stop_valhalla || true
  rollback_tiles || true
  echo "{\"event\":\"osm_refresh_failed\",\"phase\":\"valhalla_health\",\"region\":\"$OSM_REGION_LABEL\"}" >&2
  exit 1
fi

if ! npm run import:osm-alerts; then
  stop_valhalla || true
  rollback_tiles
  echo "{\"event\":\"osm_refresh_failed\",\"phase\":\"alert_import\",\"region\":\"$OSM_REGION_LABEL\"}" >&2
  exit 1
fi

rm -rf "$VALHALLA_PREVIOUS_TILE_DIR" "$VALHALLA_FAILED_TILE_DIR"
echo "{\"event\":\"osm_refresh_finished\",\"region\":\"$OSM_REGION_LABEL\",\"tileDir\":\"$(json_escape "$VALHALLA_TILE_DIR")\",\"restartedValhalla\":true}"
