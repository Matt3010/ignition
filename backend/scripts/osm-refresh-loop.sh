#!/usr/bin/env bash
set -euo pipefail

OSM_REFRESH_INTERVAL_SECONDS="${OSM_REFRESH_INTERVAL_SECONDS:-86400}"
OSM_REFRESH_RUN_ON_START="${OSM_REFRESH_RUN_ON_START:-false}"
VALHALLA_TILE_DIR="${VALHALLA_TILE_DIR:-./data/valhalla}"

run_refresh() {
  if ! npm run osm:refresh; then
    echo "{\"event\":\"osm_refresh_failed\",\"nextRetrySeconds\":$OSM_REFRESH_INTERVAL_SECONDS}" >&2
  fi
}

tiles_are_missing() {
  [[ ! -f "$VALHALLA_TILE_DIR/valhalla.json" || ! -d "$VALHALLA_TILE_DIR/valhalla_tiles" ]]
}

if [[ "$OSM_REFRESH_RUN_ON_START" == "true" ]] || tiles_are_missing; then
  run_refresh
fi

while true; do
  sleep "$OSM_REFRESH_INTERVAL_SECONDS"
  run_refresh
done
