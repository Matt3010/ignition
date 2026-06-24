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
VALHALLA_TIMEZONE_RELEASE="${VALHALLA_TIMEZONE_RELEASE:-2026b}"
VALHALLA_TIMEZONE_ASSET_NAME="${VALHALLA_TIMEZONE_ASSET_NAME:-timezones-with-oceans.shapefile.zip}"
VALHALLA_TIMEZONE_OFFICIAL_ARCHIVE_URL="https://github.com/evansiroky/timezone-boundary-builder/releases/download/${VALHALLA_TIMEZONE_RELEASE}/${VALHALLA_TIMEZONE_ASSET_NAME}"
VALHALLA_TIMEZONE_ARCHIVE_URL="${VALHALLA_TIMEZONE_ARCHIVE_URL:-$VALHALLA_TIMEZONE_OFFICIAL_ARCHIVE_URL}"
VALHALLA_TIMEZONE_ARCHIVE_SHA256="${VALHALLA_TIMEZONE_ARCHIVE_SHA256:-}"
VALHALLA_TIMEZONE_RELEASE_API_URL="${VALHALLA_TIMEZONE_RELEASE_API_URL:-https://api.github.com/repos/evansiroky/timezone-boundary-builder/releases/tags/${VALHALLA_TIMEZONE_RELEASE}}"

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

resolve_timezone_archive_sha256() {
  if [[ -n "$VALHALLA_TIMEZONE_ARCHIVE_SHA256" ]]; then
    printf '%s\n' "${VALHALLA_TIMEZONE_ARCHIVE_SHA256#sha256:}"
    return 0
  fi

  if [[ "$VALHALLA_TIMEZONE_ARCHIVE_URL" != "$VALHALLA_TIMEZONE_OFFICIAL_ARCHIVE_URL" ]]; then
    echo "VALHALLA_TIMEZONE_ARCHIVE_SHA256 is required when using a custom timezone archive URL" >&2
    return 1
  fi

  command -v node >/dev/null 2>&1 || {
    echo "node is required to verify the official timezone release digest" >&2
    return 1
  }

  local release_json digest
  release_json="$(curl --fail --location --retry 5 --retry-delay 5 --retry-all-errors \
    --header 'Accept: application/vnd.github+json' \
    --header 'X-GitHub-Api-Version: 2022-11-28' \
    "$VALHALLA_TIMEZONE_RELEASE_API_URL")"
  digest="$(printf '%s' "$release_json" | node -e '
    let input = "";
    process.stdin.setEncoding("utf8");
    process.stdin.on("data", chunk => input += chunk);
    process.stdin.on("end", () => {
      const release = JSON.parse(input);
      const assetName = process.argv[1];
      const asset = Array.isArray(release.assets) ? release.assets.find(item => item.name === assetName) : undefined;
      if (!asset || typeof asset.digest !== "string" || !asset.digest.startsWith("sha256:")) process.exit(2);
      process.stdout.write(asset.digest.slice("sha256:".length));
    });
  ' "$VALHALLA_TIMEZONE_ASSET_NAME")" || {
    echo "Unable to resolve the SHA256 digest for ${VALHALLA_TIMEZONE_ASSET_NAME} from release ${VALHALLA_TIMEZONE_RELEASE}" >&2
    return 1
  }
  [[ "$digest" =~ ^[a-fA-F0-9]{64}$ ]] || {
    echo "Invalid SHA256 digest returned for the timezone archive" >&2
    return 1
  }
  printf '%s\n' "${digest,,}"
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
TIMEZONE_SOURCE_FILE="$STATE_DIR/timezones.source"
BUILD_CONTAINER_NAME="ignition-valhalla-build-$$-$RANDOM"
BUILD_CONTAINER_RUNNING=false
PROGRESS_PID=""
TIMEZONE_DATABASE_CHANGED=false
ADMIN_DATABASE_CHANGED=false

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

