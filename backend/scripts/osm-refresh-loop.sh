#!/usr/bin/env bash
set -euo pipefail

OSM_REFRESH_INTERVAL_SECONDS="${OSM_REFRESH_INTERVAL_SECONDS:-432000}"
OSM_REFRESH_RUN_ON_START="${OSM_REFRESH_RUN_ON_START:-false}"
OSM_REFRESH_FAILURE_RETRY_INITIAL_SECONDS="${OSM_REFRESH_FAILURE_RETRY_INITIAL_SECONDS:-300}"
OSM_REFRESH_FAILURE_RETRY_MAX_SECONDS="${OSM_REFRESH_FAILURE_RETRY_MAX_SECONDS:-3600}"
OSM_REFRESH_INTEGRITY_CHECK_INTERVAL_SECONDS="${OSM_REFRESH_INTEGRITY_CHECK_INTERVAL_SECONDS:-${OSM_ALERT_HEALTHCHECK_INTERVAL_SECONDS:-300}}"
OSM_REFRESH_SOURCE_REPAIR_DELAY_SECONDS="${OSM_REFRESH_SOURCE_REPAIR_DELAY_SECONDS:-3600}"
OSM_REFRESH_LOG_ENABLED="${OSM_REFRESH_LOG_ENABLED:-true}"
OSM_REFRESH_LOG_DIR="${OSM_REFRESH_LOG_DIR:-./reports/osm-refresh}"
OSM_REFRESH_LOG_FILE="${OSM_REFRESH_LOG_FILE:-$OSM_REFRESH_LOG_DIR/osm-refresh.log}"
OSM_REFRESH_LOG_MAX_BYTES="${OSM_REFRESH_LOG_MAX_BYTES:-10000000}"
OSM_REFRESH_LOG_MAX_FILES="${OSM_REFRESH_LOG_MAX_FILES:-5}"
VALHALLA_TILE_DIR="${VALHALLA_TILE_DIR:-./data/valhalla}"

rotate_log_file() {
  local file="$1" max_bytes="$2" max_files="$3"
  [[ -f "$file" ]] || return 0
  [[ "$max_bytes" =~ ^[0-9]+$ && "$max_files" =~ ^[0-9]+$ ]] || return 0
  (( max_bytes > 0 && max_files > 0 )) || return 0

  local bytes
  bytes="$(wc -c < "$file" | tr -d '[:space:]')"
  [[ "$bytes" =~ ^[0-9]+$ ]] || return 0
  (( bytes >= max_bytes )) || return 0

  local index
  for (( index=max_files - 1; index >= 1; index-- )); do
    if [[ -f "$file.$index" ]]; then
      mv "$file.$index" "$file.$((index + 1))" || return 1
    fi
  done
  mv "$file" "$file.1" || return 1
}

setup_file_logging() {
  [[ "$OSM_REFRESH_LOG_ENABLED" == "true" ]] || return 0
  local log_dir
  log_dir="$(dirname "$OSM_REFRESH_LOG_FILE")"
  if ! mkdir -p "$log_dir"; then
    echo "{\"event\":\"osm_refresh_file_logging_unavailable\",\"reason\":\"mkdir_failed\",\"path\":\"$OSM_REFRESH_LOG_FILE\"}" >&2
    return 0
  fi
  if ! touch "$OSM_REFRESH_LOG_FILE"; then
    echo "{\"event\":\"osm_refresh_file_logging_unavailable\",\"reason\":\"touch_failed\",\"path\":\"$OSM_REFRESH_LOG_FILE\"}" >&2
    return 0
  fi
  if ! rotate_log_file "$OSM_REFRESH_LOG_FILE" "$OSM_REFRESH_LOG_MAX_BYTES" "$OSM_REFRESH_LOG_MAX_FILES"; then
    echo "{\"event\":\"osm_refresh_file_logging_unavailable\",\"reason\":\"rotation_failed\",\"path\":\"$OSM_REFRESH_LOG_FILE\"}" >&2
    return 0
  fi
  exec > >(tee -a "$OSM_REFRESH_LOG_FILE") 2> >(tee -a "$OSM_REFRESH_LOG_FILE" >&2)
  echo "{\"event\":\"osm_refresh_file_logging_enabled\",\"path\":\"$OSM_REFRESH_LOG_FILE\",\"maxBytes\":$OSM_REFRESH_LOG_MAX_BYTES,\"maxFiles\":$OSM_REFRESH_LOG_MAX_FILES}"
}

setup_file_logging

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
  sleep_for="$OSM_REFRESH_INTEGRITY_CHECK_INTERVAL_SECONDS"
  (( until_refresh < sleep_for )) && sleep_for="$until_refresh"
  echo "{\"event\":\"osm_refresh_waiting\",\"seconds\":$sleep_for,\"nextRefreshInSeconds\":$until_refresh}"
  sleep "$sleep_for"
done
