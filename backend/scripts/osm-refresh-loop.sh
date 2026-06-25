#!/usr/bin/env bash
set -euo pipefail

OSM_REFRESH_INTERVAL_SECONDS="${OSM_REFRESH_INTERVAL_SECONDS:-432000}"
OSM_REFRESH_RUN_ON_START="${OSM_REFRESH_RUN_ON_START:-false}"
OSM_REFRESH_FAILURE_RETRY_INITIAL_SECONDS="${OSM_REFRESH_FAILURE_RETRY_INITIAL_SECONDS:-300}"
OSM_REFRESH_FAILURE_RETRY_MAX_SECONDS="${OSM_REFRESH_FAILURE_RETRY_MAX_SECONDS:-3600}"
OSM_ALERT_HEALTHCHECK_INTERVAL_SECONDS="${OSM_ALERT_HEALTHCHECK_INTERVAL_SECONDS:-300}"
OSM_REFRESH_SOURCE_REPAIR_DELAY_SECONDS="${OSM_REFRESH_SOURCE_REPAIR_DELAY_SECONDS:-3600}"
VALHALLA_TILE_DIR="${VALHALLA_TILE_DIR:-./data/valhalla}"

failure_delay="$OSM_REFRESH_FAILURE_RETRY_INITIAL_SECONDS"
next_refresh_at=0

run_refresh() {
  if npm run osm:refresh; then
    failure_delay="$OSM_REFRESH_FAILURE_RETRY_INITIAL_SECONDS"
    next_refresh_at=$(( $(date +%s) + OSM_REFRESH_INTERVAL_SECONDS ))
    return 0
  fi
  echo "{\"event\":\"osm_refresh_failed\",\"nextRetrySeconds\":$failure_delay}" >&2
  next_refresh_at=$(( $(date +%s) + failure_delay ))
  if (( failure_delay < OSM_REFRESH_FAILURE_RETRY_MAX_SECONDS )); then
    failure_delay=$((failure_delay * 2))
    (( failure_delay > OSM_REFRESH_FAILURE_RETRY_MAX_SECONDS )) && failure_delay="$OSM_REFRESH_FAILURE_RETRY_MAX_SECONDS"
  fi
  return 1
}

tiles_are_missing() {
  [[ ! -f "$VALHALLA_TILE_DIR/valhalla.json" || ! -d "$VALHALLA_TILE_DIR/valhalla_tiles" ]]
}

run_alert_integrity_check() {
  local status
  if npm run alerts:ensure; then
    return 0
  else
    status=$?
  fi
  if [[ "$status" -eq 2 ]]; then
    echo '{"event":"osm_alert_sources_missing","action":"schedule_full_refresh"}' >&2
    next_refresh_at=0
  elif [[ "$status" -eq 5 ]]; then
    echo "{\"event\":\"osm_alert_sources_missing\",\"action\":\"schedule_source_repair\",\"nextRefreshSeconds\":$OSM_REFRESH_SOURCE_REPAIR_DELAY_SECONDS}" >&2
    local repair_at=$(( $(date +%s) + OSM_REFRESH_SOURCE_REPAIR_DELAY_SECONDS ))
    if (( repair_at < next_refresh_at )); then
      next_refresh_at="$repair_at"
    fi
  else
    echo "{\"event\":\"osm_alert_integrity_check_failed\",\"exitCode\":$status}" >&2
  fi
  return "$status"
}

now="$(date +%s)"
if [[ "$OSM_REFRESH_RUN_ON_START" == "true" ]] || tiles_are_missing; then
  next_refresh_at=0
else
  next_refresh_at=$(( now + OSM_REFRESH_INTERVAL_SECONDS ))
fi

# Always verify the independent alert subsystem at startup. A valid local
# alert extract is imported immediately without rebuilding Valhalla.
run_alert_integrity_check || true

while true; do
  now="$(date +%s)"
  if (( now >= next_refresh_at )); then
    run_refresh || true
  fi

  run_alert_integrity_check || true

  now="$(date +%s)"
  until_refresh=$(( next_refresh_at - now ))
  (( until_refresh < 1 )) && until_refresh=1
  sleep_for="$OSM_ALERT_HEALTHCHECK_INTERVAL_SECONDS"
  (( until_refresh < sleep_for )) && sleep_for="$until_refresh"
  echo "{\"event\":\"osm_refresh_waiting\",\"seconds\":$sleep_for,\"nextRefreshInSeconds\":$until_refresh}"
  sleep "$sleep_for"
done