build_timezone_database() {
  local target="$1" marker="$2"

  for dependency in curl unzip spatialite_tool spatialite sqlite3; do
    command -v "$dependency" >/dev/null 2>&1 || {
      echo "$dependency is required to build the Valhalla timezone database" >&2
      return 1
    }
  done

  local work_dir archive shapefile_base tmp_target expected_sha256 actual_sha256 source_fingerprint
  expected_sha256="$(resolve_timezone_archive_sha256)"
  source_fingerprint="${VALHALLA_TIMEZONE_RELEASE}|${VALHALLA_TIMEZONE_ARCHIVE_URL}|${expected_sha256}"
  if [[ -f "$marker" ]] && validate_sqlite "$target" && [[ -f "$TIMEZONE_SOURCE_FILE" ]] && [[ "$(cat "$TIMEZONE_SOURCE_FILE")" == "$source_fingerprint" ]]; then
    return 0
  fi
  TIMEZONE_DATABASE_CHANGED=true

  work_dir="$(mktemp -d "$VALHALLA_TILE_DIR_ABS/.timezone-build.XXXXXX")"
  archive="$work_dir/$VALHALLA_TIMEZONE_ASSET_NAME"
  shapefile_base="$work_dir/combined-shapefile-with-oceans"
  tmp_target="$target.tmp"
  rm -f "$tmp_target"
  trap 'rm -rf -- "$work_dir"' RETURN

  echo "{\"event\":\"valhalla_support_database_started\",\"database\":\"timezones\",\"release\":\"$VALHALLA_TIMEZONE_RELEASE\"}"
  curl --fail --location --retry 5 --retry-delay 5 --retry-all-errors \
    --output "$archive" "$VALHALLA_TIMEZONE_ARCHIVE_URL"
  actual_sha256="$(sha256sum "$archive" | awk '{print $1}')"
  if [[ "${actual_sha256,,}" != "${expected_sha256,,}" ]]; then
    echo "Timezone archive SHA256 mismatch: expected $expected_sha256, got $actual_sha256" >&2
    return 1
  fi
  echo "{\"event\":\"valhalla_timezone_archive_verified\",\"release\":\"$VALHALLA_TIMEZONE_RELEASE\",\"sha256\":\"${actual_sha256,,}\"}"
  unzip -q "$archive" -d "$work_dir"

  spatialite_tool -i -shp "$shapefile_base" -d "$tmp_target" \
    -t tz_world -s 4326 -g geom -c UTF-8 >/dev/null
  spatialite "$tmp_target" "SELECT CreateSpatialIndex('tz_world', 'geom');" >/dev/null
  spatialite "$tmp_target" "VACUUM;" >/dev/null
  spatialite "$tmp_target" "ANALYZE;" >/dev/null

  validate_sqlite "$tmp_target" || {
    echo "Valhalla timezone database is missing or invalid" >&2
    return 1
  }
  mv -T -- "$tmp_target" "$target"
  printf '%s\n' "$source_fingerprint" > "$TIMEZONE_SOURCE_FILE.tmp"
  mv -T -- "$TIMEZONE_SOURCE_FILE.tmp" "$TIMEZONE_SOURCE_FILE"
  write_marker "$marker"
  echo "{\"event\":\"valhalla_support_database_finished\",\"database\":\"timezones\",\"bytes\":$(json_number "$(stat -c %s "$target" 2>/dev/null || printf 0)")}"
}

