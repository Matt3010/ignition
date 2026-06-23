#!/usr/bin/env bash
set -euo pipefail

OSM_DATA_DIR="${OSM_DATA_DIR:-./data/osm}"
OSM_HOST_DATA_DIR="${OSM_HOST_DATA_DIR:-}"
OSM_REGIONS="${OSM_REGIONS:-italy}"
VALHALLA_TILE_DIR="${VALHALLA_TILE_DIR:-./data/valhalla}"
VALHALLA_BUILD_HOST_TILE_DIR="${VALHALLA_BUILD_HOST_TILE_DIR:-}"
VALHALLA_DOCKER_IMAGE="${VALHALLA_DOCKER_IMAGE:-ghcr.io/gis-ops/docker-valhalla/valhalla:3.5.1}"
VALHALLA_DOCKER_PLATFORM="${VALHALLA_DOCKER_PLATFORM:-linux/arm64/v8}"
VALHALLA_BUILD_PROGRESS_INTERVAL_SECONDS="${VALHALLA_BUILD_PROGRESS_INTERVAL_SECONDS:-60}"

absolute_path() { case "$1" in /*) printf '%s\n' "$1" ;; *) printf '%s/%s\n' "$(pwd)" "$1" ;; esac; }
trim() { local v="$1"; v="${v#"${v%%[![:space:]]*}"}"; v="${v%"${v##*[![:space:]]}"}"; printf '%s' "$v"; }
json_number() { [[ "$1" =~ ^[0-9]+$ ]] && printf '%s' "$1" || printf '0'; }
validate_sqlite() {
  local database="$1" result
  [[ -s "$database" ]] || return 1
  [[ "$(head -c 15 "$database" 2>/dev/null || true)" == "SQLite format 3" ]] || return 1
  command -v sqlite3 >/dev/null 2>&1 || {
    echo "sqlite3 is required to validate $database" >&2
    return 1
  }
  result="$(sqlite3 -batch -noheader "$database" 'PRAGMA quick_check;' 2>/dev/null || true)"
  [[ "$result" == "ok" ]]
}
write_marker() {
  local target="$1" tmp="${1}.tmp.$$.$RANDOM" attempt
  : > "$tmp"
  for attempt in 1 2 3; do
    rm -rf -- "$target"
    if mv -T -- "$tmp" "$target" 2>/dev/null; then
      return 0
    fi
    sleep 0.05
  done
  rm -f -- "$tmp"
  echo "Failed to write checkpoint marker $target" >&2
  return 1
}

OSM_DATA_DIR_ABS="$(absolute_path "$OSM_DATA_DIR")"
VALHALLA_TILE_DIR_ABS="$(absolute_path "$VALHALLA_TILE_DIR")"
OSM_MOUNT_DIR_ABS="${OSM_HOST_DATA_DIR:-$OSM_DATA_DIR_ABS}"
VALHALLA_MOUNT_DIR_ABS="${VALHALLA_BUILD_HOST_TILE_DIR:-$VALHALLA_TILE_DIR_ABS}"
STATE_DIR="$VALHALLA_TILE_DIR_ABS/.build-state"
FINGERPRINT_FILE="$STATE_DIR/fingerprint"
ADMIN_DB="$VALHALLA_TILE_DIR_ABS/admins.sqlite"
TIMEZONE_DB="$VALHALLA_TILE_DIR_ABS/timezones.sqlite"
BUILD_CONTAINER_NAME="ignition-valhalla-build-$$-$RANDOM"
BUILD_CONTAINER_RUNNING=false
PROGRESS_PID=""

if ! [[ "$VALHALLA_BUILD_PROGRESS_INTERVAL_SECONDS" =~ ^[1-9][0-9]*$ ]]; then
  echo "VALHALLA_BUILD_PROGRESS_INTERVAL_SECONDS must be a positive integer" >&2
  exit 64
fi

IFS=',' read -r -a raw_regions <<< "$OSM_REGIONS"
inputs=()
input_metadata=()
for raw in "${raw_regions[@]}"; do
  region="$(trim "$raw")"; [[ -n "$region" ]] || continue
  pbf="$OSM_DATA_DIR/$region.osm.pbf"
  pbf_abs="$OSM_DATA_DIR_ABS/$region.osm.pbf"
  [[ -f "$pbf_abs" ]] || { echo "Missing $pbf. Run npm run osm:download first." >&2; exit 1; }
  inputs+=("/data/osm/$region.osm.pbf")
  input_metadata+=("$region:$(stat -c '%s:%Y' "$pbf_abs")")
done
[[ ${#inputs[@]} -gt 0 ]] || { echo "No OSM regions configured" >&2; exit 64; }

mkdir -p "$VALHALLA_TILE_DIR_ABS/valhalla_tiles" "$STATE_DIR"
chmod 0777 "$VALHALLA_TILE_DIR_ABS" "$VALHALLA_TILE_DIR_ABS/valhalla_tiles"
cp docker/valhalla/valhalla.json "$VALHALLA_TILE_DIR_ABS/valhalla.json"

fingerprint_payload="$VALHALLA_DOCKER_IMAGE|$VALHALLA_DOCKER_PLATFORM|$(sha256sum docker/valhalla/valhalla.json | awk '{print $1}')|${input_metadata[*]}"
current_fingerprint="$(printf '%s' "$fingerprint_payload" | sha256sum | awk '{print $1}')"

clear_staging_for_new_inputs() {
  echo '{"event":"valhalla_build_staging_reset","reason":"inputs_changed"}' >&2
  find "$VALHALLA_TILE_DIR_ABS" -mindepth 1 -maxdepth 1 ! -name valhalla.json -exec rm -rf -- {} +
  mkdir -p "$VALHALLA_TILE_DIR_ABS/valhalla_tiles" "$STATE_DIR"
}

if [[ -f "$FINGERPRINT_FILE" ]]; then
  previous_fingerprint="$(cat "$FINGERPRINT_FILE")"
  if [[ "$previous_fingerprint" != "$current_fingerprint" ]]; then
    clear_staging_for_new_inputs
  fi
fi
printf '%s\n' "$current_fingerprint" > "$FINGERPRINT_FILE.tmp"
mv "$FINGERPRINT_FILE.tmp" "$FINGERPRINT_FILE"

if [[ ! -f "$STATE_DIR/constructedges.complete" ]] && \
   find "$VALHALLA_TILE_DIR_ABS/valhalla_tiles" -type f -name '*.gph' -print -quit | grep -q .; then
  touch "$STATE_DIR/constructedges.complete"
  echo '{"event":"valhalla_build_legacy_progress_detected","resumeFrom":"build"}'
fi

stop_progress_monitor() {
  if [[ -n "$PROGRESS_PID" ]]; then
    kill "$PROGRESS_PID" >/dev/null 2>&1 || true
    wait "$PROGRESS_PID" >/dev/null 2>&1 || true
    PROGRESS_PID=""
  fi
}

stop_build_container() {
  stop_progress_monitor
  if [[ "$BUILD_CONTAINER_RUNNING" == "true" ]]; then
    docker stop -t 30 "$BUILD_CONTAINER_NAME" >/dev/null 2>&1 || true
    docker rm -f "$BUILD_CONTAINER_NAME" >/dev/null 2>&1 || true
    BUILD_CONTAINER_RUNNING=false
  fi
}

on_interrupt() {
  echo '{"event":"valhalla_build_interrupted","progressPreserved":true}' >&2
  stop_build_container
  exit 143
}
trap on_interrupt INT TERM
trap stop_build_container EXIT

build_support_database() {
  local kind="$1" target="$2" marker="$3" entrypoint="$4"
  [[ -f "$marker" ]] && validate_sqlite "$target" && return 0

  local tmp_target="$target.tmp"
  rm -f "$tmp_target"
  echo "{\"event\":\"valhalla_support_database_started\",\"database\":\"$kind\"}"

  if [[ "$kind" == "timezones" ]]; then
    docker run --rm \
      --platform "$VALHALLA_DOCKER_PLATFORM" \
      --entrypoint "$entrypoint" \
      "$VALHALLA_DOCKER_IMAGE" > "$tmp_target"
  else
    rm -f "$target"
    docker run --rm \
      --platform "$VALHALLA_DOCKER_PLATFORM" \
      --entrypoint "$entrypoint" \
      -v "${OSM_MOUNT_DIR_ABS}:/data/osm" \
      -v "${VALHALLA_MOUNT_DIR_ABS}:/custom_files" \
      "$VALHALLA_DOCKER_IMAGE" \
      -c /custom_files/valhalla.json \
      "${inputs[@]}"
    validate_sqlite "$target" || { echo "Valhalla $kind database is missing or invalid" >&2; exit 1; }
  fi

  if [[ "$kind" == "timezones" ]]; then
    validate_sqlite "$tmp_target" || { echo "Valhalla $kind database is missing or invalid" >&2; exit 1; }
    mv "$tmp_target" "$target"
  fi
  write_marker "$marker"
  echo "{\"event\":\"valhalla_support_database_finished\",\"database\":\"$kind\",\"bytes\":$(json_number "$(stat -c %s "$target" 2>/dev/null || printf 0)")}"
}

support_databases_changed=false
if [[ ! -f "$STATE_DIR/timezones.complete" ]] || ! validate_sqlite "$TIMEZONE_DB"; then
  build_support_database timezones "$TIMEZONE_DB" "$STATE_DIR/timezones.complete" valhalla_build_timezones
  support_databases_changed=true
fi
if [[ ! -f "$STATE_DIR/admins.complete" ]] || ! validate_sqlite "$ADMIN_DB"; then
  build_support_database admins "$ADMIN_DB" "$STATE_DIR/admins.complete" valhalla_build_admins
  support_databases_changed=true
fi

# Admin and timezone data are embedded while graph tiles are built/enhanced.
# If these databases were added to an existing resumable staging directory,
# preserve the expensive parsing/constructedges stage but rebuild downstream
# stages so the resulting tiles actually contain the new metadata.
if [[ "$support_databases_changed" == "true" ]]; then
  rm -f "$STATE_DIR/build.complete" "$STATE_DIR/cleanup.complete"
  echo '{"event":"valhalla_build_downstream_invalidated","reason":"support_databases_changed","preservedStage":"constructedges"}'
fi

start_progress_monitor() {
  local start_stage="$1" end_stage="$2" started_at="$3"
  (
    sleep_pid=""
    trap 'if [[ -n "$sleep_pid" ]]; then kill "$sleep_pid" >/dev/null 2>&1 || true; fi; exit 0' TERM INT
    while true; do
      sleep "$VALHALLA_BUILD_PROGRESS_INTERVAL_SECONDS" &
      sleep_pid=$!
      wait "$sleep_pid" || exit 0
      sleep_pid=""
      local_now="$(date +%s)"
      elapsed=$(( local_now - started_at ))
      bytes="$(du -sb "$VALHALLA_TILE_DIR_ABS" 2>/dev/null | awk '{print $1}')"
      files="$(find "$VALHALLA_TILE_DIR_ABS" -type f 2>/dev/null | wc -l | tr -d ' ')"
      graph_tiles="$(find "$VALHALLA_TILE_DIR_ABS/valhalla_tiles" -type f -name '*.gph' 2>/dev/null | wc -l | tr -d ' ')"
      manifest_tiles="$(sed -nE 's/.*Reading ([0-9]+) tiles.*/\1/p' "$STATE_DIR/current-stage.log" 2>/dev/null | tail -1)"
      manifest_tiles="${manifest_tiles:-0}"
      echo "{\"event\":\"valhalla_build_progress\",\"start\":\"$start_stage\",\"end\":\"$end_stage\",\"elapsedSeconds\":$elapsed,\"stagingBytes\":$(json_number "${bytes:-0}"),\"files\":$(json_number "$files"),\"graphTiles\":$(json_number "$graph_tiles"),\"manifestTiles\":$(json_number "$manifest_tiles")}"
    done
  ) &
  PROGRESS_PID=$!
}

