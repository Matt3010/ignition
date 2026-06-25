#!/usr/bin/env bash
set -euo pipefail

OSM_REFRESH_INTERVAL_SECONDS="${OSM_REFRESH_INTERVAL_SECONDS:-86400}"
OSM_REFRESH_RUN_ON_START="${OSM_REFRESH_RUN_ON_START:-false}"
OSM_REFRESH_FAILURE_RETRY_INITIAL_SECONDS="${OSM_REFRESH_FAILURE_RETRY_INITIAL_SECONDS:-300}"
OSM_REFRESH_FAILURE_RETRY_MAX_SECONDS="${OSM_REFRESH_FAILURE_RETRY_MAX_SECONDS:-3600}"
VALHALLA_TILE_DIR="${VALHALLA_TILE_DIR:-./data/valhalla}"

failure_delay="$OSM_REFRESH_FAILURE_RETRY_INITIAL_SECONDS"

run_refresh() {
  if npm run osm:refresh; then
    failure_delay="$OSM_REFRESH_FAILURE_RETRY_INITIAL_SECONDS"
    return 0
  fi

  echo "{\"event\":\"osm_refresh_failed\",\"nextRetrySeconds\":$failure_delay}" >&2
  return 1
}

tiles_are_missing() {
  [[ ! -f "$VALHALLA_TILE_DIR/valhalla.json" || ! -d "$VALHALLA_TILE_DIR/valhalla_tiles" ]]
}

should_refresh_now=false
if [[ "$OSM_REFRESH_RUN_ON_START" == "true" ]] || tiles_are_missing; then
  should_refresh_now=true
fi

while true; do
  if [[ "$should_refresh_now" == "true" ]]; then
    if run_refresh; then
      sleep_for="$OSM_REFRESH_INTERVAL_SECONDS"
    else
      sleep_for="$failure_delay"
      if (( failure_delay < OSM_REFRESH_FAILURE_RETRY_MAX_SECONDS )); then
        failure_delay=$((failure_delay * 2))
        (( failure_delay > OSM_REFRESH_FAILURE_RETRY_MAX_SECONDS )) && failure_delay="$OSM_REFRESH_FAILURE_RETRY_MAX_SECONDS"
      fi
    fi
  else
    sleep_for="$OSM_REFRESH_INTERVAL_SECONDS"
    should_refresh_now=true
  fi

  echo "{\"event\":\"osm_refresh_waiting\",\"seconds\":$sleep_for}"
  sleep "$sleep_for"
done