build_admin_database() {
  local target="$1" accepted_marker="$2" rejected_marker="$3"
  local quality_file="$STATE_DIR/admins.quality.json"

  if [[ -f "$accepted_marker" ]] && validate_sqlite "$target"; then
    return 0
  fi
  if [[ -f "$rejected_marker" ]] && [[ ! -e "$target" ]]; then
    return 0
  fi

  local had_valid_database=false admin_log="$STATE_DIR/admins-build.log"
  if validate_sqlite "$target"; then
    had_valid_database=true
  fi

  rm -f "$target" "$accepted_marker" "$rejected_marker"
  : > "$admin_log"
  echo '{"event":"valhalla_support_database_started","database":"admins","mode":"automatic"}'

  set +e
  docker run --rm \
    --platform "$VALHALLA_DOCKER_PLATFORM" \
    --entrypoint valhalla_build_admins \
    -v "${OSM_MOUNT_DIR_ABS}:/data/osm" \
    -v "${VALHALLA_MOUNT_DIR_ABS}:/custom_files" \
    "$VALHALLA_DOCKER_IMAGE" \
    -c /custom_files/valhalla.json \
    "${inputs[@]}" 2>&1 | tee "$admin_log"
  local admin_status=${PIPESTATUS[0]}
  set -e

  if (( admin_status != 0 )); then
    echo "Valhalla admin database builder failed with exit code $admin_status" >&2
    return "$admin_status"
  fi

  local missing_members degenerate_relations topology_errors access_insert_errors admin_areas
  missing_members="$(grep -c 'is missing way member' "$admin_log" 2>/dev/null || true)"
  degenerate_relations="$(grep -c 'is degenerate and will be skipped' "$admin_log" 2>/dev/null || true)"
  topology_errors="$(grep -c 'TopologyException' "$admin_log" 2>/dev/null || true)"
  access_insert_errors="$(grep -c 'NOT NULL constraint failed: admin_access.admin_id' "$admin_log" 2>/dev/null || true)"
  admin_areas="0"

  if validate_sqlite "$target"; then
    if sqlite3 -batch -noheader "$target" "SELECT 1 FROM sqlite_master WHERE type='table' AND name='admins';" 2>/dev/null | grep -q '^1$'; then
      admin_areas="$(sqlite3 -batch -noheader "$target" 'SELECT COUNT(*) FROM admins;' 2>/dev/null || printf '0')"
    elif sqlite3 -batch -noheader "$target" "SELECT 1 FROM sqlite_master WHERE type='table' AND name='admin';" 2>/dev/null | grep -q '^1$'; then
      admin_areas="$(sqlite3 -batch -noheader "$target" 'SELECT COUNT(*) FROM admin;' 2>/dev/null || printf '0')"
    fi
  fi
  admin_areas="$(json_number "$admin_areas")"

  local accepted=true reason="quality_checks_passed"
  if ! validate_sqlite "$target"; then
    accepted=false
    reason="invalid_sqlite_database"
  elif (( admin_areas == 0 )); then
    accepted=false
    reason="empty_admin_database"
  elif (( missing_members > 0 || degenerate_relations > 0 || topology_errors > 0 || access_insert_errors > 0 )); then
    accepted=false
    reason="incomplete_regional_extract"
  fi

  if [[ "$accepted" == "true" ]]; then
    write_marker "$accepted_marker"
    rm -f "$rejected_marker"
    ADMIN_DATABASE_CHANGED=true
    printf '{"accepted":true,"reason":"%s","adminAreas":%s,"missingMembers":%s,"degenerateRelations":%s,"topologyErrors":%s,"accessInsertErrors":%s}\n' \
      "$reason" "$admin_areas" "$missing_members" "$degenerate_relations" "$topology_errors" "$access_insert_errors" > "$quality_file"
    echo "{\"event\":\"valhalla_admin_database_accepted\",\"adminAreas\":$admin_areas,\"missingMembers\":$missing_members,\"degenerateRelations\":$degenerate_relations,\"topologyErrors\":$topology_errors,\"accessInsertErrors\":$access_insert_errors,\"bytes\":$(json_number "$(stat -c %s "$target" 2>/dev/null || printf 0)")}" 
    echo "[INFO] Valhalla admin database accepted. Areas=$admin_areas, size=$(json_number "$(stat -c %s "$target" 2>/dev/null || printf 0)") bytes."
    return 0
  fi

  rm -f "$target" "$accepted_marker"
  write_marker "$rejected_marker"
  if [[ "$had_valid_database" == "true" ]]; then
    ADMIN_DATABASE_CHANGED=true
  fi
  printf '{"accepted":false,"reason":"%s","adminAreas":%s,"missingMembers":%s,"degenerateRelations":%s,"topologyErrors":%s,"accessInsertErrors":%s}\n' \
    "$reason" "$admin_areas" "$missing_members" "$degenerate_relations" "$topology_errors" "$access_insert_errors" > "$quality_file"
  echo "{\"event\":\"valhalla_admin_database_rejected\",\"reason\":\"$reason\",\"adminAreas\":$admin_areas,\"missingMembers\":$missing_members,\"degenerateRelations\":$degenerate_relations,\"topologyErrors\":$topology_errors,\"accessInsertErrors\":$access_insert_errors,\"action\":\"continuing_without_admin_database\"}"
  echo "[INFO] Valhalla admin database rejected: the OSM extract is incomplete for reliable administrative metadata. Continuing without admins.sqlite. Areas=$admin_areas, missingMembers=$missing_members, degenerateRelations=$degenerate_relations, topologyErrors=$topology_errors, accessInsertErrors=$access_insert_errors."
}

support_databases_changed=false
build_timezone_database "$TIMEZONE_DB" "$STATE_DIR/timezones.complete"
if [[ "$TIMEZONE_DATABASE_CHANGED" == "true" ]]; then
  support_databases_changed=true
fi
build_admin_database "$ADMIN_DB" "$STATE_DIR/admins.complete" "$STATE_DIR/admins.rejected"
if [[ "$ADMIN_DATABASE_CHANGED" == "true" ]]; then
  support_databases_changed=true
fi

# Admin and timezone data are embedded while graph tiles are built/enhanced.
# If these databases were added to an existing resumable staging directory,
# preserve the expensive parsing/constructedges stage but rebuild downstream
# stages so the resulting tiles actually contain the new metadata.
if [[ "$support_databases_changed" == "true" ]]; then
  rm -f "$STATE_DIR/build.complete" "$STATE_DIR/cleanup.complete"
  if [[ -f "$STATE_DIR/constructedges.complete" ]]; then
    echo '{"event":"valhalla_build_downstream_invalidated","reason":"support_databases_changed","preservedStage":"constructedges"}'
  else
    echo '{"event":"valhalla_build_support_databases_changed","downstreamStagesWillUseUpdatedMetadata":true}'
  fi
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
validate_sqlite "$TIMEZONE_DB" || { echo "Valhalla build completed without a valid timezones.sqlite" >&2; exit 1; }
has_admins=false
if validate_sqlite "$ADMIN_DB" && [[ -f "$STATE_DIR/admins.complete" ]]; then
  has_admins=true
fi

echo "{\"event\":\"valhalla_build_complete\",\"progressPreserved\":true,\"hasAdmins\":$has_admins,\"hasTimezones\":true}"