emit_warning_summary() {
  local log_file="$1" start_stage="$2" end_stage="$3"
  local invalid_levels ferry_failures missing_admin missing_timezone invalid_conditions
  invalid_levels="$(grep -c 'Invalid level:' "$log_file" 2>/dev/null || true)"
  ferry_failures="$(grep -c 'Reclassification fails .*ferry' "$log_file" 2>/dev/null || true)"
  missing_admin="$(grep -c 'Admin db .* not found' "$log_file" 2>/dev/null || true)"
  missing_timezone="$(grep -c 'Time zone db .* not found' "$log_file" 2>/dev/null || true)"
  invalid_conditions="$(grep -c 'invalid_argument thrown for condition' "$log_file" 2>/dev/null || true)"
  echo "{\"event\":\"valhalla_build_warning_summary\",\"start\":\"$start_stage\",\"end\":\"$end_stage\",\"invalidLevels\":$(json_number "$invalid_levels"),\"ferryReclassificationFailures\":$(json_number "$ferry_failures"),\"missingAdminDatabaseWarnings\":$(json_number "$missing_admin"),\"missingTimezoneDatabaseWarnings\":$(json_number "$missing_timezone"),\"invalidConditionalValues\":$(json_number "$invalid_conditions")}"
}

run_stage() {
  local start_stage="$1" end_stage="$2" marker="$3"
  local stage_log="$STATE_DIR/current-stage.log"
  : > "$stage_log"
  echo "{\"event\":\"valhalla_build_stage_started\",\"start\":\"$start_stage\",\"end\":\"$end_stage\"}"
  BUILD_CONTAINER_RUNNING=true
  start_progress_monitor "$start_stage" "$end_stage" "$(date +%s)"
  set +e
  docker run --rm \
    --name "$BUILD_CONTAINER_NAME" \
    --platform "$VALHALLA_DOCKER_PLATFORM" \
    --entrypoint valhalla_build_tiles \
    -v "${OSM_MOUNT_DIR_ABS}:/data/osm" \
    -v "${VALHALLA_MOUNT_DIR_ABS}:/custom_files" \
    "$VALHALLA_DOCKER_IMAGE" \
    -c /custom_files/valhalla.json \
    -s "$start_stage" -e "$end_stage" \
    "${inputs[@]}" 2>&1 | tee "$stage_log"
  stage_status=${PIPESTATUS[0]}
  set -e
  stop_progress_monitor
  BUILD_CONTAINER_RUNNING=false
  emit_warning_summary "$stage_log" "$start_stage" "$end_stage"
  if (( stage_status != 0 )); then
    echo "{\"event\":\"valhalla_build_stage_failed\",\"start\":\"$start_stage\",\"end\":\"$end_stage\",\"exitCode\":$stage_status}" >&2
    return "$stage_status"
  fi
  write_marker "$STATE_DIR/$marker"
  echo "{\"event\":\"valhalla_build_stage_finished\",\"start\":\"$start_stage\",\"end\":\"$end_stage\"}"
}

if [[ ! -f "$STATE_DIR/constructedges.complete" ]]; then
  run_stage initialize constructedges constructedges.complete
fi
if [[ ! -f "$STATE_DIR/build.complete" ]]; then
  run_stage build build build.complete
fi
if [[ ! -f "$STATE_DIR/cleanup.complete" ]]; then
  run_stage enhance cleanup cleanup.complete
fi

if ! find "$VALHALLA_TILE_DIR_ABS/valhalla_tiles" -type f -name '*.gph' -print -quit | grep -q .; then
  echo "Valhalla build completed without graph tiles" >&2
  exit 1
fi
validate_sqlite "$ADMIN_DB" || { echo "Valhalla build completed without a valid admins.sqlite" >&2; exit 1; }
validate_sqlite "$TIMEZONE_DB" || { echo "Valhalla build completed without a valid timezones.sqlite" >&2; exit 1; }

echo '{"event":"valhalla_build_complete","progressPreserved":true,"hasAdmins":true,"hasTimezones":true}'
