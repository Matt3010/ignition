#!/usr/bin/env bash
set -euo pipefail

OSM_REFRESH_INTERVAL_SECONDS="${OSM_REFRESH_INTERVAL_SECONDS:-86400}"
OSM_REFRESH_RUN_ON_START="${OSM_REFRESH_RUN_ON_START:-false}"

run_refresh() {
  if ! npm run osm:refresh; then
    echo "{\"event\":\"osm_refresh_failed\",\"nextRetrySeconds\":$OSM_REFRESH_INTERVAL_SECONDS}" >&2
  fi
}

if [[ "$OSM_REFRESH_RUN_ON_START" == "true" ]]; then
  run_refresh
fi

while true; do
  sleep "$OSM_REFRESH_INTERVAL_SECONDS"
  run_refresh
done
